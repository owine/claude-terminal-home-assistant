'use strict';

// The fixture and helpers the files-download-*.test.js suites share. Required,
// it builds a temporary tree, `config/` standing in for /config and `data/`
// beside it for /data, and removes it when the suite that required it ends.
// npm test runs each suite in a process of its own, so each gets its own tree.

const { after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const express = require('express');
const yauzl = require('yauzl');
const { createFilesApi } = require('../files-api.js');
const { createDownloads, createDownloadRouter } = require('../files-download.js');
const { createRateLimiter } = require('../http-guards.js');

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'files-download-')));
const root = path.join(base, 'config');
const outside = path.join(base, 'data');
after(() => fs.rmSync(base, { recursive: true, force: true }));

function write(rel, content = 'x', at = root) {
    const full = path.join(at, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
}

const LARGE = 'x'.repeat(4096);
write('configuration.yaml', 'homeassistant:\n');
write('with space.yaml', 'a: 1\n');
write('ünïcödé ✂.yaml', 'u: 1\n');
write('empty.txt', '');
write('image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]));
write('.env', 'TOKEN=1\n');
write('.storage/auth', '{"refresh_tokens": []}\n');
write('.git/config', '[remote]\n');
write('blueprints/automation/motion.yaml', 'blueprint: motion\n');
write('blueprints/automation/.env', 'TOKEN=2\n');                    // sensitive file
write('blueprints/automation/.ctp-upload-0a1b2c.part', 'partial');   // in-flight upload
write('blueprints/.ssh/id_rsa', 'KEY\n');                            // sensitive folder
write('blueprints/repo.git/HEAD', 'ref: x\n');                       // never shown
write('blueprints/notes/readme.md', '# notes\n');
write('blueprints/.gitignore', '*.bak\n');                           // ordinary dotfile
write('blueprints/large.yaml', LARGE);
write('blueprints/empty.yaml', '');
write('secret.txt', 'OUTSIDE\n', outside);
fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'blueprints', 'escape.txt'));
fs.symlinkSync(path.join(root, 'configuration.yaml'), path.join(root, 'blueprints', 'inside-link.yaml'));
fs.symlinkSync(path.join(root, 'blueprints', 'notes'), path.join(root, 'blueprints', 'notes-link'));
fs.symlinkSync(path.join(root, '.env'), path.join(root, 'innocent.yaml'));

const BLUEPRINT_NAMES = [
    'blueprints/.gitignore',
    'blueprints/automation/motion.yaml',
    'blueprints/empty.yaml',
    'blueprints/large.yaml',
    'blueprints/notes/readme.md',
];

const api = createFilesApi({ root });
const downloads = createDownloads({ api });

async function refused(promise, status) {
    await assert.rejects(promise, (err) => {
        assert.strictEqual(err.status, status, `status ${err.status}: ${err.message}`);
        return true;
    });
}

const names = (plan) => plan.files.map((f) => f.name).sort();

async function withServer({ escapes = [], ...options }, fn) {
    const app = express();
    app.use('/api/files', createDownloadRouter({
        downloads,
        fileLimiter: createRateLimiter({ max: 1000 }),
        zipLimiter: createRateLimiter({ max: 1000 }),
        log: () => {},
        ...options,
    }));
    // Express 5 routes an async handler's rejection here, not to the process:
    // anything that lands here escaped the route.
    app.use((err, req, res, next) => {
        escapes.push(err);
        next(err);
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        await fn(`http://127.0.0.1:${server.address().port}/api/files`);
    } finally {
        // Aborted transfers can leave keep-alive sockets behind.
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
    }
}

const q = (p) => encodeURIComponent(p);

// Reads a response that is expected to be cut off. Resolves to true when the
// transfer failed, as an aborted download must.
async function aborted(responsePromise) {
    try {
        const res = await responsePromise;
        await res.arrayBuffer();
        return false;
    } catch {
        return true;
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Descriptors this process holds on a file, counted by inode: independent of
// how the code under test opens or closes it, so a leak cannot hide behind a
// wrapped function. (A handle closed late by the garbage collector would
// still show here until it ran.)
function openFds(ino) {
    const dir = fs.existsSync('/proc/self/fd') ? '/proc/self/fd' : '/dev/fd';
    return fs.readdirSync(dir).filter((fd) => {
        try {
            return fs.fstatSync(Number(fd)).ino === ino;
        } catch {
            return false;
        }
    }).length;
}

// Poll until predicate holds, or ms pass. One evaluation per pass, and its
// result is the answer: evaluating it again on the way out could disagree with
// the pass that ended the loop (a value that flickers), which failed a test on
// CI. performance.now(): a monotonic clock, unlike Date.now().
async function until(predicate, ms = 3000) {
    const end = performance.now() + ms;
    for (;;) {
        if (predicate()) return true;
        if (performance.now() >= end) return false;
        await sleep(20);
    }
}

function rawRequest(port, target, method = 'GET') {
    return new Promise((resolve) => {
        const sock = net.connect(port, '127.0.0.1', () => {
            sock.write(`${method} ${target} HTTP/1.1\r\nHost: x\r\n\r\n`);
            resolve(sock);
        });
    });
}

// { fileName: Buffer } in archive order; with `meta`, also { fileName: yauzl
// Entry } as the second element.
function unzip(buffer, { meta = null } = {}) {
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
            if (err) return reject(err);
            const entries = {};
            zipfile.on('error', reject);
            zipfile.on('end', () => resolve(entries));
            zipfile.on('entry', (entry) => {
                zipfile.openReadStream(entry, (e, stream) => {
                    if (e) return reject(e);
                    const chunks = [];
                    stream.on('data', (c) => chunks.push(c));
                    stream.on('error', reject);
                    stream.on('end', () => {
                        entries[entry.fileName] = Buffer.concat(chunks);
                        if (meta) meta[entry.fileName] = entry;
                        zipfile.readEntry();
                    });
                });
            });
            zipfile.readEntry();
        });
    });
}

// Errors that left the route by any way the server cannot see: thrown in a
// stream or emitter callback, or rejected in a promise nobody awaits. Either
// would restart the wrapper and drop every terminal session.
// A test signal that never comes fails the test instead of hanging the run.
async function within(promise, what, ms = 5000) {
    // A cleared timer, so a long limit cannot hold the run open once met.
    let timer;
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new assert.AssertionError({ message: `timed out waiting: ${what}` })), ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

async function noStrays(fn) {
    const stray = [];
    const onStray = (err) => stray.push(err);
    process.on('uncaughtException', onStray);
    process.on('unhandledRejection', onStray);
    try {
        await fn();
        await sleep(100);   // let a late emit land inside the window
    } finally {
        process.off('uncaughtException', onStray);
        process.off('unhandledRejection', onStray);
    }
    assert.deepStrictEqual(stray.map(String), []);
}

module.exports = {
    root, outside, write, LARGE, BLUEPRINT_NAMES, api, downloads,
    refused, names, withServer, q, aborted, sleep, openFds, until, rawRequest,
    unzip, within, noStrays,
};
