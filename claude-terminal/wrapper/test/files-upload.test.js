'use strict';

// Files sidebar uploads (files-upload.js): names, destinations and their
// tiers, collisions, the write through a .part and its record, the size cap,
// and every way an upload can end early, each of which must leave neither a
// file nor a part behind, nor an error escaping the route.
//
// Fixture: a temporary tree with `config/` standing in for /config, `data/`
// beside it standing in for /data (where the part record lives), and
// `outside/` for a symlink target out of the root.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const express = require('express');
const { createFilesApi } = require('../files-api.js');
const { createRateLimiter } = require('../http-guards.js');
const { createPartRecord } = require('../upload-parts.js');
const {
    createUploads,
    createUploadRouter,
    sanitizeUploadName,
    withSuffix,
    uploadMaxBytes,
    uploadRequestTimeoutMs,
} = require('../files-upload.js');

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-')));
const root = path.join(base, 'config');
const data = path.join(base, 'data');
const outside = path.join(base, 'outside');
after(() => fs.rmSync(base, { recursive: true, force: true }));

function write(rel, content = 'x', at = root) {
    const full = path.join(at, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
}

write('blueprints/automation/motion.yaml', 'old motion\n');
write('secrets.yaml', 'api: 1\n');
write('.storage/auth', '{}\n');
write('claude-config/x', 'x');
write('deps/lib/x.py', 'x');
write('.git/HEAD', 'ref\n');
write('nested/claude-config/keep.txt', 'ordinary\n');
write('target.txt', 'outside\n', outside);
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'upload-parts'), '[]\n');
fs.symlinkSync(path.join(root, 'blueprints'), path.join(root, 'bp-link'));
fs.symlinkSync(outside, path.join(root, 'out-link'));

const api = createFilesApi({ root });
const recordFile = path.join(data, 'upload-parts');
const record = createPartRecord({ file: recordFile, root, log: () => {} });
const uploads = createUploads({ api, record });

// --- names ---

test('a name keeps its last segment, without control characters or leading dots', () => {
    assert.strictEqual(sanitizeUploadName('../../etc/passwd'), 'passwd');
    assert.strictEqual(sanitizeUploadName('a\\b\\c.txt'), 'c.txt');
    assert.strictEqual(sanitizeUploadName('/abs/x.yaml/..'), 'x.yaml');
    assert.strictEqual(sanitizeUploadName('new\nline\x1b[31m\x7f\u0085.txt'), 'newline[31m.txt');
    assert.strictEqual(sanitizeUploadName('.env'), 'env');
    assert.strictEqual(sanitizeUploadName('...hidden'), 'hidden');
    // dots and spaces mixed at the start go together: none of these may come
    // back as a dotfile, nor as the wrapper's own hidden part file
    assert.strictEqual(sanitizeUploadName('. .env'), 'env');
    assert.strictEqual(sanitizeUploadName(' . .bashrc'), 'bashrc');
    assert.strictEqual(sanitizeUploadName('. .ctp-upload-0011223344556677.part'), 'ctp-upload-0011223344556677.part');
    assert.strictEqual(sanitizeUploadName('.\t.x'), 'x');
    assert.strictEqual(sanitizeUploadName('  spaced name.txt  '), 'spaced name.txt');
    assert.strictEqual(sanitizeUploadName('with space $(x) \'q\'.yaml'), 'with space $(x) \'q\'.yaml');
});

test('a name loses its bidirectional controls, so it reads as what it is', () => {
    // U+202E (right-to-left override) shows 'photo<U+202E>gpj.exe' as 'photoexe.jpg'
    assert.strictEqual(sanitizeUploadName('photo\u202egpj.exe'), 'photogpj.exe');
    for (const ch of ['\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',
        '\u2066', '\u2067', '\u2068', '\u2069', '\ufeff']) {
        assert.strictEqual(sanitizeUploadName(`a${ch}b.txt`), 'ab.txt', `U+${ch.codePointAt(0).toString(16)}`);
    }
    assert.strictEqual(sanitizeUploadName('\u202e.env'), 'env');
    // positive control: other characters outside ASCII stay
    assert.strictEqual(sanitizeUploadName('caf\u00e9 \u65e5\u672c \u05e9\u05dc\u05d5\u05dd.txt'), 'caf\u00e9 \u65e5\u672c \u05e9\u05dc\u05d5\u05dd.txt');
});

test('a name left empty becomes upload-<timestamp>', () => {
    for (const raw of ['', '...', '/', ' . ', '\x00\x01', '../..']) {
        assert.strictEqual(sanitizeUploadName(raw, { now: () => 1700000000000 }), 'upload-1700000000000', JSON.stringify(raw));
    }
});

test('a long name is cut to 200 bytes, keeping its extension and whole characters', () => {
    const cut = sanitizeUploadName('é'.repeat(300) + '.yaml');
    assert.ok(Buffer.byteLength(cut) <= 200, String(Buffer.byteLength(cut)));
    assert.ok(cut.endsWith('é.yaml'), cut.slice(-10));
    assert.strictEqual(sanitizeUploadName('a'.repeat(300)).length, 200);
    // an "extension" too long to be one is cut like the rest
    assert.strictEqual(Buffer.byteLength(sanitizeUploadName('a.' + 'b'.repeat(300))), 200);
});

test('secret-shaped names are allowed: certificates belong in /config', () => {
    for (const name of ['server.pem', 'privkey.key', 'secrets.yaml', 'id_rsa', 'service_account.json']) {
        assert.strictEqual(sanitizeUploadName(name), name);
    }
});

test('the request timeout fits a file at the cap through 128 kbit/s, and is never under 30 minutes', () => {
    const MB = 1024 * 1024;
    assert.strictEqual(uploadRequestTimeoutMs(25 * MB), 30 * 60 * 1000);   // 25 MB takes 27.3 min
    assert.strictEqual(uploadRequestTimeoutMs(1 * MB), 30 * 60 * 1000);
    assert.strictEqual(uploadRequestTimeoutMs(100 * MB), 6554 * 1000);     // 104857600 B / 16000 B/s
    assert.ok(uploadRequestTimeoutMs(500 * MB) > 9 * 3600 * 1000);
});

test('the request timeout is never over 12 hours, however big the cap', () => {
    const MB = 1024 * 1024;
    const H12 = 12 * 3600 * 1000;
    assert.strictEqual(uploadRequestTimeoutMs(9999999 * MB), H12);   // the largest UPLOAD_MAX_MB taken
    assert.strictEqual(uploadRequestTimeoutMs(1000 * MB), H12);      // 18.2 h at 128 kbit/s
    // positive control: a cap just under the ceiling keeps its own time
    assert.strictEqual(uploadRequestTimeoutMs(659 * MB), 43189 * 1000);
});

test('withSuffix numbers before the last extension', () => {
    assert.strictEqual(withSuffix('a b.txt', 1), 'a b (1).txt');
    assert.strictEqual(withSuffix('archive.tar.gz', 2), 'archive.tar (2).gz');
    assert.strictEqual(withSuffix('README', 3), 'README (3)');
});

test('UPLOAD_MAX_MB: a positive whole number of megabytes, else 25', () => {
    assert.strictEqual(uploadMaxBytes('50'), 50 * 1024 * 1024);
    assert.strictEqual(uploadMaxBytes(' 1 '), 1024 * 1024);
    for (const bad of [undefined, '', 'null', '0', '-5', '1.5', '25MB', '00', '99999999']) {
        assert.strictEqual(uploadMaxBytes(bad), 25 * 1024 * 1024, JSON.stringify(bad));
    }
});

// --- destinations ---

async function refused(promise, status, reason) {
    await assert.rejects(promise, (err) => {
        assert.strictEqual(err.status, status, `status ${err.status}: ${err.message}`);
        if (reason) assert.strictEqual(err.details?.reason, reason);
        return true;
    });
}

test('a destination must be inside the root, never .git, protected or deps', async () => {
    await refused(uploads.plan({ name: 'a.txt', dest: '.git' }), 404);
    await refused(uploads.plan({ name: 'a.txt', dest: 'blueprints/x.git' }), 404);
    await refused(uploads.plan({ name: 'a.txt', dest: '../outside' }), 404);
    await refused(uploads.plan({ name: 'a.txt', dest: outside }), 404);
    await refused(uploads.plan({ name: 'a.txt', dest: '.storage' }), 403);
    await refused(uploads.plan({ name: 'a.txt', dest: '.storage/sub' }), 403);
    await refused(uploads.plan({ name: 'a.txt', dest: 'claude-config' }), 403);
    await refused(uploads.plan({ name: 'a.txt', dest: 'deps' }), 403);
    await refused(uploads.plan({ name: 'a.txt', dest: 'deps/lib' }), 403);
    await refused(uploads.plan({ name: 'a.txt', dest: 'DEPS' }), 403);
    await refused(uploads.plan({ name: 'a.txt', dest: 'nope' }), 404);
    // Positive controls: ordinary folders, the root itself, and a nested
    // claude-config (protected at the root only, as classifyRelative says).
    assert.strictEqual((await uploads.plan({ name: 'a.txt', dest: 'blueprints/automation' })).dir, path.join(root, 'blueprints', 'automation'));
    assert.strictEqual((await uploads.plan({ name: 'a.txt', dest: root })).dir, root);
    assert.strictEqual((await uploads.plan({ name: 'a.txt', dest: 'nested/claude-config' })).relative, path.join('nested', 'claude-config'));
});

test('a symlinked folder, or one below it, is not a plain folder (409); one out of the root is 404', async () => {
    await refused(uploads.plan({ name: 'a.txt', dest: 'bp-link' }), 409, 'not-plain-folder');
    await refused(uploads.plan({ name: 'a.txt', dest: 'bp-link/automation' }), 409, 'not-plain-folder');
    await refused(uploads.plan({ name: 'a.txt', dest: 'out-link' }), 409, 'not-plain-folder');
    await refused(uploads.plan({ name: 'a.txt', dest: 'secrets.yaml' }), 409, 'not-plain-folder');
});

test('a name ending in .git is refused: the sidebar would never show it', async () => {
    await refused(uploads.plan({ name: 'repo.git', dest: 'blueprints' }), 400);
});

test('a request must name the file, a usable folder and a known onConflict', async () => {
    await refused(uploads.plan({ name: undefined }), 400);
    await refused(uploads.plan({ name: '' }), 400);
    await refused(uploads.plan({ name: ['a', 'b'] }), 400);
    await refused(uploads.plan({ name: 'a.txt', dest: ['a', 'b'] }), 400);
    await refused(uploads.plan({ name: 'a.txt', dest: 'blueprints', onConflict: 'overwrite' }), 400);
    // the inbox only numbers a taken name; asking it to replace is refused
    await refused(uploads.plan({ name: 'a.txt', onConflict: 'replace' }), 400);
    // positive controls: keep-both is what the inbox does anyway, and a
    // chosen folder may be asked to replace
    assert.strictEqual((await uploads.plan({ name: 'a.txt', onConflict: 'keep-both' }, { create: false })).inbox, true);
    assert.strictEqual((await uploads.plan({ name: 'a.txt', dest: 'blueprints', onConflict: 'replace' })).onConflict, 'replace');
});

test('the inbox is made on first use, never followed when it is a link or a file', async () => {
    const inboxRoot = path.join(base, 'inbox-root');
    fs.mkdirSync(inboxRoot);
    const inboxApi = createFilesApi({ root: inboxRoot });
    const u = createUploads({ api: inboxApi, record });
    // check=1 only asks: nothing is made
    assert.strictEqual((await u.plan({ name: 'a.txt' }, { create: false })).inbox, true);
    assert.strictEqual(fs.existsSync(path.join(inboxRoot, 'uploads')), false);
    const planned = await u.plan({ name: 'a.txt' });
    assert.strictEqual(fs.lstatSync(path.join(inboxRoot, 'uploads')).isDirectory(), true);
    assert.strictEqual(planned.dir, path.join(inboxRoot, 'uploads'));

    fs.rmdirSync(path.join(inboxRoot, 'uploads'));
    fs.symlinkSync(outside, path.join(inboxRoot, 'uploads'));
    await refused(u.plan({ name: 'a.txt' }), 409, 'not-plain-folder');
    fs.unlinkSync(path.join(inboxRoot, 'uploads'));
    fs.writeFileSync(path.join(inboxRoot, 'uploads'), 'a file');
    await refused(u.plan({ name: 'a.txt' }), 409, 'not-plain-folder');
    assert.deepStrictEqual(fs.readdirSync(outside), ['target.txt']);
});

// --- the route: helpers ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, ms = 3000) {
    const end = Date.now() + ms;
    while (!predicate() && Date.now() < end) await sleep(20);
    return predicate();
}

// A test signal that never comes fails the test instead of hanging the run.
async function within(promise, what, ms = 5000) {
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

// Descriptors this process holds on a file, counted by inode: independent of
// how the code under test opens or closes it, so a leak cannot hide behind a
// wrapped function. Linux has /proc/self/fd, macOS /dev/fd.
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

// Parts anywhere under the root: what a failed upload must never leave.
function partsUnder(dir = root) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (/^\.ctp-upload-.*\.part$/.test(entry.name)) found.push(full);
        if (entry.isDirectory()) found.push(...partsUnder(full));
    }
    return found;
}
const recorded = () => JSON.parse(fs.readFileSync(recordFile, 'utf8'));

async function withServer({ escapes = [], ...options }, fn) {
    const app = express();
    app.use('/api/files', createUploadRouter({
        uploads,
        uploadLimiter: createRateLimiter({ max: 1000 }),
        checkLimiter: createRateLimiter({ max: 1000 }),
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
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
    }
}

// Errors that left the route by a way the server cannot see: thrown in a
// stream or emitter callback, or rejected in a promise nobody awaits. Either
// would restart the wrapper and drop every terminal session.
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

const q = (params) => new URLSearchParams(params).toString();
const post = (url, params, body = '') => fetch(`${url}/upload?${q(params)}`, { method: 'POST', body });

// Sends the headers and `first` bytes of a body, and returns the socket.
function rawUpload(url, params, { length, first = '', headers = '' } = {}) {
    const { port } = new URL(url);
    return new Promise((resolve) => {
        const sock = net.connect(Number(port), '127.0.0.1', () => {
            const size = length === undefined ? '' : `Content-Length: ${length}\r\n`;
            sock.write(`POST /api/files/upload?${q(params)} HTTP/1.1\r\nHost: x\r\n${size}${headers}\r\n${first}`);
            resolve(sock);
        });
        sock.on('error', () => {});
    });
}
// Everything the server answers on a raw socket, until it closes.
function answer(sock) {
    return new Promise((resolve) => {
        let text = '';
        sock.on('data', (d) => { text += d; });
        sock.on('close', () => resolve(text));
    });
}

// --- the route: collisions and writes ---

test('upload: a new file lands with its bytes, mode 0644 whatever the umask', async () => {
    const old = process.umask(0o077);
    try {
        await withServer({}, async (url) => {
            const res = await post(url, { name: 'new file.yaml', dest: 'blueprints' }, 'hello: 1\n');
            assert.strictEqual(res.status, 200);
            const body = await res.json();
            assert.deepStrictEqual(body, {
                path: path.join(root, 'blueprints', 'new file.yaml'),
                name: 'new file.yaml',
                replaced: false,
                size: 9,
                dir: path.join(root, 'blueprints'),
                inbox: false,
            });
            assert.strictEqual(res.headers.get('cache-control'), 'no-store');
        });
    } finally {
        process.umask(old);
    }
    const full = path.join(root, 'blueprints', 'new file.yaml');
    assert.strictEqual(fs.readFileSync(full, 'utf8'), 'hello: 1\n');
    assert.strictEqual(fs.statSync(full).mode & 0o777, 0o644);
    assert.deepStrictEqual(partsUnder(), []);
    assert.deepStrictEqual(recorded(), []);
    fs.unlinkSync(full);
});

test('upload: the inbox keeps every file, numbering a name that is taken', async () => {
    await withServer({}, async (url) => {
        const names = [];
        for (const body of ['one', 'two', 'three']) {
            const res = await post(url, { name: 'a b.txt' }, body);
            assert.strictEqual(res.status, 200);
            const json = await res.json();
            assert.strictEqual(json.inbox, true);
            names.push(json.name);
        }
        assert.deepStrictEqual(names, ['a b.txt', 'a b (1).txt', 'a b (2).txt']);
    });
    const inbox = path.join(root, 'uploads');
    assert.strictEqual(fs.readFileSync(path.join(inbox, 'a b (2).txt'), 'utf8'), 'three');
    fs.rmSync(inbox, { recursive: true });
});

test('upload: a taken name in a chosen folder is a 409 that says whether Replace is possible', async () => {
    write('blueprints/folder-named/inner.txt', 'x');
    await withServer({}, async (url) => {
        let res = await post(url, { name: 'motion.yaml', dest: 'blueprints/automation' }, 'new');
        assert.strictEqual(res.status, 409);
        assert.deepStrictEqual(await res.json(), {
            reason: 'exists',
            replaceable: true,
            error: `motion.yaml already exists in ${path.join(root, 'blueprints', 'automation')}.`,
        });
        res = await post(url, { name: 'folder-named', dest: 'blueprints' }, 'new');
        assert.strictEqual(res.status, 409);
        assert.strictEqual((await res.json()).replaceable, false);
        // a folder is never replaced, even when asked
        res = await post(url, { name: 'folder-named', dest: 'blueprints', onConflict: 'replace' }, 'new');
        assert.strictEqual(res.status, 409);
        assert.strictEqual((await res.json()).replaceable, false);
        // Keep both works for either
        res = await post(url, { name: 'folder-named', dest: 'blueprints', onConflict: 'keep-both' }, 'kept');
        assert.strictEqual((await res.json()).name, 'folder-named (1)');
    });
    assert.strictEqual(fs.readFileSync(path.join(root, 'blueprints/automation/motion.yaml'), 'utf8'), 'old motion\n');
    assert.strictEqual(fs.readFileSync(path.join(root, 'blueprints/folder-named (1)'), 'utf8'), 'kept');
    fs.rmSync(path.join(root, 'blueprints/folder-named'), { recursive: true });
    fs.unlinkSync(path.join(root, 'blueprints/folder-named (1)'));
});

test('upload: Keep both numbers the new file; Replace swaps the whole file and keeps its mode', async () => {
    const target = write('blueprints/automation/key.yaml', 'OLD CONTENT\n');
    fs.chmodSync(target, 0o600);
    const oldFd = fs.openSync(target, 'r');   // the old file, as a reader mid-read sees it
    try {
        await withServer({}, async (url) => {
            let res = await post(url, { name: 'key.yaml', dest: 'blueprints/automation', onConflict: 'keep-both' }, 'both');
            assert.strictEqual((await res.json()).name, 'key (1).yaml');
            res = await post(url, { name: 'key.yaml', dest: 'blueprints/automation', onConflict: 'replace' }, 'NEW\n');
            assert.strictEqual(res.status, 200);
            assert.strictEqual((await res.json()).replaced, true);
        });
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'NEW\n');
        assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
        // Swapped, not rewritten in place: the old file is intact behind the
        // reader's descriptor, so no reader ever saw half of each.
        const buf = Buffer.alloc(64);
        assert.strictEqual(buf.subarray(0, fs.readSync(oldFd, buf, 0, 64, 0)).toString(), 'OLD CONTENT\n');
        assert.strictEqual(fs.readFileSync(path.join(root, 'blueprints/automation/key (1).yaml'), 'utf8'), 'both');
    } finally {
        fs.closeSync(oldFd);
        fs.unlinkSync(target);
        fs.unlinkSync(path.join(root, 'blueprints/automation/key (1).yaml'));
    }
});

test('upload: Replace keeps the permission bits but never setuid, setgid or sticky', async () => {
    const target = write('blueprints/automation/tool.sh', '#!/bin/sh\n');
    fs.chmodSync(target, 0o4755);
    // positive control: the fixture really carries setuid
    assert.strictEqual(fs.statSync(target).mode & 0o7777, 0o4755);
    try {
        await withServer({}, async (url) => {
            const res = await post(url, { name: 'tool.sh', dest: 'blueprints/automation', onConflict: 'replace' }, '#!/bin/sh\necho new\n');
            assert.strictEqual(res.status, 200);
            await res.arrayBuffer();
        });
        assert.strictEqual(fs.statSync(target).mode & 0o7777, 0o755);
    } finally {
        fs.unlinkSync(target);
    }
});

test('upload: replacing a name that is free just writes it, at 0644', async () => {
    await withServer({}, async (url) => {
        const res = await post(url, { name: 'free.yaml', dest: 'blueprints', onConflict: 'replace' }, 'x');
        assert.strictEqual(res.status, 200);
        assert.strictEqual((await res.json()).replaced, false);
    });
    const full = path.join(root, 'blueprints', 'free.yaml');
    assert.strictEqual(fs.statSync(full).mode & 0o777, 0o644);
    fs.unlinkSync(full);
});

test('upload: secrets.yaml and a certificate upload like any file', async () => {
    write('packages/secrets.yaml', 'old: 1\n');
    await withServer({}, async (url) => {
        let res = await post(url, { name: 'secrets.yaml', dest: 'packages' }, 'new: 1\n');
        assert.strictEqual(res.status, 409);
        await res.arrayBuffer();
        res = await post(url, { name: 'secrets.yaml', dest: 'packages', onConflict: 'replace' }, 'new: 1\n');
        assert.strictEqual(res.status, 200);
        res = await post(url, { name: 'fullchain.pem', dest: 'packages' }, 'CERT\n');
        assert.strictEqual(res.status, 200);
        await res.arrayBuffer();
    });
    assert.strictEqual(fs.readFileSync(path.join(root, 'packages/secrets.yaml'), 'utf8'), 'new: 1\n');
    // listed, with the lock, once it is there
    const entry = (await api.list('packages')).entries.find((e) => e.name === 'fullchain.pem');
    assert.strictEqual(entry.sensitive, true);
    fs.rmSync(path.join(root, 'packages'), { recursive: true });
});

test('upload: refusals are JSON with the right status, and write nothing', async () => {
    await withServer({}, async (url) => {
        const cases = [
            [{ name: 'a.txt', dest: '.git' }, 404],
            [{ name: 'a.txt', dest: '.storage' }, 403],
            [{ name: 'a.txt', dest: 'deps' }, 403],
            [{ name: 'a.txt', dest: 'bp-link' }, 409],
            [{ name: 'a.txt', dest: '../outside' }, 404],
            [{ name: 'repo.git', dest: 'blueprints' }, 400],
            [{ dest: 'blueprints' }, 400],
            [{ name: 'a.txt', dest: 'blueprints', onConflict: 'yes' }, 400],
        ];
        for (const [params, status] of cases) {
            const res = await post(url, params, 'body');
            assert.strictEqual(res.status, status, JSON.stringify(params));
            assert.strictEqual(typeof (await res.json()).error, 'string', JSON.stringify(params));
        }
    });
    assert.deepStrictEqual(partsUnder(), []);
    assert.strictEqual(fs.existsSync(path.join(root, 'blueprints', 'a.txt')), false);
});

test('upload: a cross-site request is refused before anything else, and costs no budget', async () => {
    await withServer({
        uploadLimiter: createRateLimiter({ max: 1 }),
        checkLimiter: createRateLimiter({ max: 1 }),
    }, async (url) => {
        for (const params of [{ name: 'x.txt', dest: 'blueprints' }, { name: 'x.txt', dest: 'blueprints', check: '1', size: '1' }]) {
            const res = await fetch(`${url}/upload?${q(params)}`, {
                method: 'POST', body: 'x', headers: { 'Sec-Fetch-Site': 'cross-site' },
            });
            assert.strictEqual(res.status, 403);
            assert.match((await res.json()).error, /^Uploads cannot be started from another site/);
        }
        assert.strictEqual(fs.existsSync(path.join(root, 'blueprints', 'x.txt')), false);
        // Each limiter's one request is still there.
        assert.strictEqual((await post(url, { name: 'x.txt', dest: 'blueprints', check: '1', size: '1' })).status, 200);
        assert.strictEqual((await post(url, { name: 'x.txt', dest: 'blueprints' }, 'x')).status, 200);
    });
    fs.unlinkSync(path.join(root, 'blueprints', 'x.txt'));
});

test('upload: its own limiter for uploads; check=1 counts against the other one', async () => {
    await withServer({
        uploadLimiter: createRateLimiter({ max: 1, message: 'Too many uploads' }),
        checkLimiter: createRateLimiter({ max: 1000 }),
    }, async (url) => {
        // Asking does not spend an upload: three checks, then the upload.
        for (let i = 0; i < 3; i++) {
            assert.strictEqual((await post(url, { name: 'r1.txt', dest: 'blueprints', check: '1', size: '1' })).status, 200);
        }
        assert.strictEqual((await post(url, { name: 'r1.txt', dest: 'blueprints' }, 'x')).status, 200);
        const res = await post(url, { name: 'r2.txt', dest: 'blueprints' }, 'x');
        assert.strictEqual(res.status, 429);
        assert.deepStrictEqual(await res.json(), { error: 'Too many uploads' });
    });
    fs.unlinkSync(path.join(root, 'blueprints', 'r1.txt'));
});

test('check=1 answers the 429 the upload would get once the upload budget is spent, and spends no read', async () => {
    // Uploads have their own limiter; check=1 counts against the read one.
    // Past the upload budget, a check that said yes would be followed by a
    // 429 sent mid-body, which behind ingress is often lost: the UI would
    // say it could not reach the add-on, for every file left. So check=1
    // asks the upload limiter too, without spending it, and before the
    // read limiter, so a refused check costs no read either.
    let uploadClock = 1e9;
    const readClock = 1e9;
    await withServer({
        uploadLimiter: createRateLimiter({ max: 2, message: 'Too many uploads', now: () => uploadClock }),
        checkLimiter: createRateLimiter({ max: 1, message: 'Too many file requests', now: () => readClock }),
    }, async (url) => {
        for (const name of ['p1.txt', 'p2.txt']) {
            assert.strictEqual((await post(url, { name, dest: 'blueprints' }, 'x')).status, 200);
        }
        for (let i = 0; i < 3; i++) {
            const res = await post(url, { name: 'p3.txt', dest: 'blueprints', check: '1', size: '1' });
            assert.strictEqual(res.status, 429);
            assert.deepStrictEqual(await res.json(), { error: 'Too many uploads' });
        }
        // The upload budget back, the one read the checks were allowed is
        // still there: none of the refused checks spent it.
        uploadClock += 60001;
        assert.strictEqual((await post(url, { name: 'p3.txt', dest: 'blueprints', check: '1', size: '1' })).status, 200);
        const res = await post(url, { name: 'p3.txt', dest: 'blueprints', check: '1', size: '1' });
        assert.strictEqual(res.status, 429);
        assert.deepStrictEqual(await res.json(), { error: 'Too many file requests' });
    });
    for (const name of ['p1.txt', 'p2.txt']) fs.unlinkSync(path.join(root, 'blueprints', name));
});

test('upload: an upload limiter without peek is refused when the router is made', () => {
    assert.throws(() => createUploadRouter({
        uploads, uploadLimiter: (req, res, next) => next(), checkLimiter: createRateLimiter({ max: 1 }),
    }), /peek/);
});

// --- check=1 ---

test('check=1 answers the plan and writes nothing, not even the inbox', async () => {
    await withServer({}, async (url) => {
        let res = await post(url, { name: '../x y.txt', check: '1', size: '10' });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(await res.json(), { name: 'x y.txt', dir: path.join(root, 'uploads'), inbox: true, exists: false });
        res = await post(url, { name: 'motion.yaml', dest: 'blueprints/automation', check: '1', size: '10' });
        assert.strictEqual(res.status, 409);
        assert.strictEqual((await res.json()).replaceable, true);
        res = await post(url, { name: 'motion.yaml', dest: 'blueprints/automation', onConflict: 'replace', check: '1', size: '10' });
        assert.deepStrictEqual(await res.json(), { name: 'motion.yaml', dir: path.join(root, 'blueprints', 'automation'), inbox: false, exists: true });
        res = await post(url, { name: 'a.txt', dest: '.storage', check: '1', size: '10' });
        assert.strictEqual(res.status, 403);
        await res.arrayBuffer();
    });
    assert.strictEqual(fs.existsSync(path.join(root, 'uploads')), false);
    assert.deepStrictEqual(partsUnder(), []);
});

test('check=1 refuses a size over the cap, naming the limit and the option', async () => {
    const small = createUploads({ api, record, maxBytes: 1024 * 1024 });
    await withServer({ uploads: small }, async (url) => {
        let res = await post(url, { name: 'big.bin', check: '1', size: String(3 * 1024 * 1024) });
        assert.strictEqual(res.status, 413);
        assert.deepStrictEqual(await res.json(),
            { error: 'This file is 3.0 MB, over the 1 MB upload limit (the add-on\'s upload_max_mb option).' });
        for (const size of [undefined, '', 'abc', '-1', '1.5']) {
            res = await post(url, { name: 'big.bin', check: '1', ...(size === undefined ? {} : { size }) });
            assert.strictEqual(res.status, 400, String(size));
            await res.arrayBuffer();
        }
    });
});

test('check=1: a file just over the cap is over it, never "1.0 MB, over the 1 MB" limit', async () => {
    const small = createUploads({ api, record, maxBytes: 1024 * 1024 });
    await withServer({ uploads: small }, async (url) => {
        let res = await post(url, { name: 'edge.bin', check: '1', size: String(1024 * 1024 + 1) });
        assert.strictEqual(res.status, 413);
        assert.deepStrictEqual(await res.json(),
            { error: 'This file is over the 1 MB upload limit (the add-on\'s upload_max_mb option).' });
        res = await post(url, { name: 'edge.bin', check: '1', size: String(Math.round(1.2 * 1024 * 1024)) });
        assert.match((await res.json()).error, /^This file is 1\.2 MB, over the 1 MB upload limit/);
        // positive control: a file at the cap is not over it
        res = await post(url, { name: 'edge.bin', check: '1', size: String(1024 * 1024) });
        assert.strictEqual(res.status, 200);
        await res.arrayBuffer();
    });
});

// --- the size cap while streaming ---

test('upload: a declared Content-Length over the cap is refused before any check or write', async () => {
    let adds = 0;
    const counting = { add: async () => { adds++; }, remove: async () => {} };
    let planned = 0;
    const small = createUploads({ api, record: counting, maxBytes: 1024 * 1024, onPlanned: () => { planned++; } });
    await withServer({ uploads: small }, async (url) => {
        const sock = await rawUpload(url, { name: 'big.bin', dest: 'blueprints' }, { length: 2 * 1024 * 1024 });
        const text = await within(answer(sock), 'the 413');
        assert.match(text, /^HTTP\/1\.1 413 /);
        assert.match(text, /Connection: close/i);
        assert.match(text, /This file is 2\.0 MB, over the 1 MB upload limit/);
        // positive control: a body under the cap goes through
        assert.strictEqual((await post(url, { name: 'small.bin', dest: 'blueprints' }, 'x'.repeat(1000))).status, 200);
    });
    assert.strictEqual(planned, 1);
    assert.strictEqual(adds, 1);
    fs.unlinkSync(path.join(root, 'blueprints', 'small.bin'));
});

test('upload: a body that runs over the cap is cut off with a 413 and leaves no part', async () => {
    const small = createUploads({ api, record, maxBytes: 1024 * 1024 });
    const escapes = [];
    await noStrays(async () => {
        await withServer({ uploads: small, escapes }, async (url) => {
            // chunked: no length up front, so only the count can catch it
            const sock = await rawUpload(url, { name: 'big.bin', dest: 'blueprints' },
                { headers: 'Transfer-Encoding: chunked\r\n' });
            const answered = answer(sock);
            for (let i = 0; i < 3; i++) sock.write(`80000\r\n${'y'.repeat(512 * 1024)}\r\n`);
            const text = await within(answered, 'the 413');
            assert.match(text, /^HTTP\/1\.1 413 /);
            assert.match(text, /This file is over the 1 MB upload limit \(the add-on's upload_max_mb option\)\./);
        });
    });
    assert.deepStrictEqual(escapes, []);
    assert.strictEqual(fs.existsSync(path.join(root, 'blueprints', 'big.bin')), false);
    assert.deepStrictEqual(partsUnder(), []);
    assert.deepStrictEqual(recorded(), []);
});

// --- every early end cleans up ---

const PART = '.ctp-upload-00000000000000aa.part';
const partPath = (dir = 'blueprints') => path.join(root, dir, PART);

test('upload: the record names a part while it is written, and drops it after', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let reached;
    const atCommit = new Promise((r) => { reached = r; });
    const held = createUploads({
        api, record, partName: () => PART,
        beforeCommit: async () => { reached(); await gate; },
    });
    await withServer({ uploads: held }, async (url) => {
        const done = post(url, { name: 'held.txt', dest: 'blueprints' }, 'held');
        await within(atCommit, 'the upload to reach its commit');
        assert.deepStrictEqual(recorded(), [partPath()]);
        assert.strictEqual(fs.readFileSync(partPath(), 'utf8'), 'held');
        // not listed meanwhile
        assert.ok(!(await api.list('blueprints')).entries.some((e) => e.name === PART));
        release();
        assert.strictEqual((await done).status, 200);
    });
    assert.deepStrictEqual(recorded(), []);
    assert.strictEqual(fs.existsSync(partPath()), false);
    fs.unlinkSync(path.join(root, 'blueprints', 'held.txt'));
});

test('upload: a client that leaves before the first byte is written leaves nothing behind', async () => {
    let entered;
    const inPlan = new Promise((r) => { entered = r; });
    let left;
    const clientGone = new Promise((r) => { left = r; });
    const slow = createUploads({
        api, record, partName: () => PART,
        onPlanned: async () => { entered(); await clientGone; await sleep(50); },
    });
    const escapes = [];
    await noStrays(async () => {
        await withServer({ uploads: slow, escapes }, async (url) => {
            const sock = await rawUpload(url, { name: 'early.txt', dest: 'blueprints' }, { length: 1000, first: 'x'.repeat(10) });
            await within(inPlan, 'the plan');
            sock.destroy();
            left();
            assert.ok(await until(() => !fs.existsSync(partPath()) && recorded().length === 0), 'part or record left');
        });
    });
    assert.deepStrictEqual(escapes, []);
    assert.strictEqual(fs.existsSync(path.join(root, 'blueprints', 'early.txt')), false);
    assert.deepStrictEqual(partsUnder(), []);
});

test('upload: a client that leaves mid-upload releases the part\'s descriptor and leaves nothing', async () => {
    const escapes = [];
    const named = createUploads({ api, record, partName: () => PART });
    await noStrays(async () => {
        await withServer({ uploads: named, escapes }, async (url) => {
            const sock = await rawUpload(url, { name: 'mid.bin', dest: 'blueprints' },
                { length: 4 * 1024 * 1024, first: 'z'.repeat(256 * 1024) });
            assert.ok(await until(() => fs.existsSync(partPath()) && fs.statSync(partPath()).size > 0), 'positive control: the part is being written');
            const ino = fs.statSync(partPath()).ino;
            assert.strictEqual(openFds(ino), 1, 'positive control: the part is open');
            sock.destroy();
            assert.ok(await until(() => openFds(ino) === 0), 'descriptor left open');
            assert.ok(await until(() => !fs.existsSync(partPath()) && recorded().length === 0), 'part or record left');
        });
    });
    assert.deepStrictEqual(escapes, []);
    assert.strictEqual(fs.existsSync(path.join(root, 'blueprints', 'mid.bin')), false);
});

test('upload: a client that stops sending is cut off after idleMs, once and quietly logged', async () => {
    const logged = [];
    const stalling = createUploads({ api, record, partName: () => PART, idleMs: 300 });
    await withServer({ uploads: stalling, log: (m) => logged.push(m) }, async (url) => {
        const sock = await rawUpload(url, { name: 'stall.bin', dest: 'blueprints' }, { length: 1000, first: 'x'.repeat(100) });
        assert.ok(await until(() => fs.existsSync(partPath()), 2000), 'positive control: the part exists');
        const ino = fs.statSync(partPath()).ino;
        assert.ok(await until(() => openFds(ino) === 0 && !fs.existsSync(partPath()), 4000), 'stalled upload kept its part');
        sock.destroy();
        assert.ok(await until(() => logged.length > 0, 1000), 'nothing logged');
        await sleep(100);   // and nothing more
    });
    assert.deepStrictEqual(logged, ['Upload of "stall.bin" cut off: client stalled for 300 ms']);
    assert.deepStrictEqual(recorded(), []);
});

// Defence in depth: Node errors a request whose client left, so through a
// real socket this cannot be reached (the tests above cover those). A body
// that simply ends short must still never become the file.
test('upload: a body that ends before it is complete is not saved', async () => {
    const { Readable } = require('node:stream');
    const short = Object.assign(Readable.from([Buffer.from('partial')]), { complete: false, setTimeout() {} });
    const named = createUploads({ api, record, partName: () => PART });
    const planned = await named.plan({ name: 'short.txt', dest: 'blueprints' });
    await assert.rejects(named.receive(short, planned, { log: () => {} }));
    assert.strictEqual(fs.existsSync(path.join(root, 'blueprints', 'short.txt')), false);
    assert.strictEqual(fs.existsSync(partPath()), false);
    // positive control: the same body, complete, is saved
    const whole = Object.assign(Readable.from([Buffer.from('whole')]), { complete: true, setTimeout() {} });
    assert.strictEqual((await named.receive(whole, planned, { log: () => {} })).size, 5);
    fs.unlinkSync(path.join(root, 'blueprints', 'short.txt'));
});

test('upload: a full disk is a 507 that says so, and leaves no part', async () => {
    let partIno = null;
    const full = createUploads({
        api, record, partName: () => PART,
        openPart: async (p) => {
            const handle = await require('node:fs/promises').open(p, 'wx', 0o644);
            partIno = (await handle.stat()).ino;
            let writes = 0;
            return {
                stat: (opts) => handle.stat(opts),
                chmod: (m) => handle.chmod(m),
                datasync: () => handle.datasync(),
                truncate: (n) => handle.truncate(n),
                close: () => handle.close(),
                write: (...args) => {
                    if (++writes > 1) return Promise.reject(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }));
                    return handle.write(...args);
                },
            };
        },
    });
    await withServer({ uploads: full }, async (url) => {
        const sock = await rawUpload(url, { name: 'full.bin', dest: 'blueprints' }, { length: 2 * 1024 * 1024 });
        const answered = answer(sock);
        sock.write('a'.repeat(64 * 1024));
        await sleep(20);
        sock.write('b'.repeat(64 * 1024));
        const text = await within(answered, 'the 507');
        assert.match(text, /^HTTP\/1\.1 507 /);
        assert.match(text, /The disk is full/);
    });
    assert.ok(partIno !== null, 'positive control: the part was opened');
    assert.ok(await until(() => openFds(partIno) === 0), 'descriptor left open');
    assert.deepStrictEqual(partsUnder(), []);
    assert.deepStrictEqual(recorded(), []);
});

test('upload: a failed rename is a logged 500 that leaves neither file nor part', async () => {
    const logged = [];
    const failing = createUploads({
        api, record, partName: () => PART,
        fsOps: {
            link: async () => { throw Object.assign(new Error('simulated EIO'), { code: 'EIO' }); },
            rename: async () => { throw Object.assign(new Error('simulated EIO'), { code: 'EIO' }); },
        },
    });
    await withServer({ uploads: failing, log: (m) => logged.push(m) }, async (url) => {
        let res = await post(url, { name: 'eio.txt', dest: 'blueprints' }, 'x');
        assert.strictEqual(res.status, 500);
        assert.deepStrictEqual(await res.json(), { error: 'Internal error' });
        res = await post(url, { name: 'motion.yaml', dest: 'blueprints/automation', onConflict: 'replace' }, 'x');
        assert.strictEqual(res.status, 500);
        await res.arrayBuffer();
    });
    assert.ok(logged.some((m) => /simulated EIO/.test(m)), logged.join('\n'));
    assert.strictEqual(fs.existsSync(path.join(root, 'blueprints', 'eio.txt')), false);
    assert.strictEqual(fs.readFileSync(path.join(root, 'blueprints/automation/motion.yaml'), 'utf8'), 'old motion\n');
    assert.deepStrictEqual(partsUnder(), []);
    assert.deepStrictEqual(recorded(), []);
});

test('upload: without hard links, a new file still lands and a taken name is still not clobbered', async () => {
    const noLinks = createUploads({
        api, record,
        fsOps: {
            link: async () => { throw Object.assign(new Error('not supported'), { code: 'EPERM' }); },
            rename: require('node:fs/promises').rename,
        },
    });
    await withServer({ uploads: noLinks }, async (url) => {
        assert.strictEqual((await post(url, { name: 'nolink.txt', dest: 'blueprints' }, 'one')).status, 200);
        const res = await post(url, { name: 'nolink.txt', dest: 'blueprints', onConflict: 'keep-both' }, 'two');
        assert.strictEqual((await res.json()).name, 'nolink (1).txt');
    });
    assert.strictEqual(fs.readFileSync(path.join(root, 'blueprints', 'nolink.txt'), 'utf8'), 'one');
    fs.unlinkSync(path.join(root, 'blueprints', 'nolink.txt'));
    fs.unlinkSync(path.join(root, 'blueprints', 'nolink (1).txt'));
    assert.deepStrictEqual(partsUnder(), []);
});

test('upload: a name taken while the body came in is never clobbered', async () => {
    const racing = createUploads({
        api, record,
        beforeCommit: async (part, planned) => fs.writeFileSync(path.join(planned.dir, planned.name), 'got there first'),
    });
    await withServer({ uploads: racing }, async (url) => {
        let res = await post(url, { name: 'race.txt', dest: 'blueprints' }, 'mine');
        assert.strictEqual(res.status, 409);
        assert.strictEqual((await res.json()).reason, 'exists');
        res = await post(url, { name: 'race2.txt' }, 'mine');   // the inbox numbers it instead
        assert.strictEqual((await res.json()).name, 'race2 (1).txt');
    });
    assert.strictEqual(fs.readFileSync(path.join(root, 'blueprints', 'race.txt'), 'utf8'), 'got there first');
    fs.unlinkSync(path.join(root, 'blueprints', 'race.txt'));
    fs.rmSync(path.join(root, 'uploads'), { recursive: true });
    assert.deepStrictEqual(partsUnder(), []);
});

test('upload: a folder removed or swapped for a link during the upload gets no file', async () => {
    write('vanishing/keep.txt', 'x');
    const vanishing = createUploads({
        api, record,
        beforeCommit: async () => fs.rmSync(path.join(root, 'vanishing'), { recursive: true }),
    });
    write('swapped/keep.txt', 'x');
    const swapping = createUploads({
        api, record,
        beforeCommit: async () => {
            fs.renameSync(path.join(root, 'swapped'), path.join(root, 'swapped-away'));
            fs.symlinkSync(outside, path.join(root, 'swapped'));
        },
    });
    await withServer({ uploads: vanishing }, async (url) => {
        const res = await post(url, { name: 'v.txt', dest: 'vanishing' }, 'x');
        assert.strictEqual(res.status, 404);
        assert.match((await res.json()).error, /was removed during the upload/);
    });
    await withServer({ uploads: swapping }, async (url) => {
        const res = await post(url, { name: 's.txt', dest: 'swapped' }, 'x');
        assert.strictEqual(res.status, 409);
        assert.strictEqual((await res.json()).reason, 'not-plain-folder');
    });
    assert.deepStrictEqual(fs.readdirSync(outside), ['target.txt']);
    fs.unlinkSync(path.join(root, 'swapped'));
    fs.rmSync(path.join(root, 'swapped-away'), { recursive: true });
    assert.deepStrictEqual(partsUnder(), []);
    assert.deepStrictEqual(recorded(), []);
});

test('upload: a read-only disk, a refused write and a name too long are said plainly, and logged', async () => {
    const cases = [
        ['EROFS', 403, /read-only/],
        ['EACCES', 403, /not allowed to write/],
        ['ENAMETOOLONG', 400, /too long/],
    ];
    for (const [code, status, text] of cases) {
        const logged = [];
        const failing = createUploads({
            api, record,
            openPart: async () => { throw Object.assign(new Error(`simulated ${code}`), { code }); },
        });
        await withServer({ uploads: failing, log: (m) => logged.push(m) }, async (url) => {
            const res = await post(url, { name: 'ro.txt', dest: 'blueprints' }, 'x');
            assert.strictEqual(res.status, status, code);
            assert.match((await res.json()).error, text);
        });
        assert.ok(logged.some((m) => m.includes(`simulated ${code}`)), `${code}: ${logged.join(' | ')}`);
    }
    assert.strictEqual(fs.existsSync(path.join(root, 'blueprints', 'ro.txt')), false);
    assert.deepStrictEqual(partsUnder(), []);
    assert.deepStrictEqual(recorded(), []);
});

test('upload: a folder that goes between the two halves of its last check is a 404, not a 500', async () => {
    let gone = false;
    const racing = createUploads({
        api, record,
        // the folder lstats as there, then is gone by its realpath
        fsOps: {
            realpath: async (p) => {
                if (gone) throw Object.assign(new Error('simulated ENOENT'), { code: 'ENOENT' });
                return fs.promises.realpath(p);
            },
        },
        beforeCommit: async () => { gone = true; },
    });
    await withServer({ uploads: racing }, async (url) => {
        const res = await post(url, { name: 'between.txt', dest: 'blueprints' }, 'x');
        assert.strictEqual(res.status, 404);
        assert.match((await res.json()).error, /was removed during the upload/);
    });
    assert.strictEqual(fs.existsSync(path.join(root, 'blueprints', 'between.txt')), false);
    assert.deepStrictEqual(partsUnder(), []);
    assert.deepStrictEqual(recorded(), []);
});

test('upload: a record that cannot be written refuses the upload before any byte', async () => {
    const broken = { add: async () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); }, remove: async () => {} };
    await withServer({ uploads: createUploads({ api, record: broken }) }, async (url) => {
        const res = await post(url, { name: 'norecord.txt', dest: 'blueprints' }, 'x');
        assert.strictEqual(res.status, 507);
        await res.arrayBuffer();
    });
    assert.strictEqual(fs.existsSync(path.join(root, 'blueprints', 'norecord.txt')), false);
    assert.deepStrictEqual(partsUnder(), []);
});

test('routes: an unexpected error is a 500 JSON, not a thrown exception', async () => {
    const escapes = [];
    const broken = { plan: async () => { throw new TypeError('bug'); }, maxBytes: 1024, tooBig: () => new Error('x') };
    await withServer({ uploads: broken, escapes }, async (url) => {
        for (const params of [{ name: 'x' }, { name: 'x', check: '1', size: '1' }]) {
            const res = await post(url, params, 'x');
            assert.strictEqual(res.status, 500);
            assert.deepStrictEqual(await res.json(), { error: 'Internal error' });
        }
    });
    assert.deepStrictEqual(escapes, []);
});

// --- races: the part stays in the folder that was checked ---
//
// Each test swaps folders or files around at a seam (onPlanned: before the
// part is opened; openPart: just after; beforeCommit: after the last byte),
// the way another process could between two system calls.

// A folder of its own under the root, one outside it, and where the folder
// goes while a link stands in for it.
function raceFixture(name) {
    const dir = path.join(root, name);
    const out = path.join(base, `out-${name}`);
    const away = path.join(base, `away-${name}`);
    fs.mkdirSync(dir);
    fs.mkdirSync(out);
    return {
        dir, out,
        toLink() { fs.renameSync(dir, away); fs.symlinkSync(out, dir); },
        back() { fs.unlinkSync(dir); fs.renameSync(away, dir); },
        cleanup() {
            if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(dir);
            for (const d of [dir, out, away]) fs.rmSync(d, { recursive: true, force: true });
        },
    };
}
// A folder's files and their contents ('<link>' for anything not a file).
function filesIn(dir) {
    return Object.fromEntries(fs.readdirSync(dir).sort().map((n) => {
        const full = path.join(dir, n);
        return [n, fs.lstatSync(full).isFile() ? fs.readFileSync(full, 'utf8') : '<link>'];
    }));
}
const openNoFollow = (p) => fs.promises.open(p,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);

test('race: a folder swapped for a link before the part is opened gets no byte, inside the root or out', async () => {
    const f = raceFixture('race-open');
    const outsideAtCommit = [];
    const swapping = createUploads({
        api, record,
        onPlanned: async () => f.toLink(),
        beforeCommit: async () => { outsideAtCommit.push(...Object.values(filesIn(f.out))); f.back(); },
    });
    try {
        await withServer({ uploads: swapping }, async (url) => {
            const res = await post(url, { name: 'x.txt', dest: 'race-open' }, 'content');
            assert.strictEqual(res.status, 409);
            assert.strictEqual((await res.json()).reason, 'not-plain-folder');
        });
        assert.deepStrictEqual(outsideAtCommit, []);
        assert.deepStrictEqual(filesIn(f.out), {});
    } finally {
        f.cleanup();
    }
    assert.deepStrictEqual(partsUnder(), []);
    assert.deepStrictEqual(recorded(), []);
});

test('race: Replace through a folder swapped back and forth never writes outside the root', async () => {
    const f = raceFixture('race-twice');
    fs.writeFileSync(path.join(f.out, 'victim.conf'), 'original');
    const swapping = createUploads({
        api, record,
        onPlanned: async () => f.toLink(),
        beforeCommit: async () => f.back(),
        fsOps: { link: fs.promises.link, rename: async (a, b) => { f.toLink(); return fs.promises.rename(a, b); } },
    });
    try {
        await withServer({ uploads: swapping }, async (url) => {
            const res = await post(url, { name: 'victim.conf', dest: 'race-twice', onConflict: 'replace' }, 'USER CONTENT');
            assert.strictEqual(res.status, 409);
            assert.strictEqual((await res.json()).reason, 'not-plain-folder');
        });
        assert.deepStrictEqual(filesIn(f.out), { 'victim.conf': 'original' });
    } finally {
        f.cleanup();
    }
    assert.deepStrictEqual(partsUnder(), []);
    assert.deepStrictEqual(recorded(), []);
});

test('race: a part opened through a link, with the folder back before the check, is refused before its first byte', async () => {
    const f = raceFixture('race-back');
    const outsideAtCommit = [];
    const swapping = createUploads({
        api, record,
        onPlanned: async () => f.toLink(),
        openPart: async (p) => { const handle = await openNoFollow(p); f.back(); return handle; },
        beforeCommit: async () => { outsideAtCommit.push(...Object.values(filesIn(f.out))); },
    });
    try {
        await withServer({ uploads: swapping }, async (url) => {
            const res = await post(url, { name: 'x.txt', dest: 'race-back' }, 'content');
            assert.strictEqual(res.status, 409);
            assert.strictEqual((await res.json()).reason, 'changed');
        });
        assert.deepStrictEqual(outsideAtCommit, []);
        // The part was made outside, where only its descriptor reached it:
        // it is left there empty, never with a byte of the upload.
        assert.deepStrictEqual(Object.values(filesIn(f.out)), ['']);
        assert.deepStrictEqual(filesIn(f.dir), {});
    } finally {
        f.cleanup();
    }
    assert.deepStrictEqual(recorded(), []);
});

test('race: Replace never changes the mode of what a link in the part\'s place points to', async () => {
    const f = raceFixture('race-chmod');
    const key = path.join(f.out, 'secret.key');
    fs.writeFileSync(key, 'k');
    fs.chmodSync(key, 0o600);
    fs.writeFileSync(path.join(f.dir, 'old.sh'), 'x');
    fs.chmodSync(path.join(f.dir, 'old.sh'), 0o777);
    const swapping = createUploads({
        api, record, partName: () => PART,
        beforeCommit: async (part) => { fs.unlinkSync(part); fs.symlinkSync(key, part); },
    });
    try {
        await withServer({ uploads: swapping }, async (url) => {
            const res = await post(url, { name: 'old.sh', dest: 'race-chmod', onConflict: 'replace' }, 'new');
            assert.strictEqual(res.status, 409);
            assert.strictEqual((await res.json()).reason, 'changed');
        });
        assert.strictEqual(fs.statSync(key).mode & 0o777, 0o600);
        assert.strictEqual(fs.readFileSync(key, 'utf8'), 'k');
        // the old file is untouched, and the planted link (not this upload's) is left alone
        assert.deepStrictEqual(filesIn(f.dir), { [PART]: '<link>', 'old.sh': 'x' });
    } finally {
        f.cleanup();
    }
    assert.deepStrictEqual(recorded(), []);
});

test('race: a part swapped for another file mid-upload is never put in place', async () => {
    const f = raceFixture('race-other');
    fs.writeFileSync(path.join(f.dir, 'old.txt'), 'old');
    const swapping = createUploads({
        api, record, partName: () => PART,
        beforeCommit: async (part) => { fs.unlinkSync(part); fs.writeFileSync(part, 'not the upload'); },
    });
    try {
        await withServer({ uploads: swapping }, async (url) => {
            for (const params of [{ name: 'w.txt' }, { name: 'old.txt', onConflict: 'replace' }]) {
                fs.rmSync(path.join(f.dir, PART), { force: true });
                const res = await post(url, { dest: 'race-other', ...params }, 'content');
                assert.strictEqual(res.status, 409, JSON.stringify(params));
                assert.strictEqual((await res.json()).reason, 'changed');
                // the other file is not this upload's: left where it is
                assert.deepStrictEqual(filesIn(f.dir), { [PART]: 'not the upload', 'old.txt': 'old' });
            }
        });
    } finally {
        f.cleanup();
    }
    assert.deepStrictEqual(recorded(), []);
});

test('race: a folder moved mid-upload takes none of the part\'s bytes with it', async () => {
    const f = raceFixture('race-moved');
    const moved = path.join(root, 'race-moved-2');
    let ino = null;
    const moving = createUploads({
        api, record, partName: () => PART,
        beforeCommit: async (part) => { ino = fs.statSync(part).ino; fs.renameSync(f.dir, moved); },
    });
    try {
        await withServer({ uploads: moving }, async (url) => {
            const res = await post(url, { name: 'y.txt', dest: 'race-moved' }, 'content');
            assert.strictEqual(res.status, 404);
            assert.match((await res.json()).error, /was removed during the upload/);
        });
        assert.ok(ino !== null, 'positive control: the part existed');
        assert.ok(await until(() => openFds(ino) === 0), 'descriptor left open');
        // Out of the unlink's reach, so emptied through its descriptor.
        assert.deepStrictEqual(filesIn(moved), { [PART]: '' });
    } finally {
        f.cleanup();
        fs.rmSync(moved, { recursive: true, force: true });
    }
    assert.deepStrictEqual(recorded(), []);
});

test('race: a folder moved and made again mid-upload gets no file', async () => {
    const f = raceFixture('race-remade');
    const moved = path.join(root, 'race-remade-2');
    const remaking = createUploads({
        api, record, partName: () => PART,
        beforeCommit: async () => { fs.renameSync(f.dir, moved); fs.mkdirSync(f.dir); },
    });
    try {
        await withServer({ uploads: remaking }, async (url) => {
            const res = await post(url, { name: 'y.txt', dest: 'race-remade' }, 'content');
            assert.strictEqual(res.status, 409);
            assert.strictEqual((await res.json()).reason, 'changed');
        });
        assert.deepStrictEqual(filesIn(f.dir), {});
        assert.deepStrictEqual(filesIn(moved), { [PART]: '' });
    } finally {
        f.cleanup();
        fs.rmSync(moved, { recursive: true, force: true });
    }
    assert.deepStrictEqual(recorded(), []);
});

test('race: Replace refuses a name that became a folder or a link mid-upload', async () => {
    const f = raceFixture('race-target');
    const target = path.join(f.dir, 't.txt');
    fs.writeFileSync(path.join(f.out, 'linked.txt'), 'outside');
    const toFolder = createUploads({
        api, record,
        beforeCommit: async () => { fs.unlinkSync(target); fs.mkdirSync(target); },
    });
    const toLink = createUploads({
        api, record,
        beforeCommit: async () => { fs.unlinkSync(target); fs.symlinkSync(path.join(f.out, 'linked.txt'), target); },
    });
    try {
        for (const uploads of [toFolder, toLink]) {
            fs.rmSync(target, { recursive: true, force: true });
            fs.writeFileSync(target, 'old');
            await withServer({ uploads }, async (url) => {
                const res = await post(url, { name: 't.txt', dest: 'race-target', onConflict: 'replace' }, 'new');
                assert.strictEqual(res.status, 409);
                assert.deepStrictEqual(await res.json(), {
                    reason: 'exists',
                    replaceable: false,
                    error: `t.txt already exists in ${f.dir} and is not a regular file, so it cannot be replaced.`,
                });
            });
        }
        assert.strictEqual(fs.lstatSync(target).isSymbolicLink(), true);
        assert.deepStrictEqual(filesIn(f.out), { 'linked.txt': 'outside' });
    } finally {
        f.cleanup();
    }
    assert.deepStrictEqual(partsUnder(), []);
    assert.deepStrictEqual(recorded(), []);
});

test('race: Replace onto a name that becomes a folder between its last look and the rename is a 409, not a 500', async () => {
    // commit()'s lstat saw a file; the rename then meets a folder. Linux and
    // macOS raise EISDIR for any folder; POSIX also allows ENOTEMPTY for one
    // that is not empty (raised here by the seam, as is a bare EISDIR).
    const f = raceFixture('race-isdir');
    const target = path.join(f.dir, 't.txt');
    const toFolder = (withFile) => async (a, b) => {
        fs.unlinkSync(b);
        fs.mkdirSync(b);
        if (withFile) fs.writeFileSync(path.join(b, 'inside'), 'kept');
        return fs.promises.rename(a, b);
    };
    const refuses = (code) => async () => { throw Object.assign(new Error(`${code}: rename refused`), { code }); };
    const logged = [];
    try {
        for (const [rename, left] of [
            [toFolder(false), {}], [toFolder(true), { inside: 'kept' }], [refuses('EISDIR'), 'old'], [refuses('ENOTEMPTY'), 'old'],
        ]) {
            fs.rmSync(target, { recursive: true, force: true });
            fs.writeFileSync(target, 'old');
            const uploads = createUploads({ api, record, fsOps: { rename } });
            await withServer({ uploads, log: (m) => logged.push(m) }, async (url) => {
                const res = await post(url, { name: 't.txt', dest: 'race-isdir', onConflict: 'replace' }, 'new');
                assert.strictEqual(res.status, 409, JSON.stringify(left));
                // what happened, not that the temporary file moved
                assert.deepStrictEqual(await res.json(), {
                    reason: 'changed',
                    error: `t.txt in ${f.dir} became a folder during the upload, so nothing was saved.`,
                });
            });
            // what is at the name is left as it is, and no part anywhere
            assert.deepStrictEqual(typeof left === 'string' ? fs.readFileSync(target, 'utf8') : filesIn(target), left);
            assert.deepStrictEqual(partsUnder(f.dir), []);
        }
        // Without hard links, placeNew's lstat then rename: a folder made at
        // the name between the two is the same 409, naming that name.
        const noLinks = createUploads({
            api, record,
            fsOps: {
                link: async () => { throw Object.assign(new Error('not supported'), { code: 'EPERM' }); },
                rename: async (a, b) => { fs.mkdirSync(b); return fs.promises.rename(a, b); },
            },
        });
        await withServer({ uploads: noLinks, log: (m) => logged.push(m) }, async (url) => {
            const res = await post(url, { name: 'n.txt', dest: 'race-isdir' }, 'new');
            assert.strictEqual(res.status, 409);
            assert.deepStrictEqual(await res.json(), {
                reason: 'changed',
                error: `n.txt in ${f.dir} became a folder during the upload, so nothing was saved.`,
            });
        });
        assert.deepStrictEqual(filesIn(path.join(f.dir, 'n.txt')), {});
        assert.deepStrictEqual(partsUnder(f.dir), []);
        assert.ok(logged.some((m) => /EISDIR/.test(m)), logged.join('\n'));
        assert.ok(logged.some((m) => /ENOTEMPTY/.test(m)), logged.join('\n'));
    } finally {
        f.cleanup();
    }
    assert.deepStrictEqual(recorded(), []);
});

test('race: a folder swapped for a file mid-upload is not a plain folder', async () => {
    const f = raceFixture('race-file');
    const swapping = createUploads({
        api, record,
        beforeCommit: async () => { fs.renameSync(f.dir, `${f.dir}-away`); fs.writeFileSync(f.dir, 'a file now'); },
    });
    try {
        await withServer({ uploads: swapping }, async (url) => {
            const res = await post(url, { name: 'z.txt', dest: 'race-file' }, 'content');
            assert.strictEqual(res.status, 409);
            assert.strictEqual((await res.json()).reason, 'not-plain-folder');
        });
        assert.strictEqual(fs.readFileSync(f.dir, 'utf8'), 'a file now');
    } finally {
        fs.unlinkSync(f.dir);
        fs.rmSync(`${f.dir}-away`, { recursive: true, force: true });
        f.cleanup();
    }
    assert.deepStrictEqual(recorded(), []);
});

test('race: a parent folder swapped for a link mid-upload is caught by its real path', async () => {
    const f = raceFixture('race-parent');
    fs.mkdirSync(path.join(f.dir, 'child'));
    fs.mkdirSync(path.join(f.out, 'child'));
    const swapping = createUploads({ api, record, beforeCommit: async () => f.toLink() });
    try {
        await withServer({ uploads: swapping }, async (url) => {
            // the folder itself still lstats as a real folder: only its
            // real path shows the way to it now runs through a link
            const res = await post(url, { name: 'p.txt', dest: 'race-parent/child' }, 'content');
            assert.strictEqual(res.status, 409);
            assert.strictEqual((await res.json()).reason, 'not-plain-folder');
        });
        assert.deepStrictEqual(filesIn(path.join(f.out, 'child')), {});
    } finally {
        f.cleanup();
    }
    assert.deepStrictEqual(recorded(), []);
});

test('race: a link or a file already at the part\'s name is never written through, nor removed', async () => {
    const f = raceFixture('race-planted');
    const victim = path.join(f.out, 'victim');
    fs.writeFileSync(victim, 'original');
    const planted = path.join(f.dir, PART);
    const plantLink = createUploads({ api, record, partName: () => PART, onPlanned: async () => fs.symlinkSync(victim, planted) });
    const plantFile = createUploads({ api, record, partName: () => PART, onPlanned: async () => fs.writeFileSync(planted, 'someone else\'s') });
    try {
        await withServer({ uploads: plantLink }, async (url) => {
            const res = await post(url, { name: 'v.txt', dest: 'race-planted' }, 'content');
            assert.strictEqual(res.status, 500);
            await res.arrayBuffer();
        });
        assert.deepStrictEqual(filesIn(f.dir), { [PART]: '<link>' });
        assert.deepStrictEqual(filesIn(f.out), { victim: 'original' });
        fs.unlinkSync(planted);
        await withServer({ uploads: plantFile }, async (url) => {
            const res = await post(url, { name: 'v.txt', dest: 'race-planted' }, 'content');
            assert.strictEqual(res.status, 500);
            await res.arrayBuffer();
        });
        assert.deepStrictEqual(filesIn(f.dir), { [PART]: 'someone else\'s' });
    } finally {
        f.cleanup();
    }
    assert.deepStrictEqual(recorded(), []);
});

test('race: a part swapped in the moment before it is put in place is a logged 409, never a false success', async () => {
    const f = raceFixture('race-place');
    // Between the last check of the part and the link or rename that puts
    // it in place, its name is given to another file.
    const swap = (part) => { fs.unlinkSync(part); fs.writeFileSync(part, 'not the upload'); };
    const logged = [];
    const viaLink = createUploads({
        api, record, partName: () => PART,
        fsOps: { link: async (a, b) => { swap(a); return fs.promises.link(a, b); } },
    });
    const viaRename = createUploads({
        api, record, partName: () => PART,
        fsOps: { rename: async (a, b) => { swap(a); return fs.promises.rename(a, b); } },
    });
    const noLinks = createUploads({
        api, record, partName: () => PART,
        fsOps: {
            link: async () => { throw Object.assign(new Error('not supported'), { code: 'EPERM' }); },
            rename: async (a, b) => { swap(a); return fs.promises.rename(a, b); },
        },
    });
    // What each leaves: a rename moves the other file to the name, where it
    // stays (not this upload's to remove). A link() only gave it a second
    // name, which this upload made and so takes back: the other file stays
    // at the part's name, as it was.
    // And what each says: after a link() the part's name no longer named
    // this upload's file, so the link put another file there and nothing
    // was saved. After a rename the part is gone, so which file it was
    // cannot be told: neither "saved" nor "nothing was saved".
    const linkSays = (error) => assert.match(error, /nothing was saved/);
    const renameSays = (name) => (error) => {
        assert.doesNotMatch(error, /nothing was saved|was saved in|overwritten/);
        assert.match(error, new RegExp(`^${name.replace('.', '\\.')} in .*race-place is not the upload, or is not there`));
    };
    const cases = [
        [viaLink, { name: 'l.txt' }, { [PART]: 'not the upload', 'old.txt': 'old' }, 'l.txt', linkSays],
        [viaRename, { name: 'old.txt', onConflict: 'replace' }, { 'old.txt': 'not the upload' }, 'old.txt',
            (error) => assert.match(error, /was overwritten/)],
        [noLinks, { name: 'n.txt' }, { 'n.txt': 'not the upload', 'old.txt': 'old' }, 'n.txt', renameSays('n.txt')],
    ];
    try {
        for (const [uploads, params, left, named, says] of cases) {
            fs.rmSync(f.dir, { recursive: true, force: true });
            fs.mkdirSync(f.dir);
            fs.writeFileSync(path.join(f.dir, 'old.txt'), 'old');
            await withServer({ uploads, log: (m) => logged.push(m) }, async (url) => {
                const res = await post(url, { dest: 'race-place', ...params }, 'content');
                assert.strictEqual(res.status, 409, JSON.stringify(params));
                const body = await res.json();
                assert.strictEqual(body.reason, 'changed');
                says(body.error);
            });
            // never this upload's bytes, anywhere
            assert.deepStrictEqual(filesIn(f.dir), left, JSON.stringify(params));
            assert.ok(logged.some((m) => m.includes(path.join(f.dir, named))
                && m.includes('moved or replaced as it was put in place')), logged.join('\n'));
        }
    } finally {
        f.cleanup();
    }
    assert.deepStrictEqual(recorded(), []);
});

test('race: a folder swapped for a link as the part is put in place is a 409, not a 500', async () => {
    const f = raceFixture('race-enoent');
    const logged = [];
    // The link or rename runs through the swapped folder, where the part
    // is not: ENOENT, which says the folder changed, not that a bug did.
    const viaLink = createUploads({
        api, record,
        fsOps: { link: async (a, b) => { f.toLink(); return fs.promises.link(a, b); } },
    });
    const viaRename = createUploads({
        api, record,
        fsOps: { rename: async (a, b) => { f.toLink(); return fs.promises.rename(a, b); } },
    });
    fs.writeFileSync(path.join(f.out, 'victim.conf'), 'original');
    try {
        for (const [uploads, params] of [[viaLink, { name: 'n.txt' }], [viaRename, { name: 'victim.conf', onConflict: 'replace' }]]) {
            fs.writeFileSync(path.join(f.dir, 'victim.conf'), 'old');
            await withServer({ uploads, log: (m) => logged.push(m) }, async (url) => {
                const res = await post(url, { dest: 'race-enoent', ...params }, 'USER CONTENT');
                assert.strictEqual(res.status, 409, JSON.stringify(params));
                assert.strictEqual((await res.json()).reason, 'changed');
            });
            assert.deepStrictEqual(filesIn(f.out), { 'victim.conf': 'original' });
            f.back();
        }
        assert.ok(logged.some((m) => /ENOENT/.test(m)), logged.join('\n'));
    } finally {
        f.cleanup();
    }
    assert.deepStrictEqual(recorded(), []);
});

test('race: a part swapped for a symlink as it is linked into place leaves no name for the link\'s target', async () => {
    // Linux's link() makes a second name for the symlink, macOS's for what
    // it points to (here outside the root). Either name is this call's own
    // and is taken back; the file outside is untouched.
    const f = raceFixture('race-symlinked');
    const key = path.join(f.out, 'k.key');
    fs.writeFileSync(key, 'secret');
    const viaLink = createUploads({
        api, record, partName: () => PART,
        fsOps: { link: async (a, b) => { fs.unlinkSync(a); fs.symlinkSync(key, a); return fs.promises.link(a, b); } },
    });
    try {
        await withServer({ uploads: viaLink }, async (url) => {
            const res = await post(url, { dest: 'race-symlinked', name: 'n.txt' }, 'content');
            assert.strictEqual(res.status, 409);
            assert.strictEqual((await res.json()).reason, 'changed');
        });
        assert.deepStrictEqual(filesIn(f.dir), { [PART]: '<link>' });
        assert.deepStrictEqual(filesIn(f.out), { 'k.key': 'secret' });
        assert.strictEqual(fs.statSync(key).nlink, 1);
    } finally {
        f.cleanup();
    }
    assert.deepStrictEqual(recorded(), []);
});

test('race: a file moved away the moment it is put in place keeps every byte', async () => {
    // Something (an automation, a sync tool) takes the file as soon as it
    // appears. It is not where the upload put it, so the answer is a 409,
    // but it is the user's file: never emptied wherever it went.
    const f = raceFixture('race-taken');
    const away = path.join(f.out, 'taken');
    const take = (target) => fs.renameSync(target, away);
    const logged = [];
    const viaLink = createUploads({
        api, record, partName: () => PART,
        fsOps: { link: async (a, b) => { await fs.promises.link(a, b); take(b); } },
    });
    const viaReplace = createUploads({
        api, record, partName: () => PART,
        fsOps: { rename: async (a, b) => { await fs.promises.rename(a, b); take(b); } },
    });
    const noLinks = createUploads({
        api, record, partName: () => PART,
        fsOps: {
            link: async () => { throw Object.assign(new Error('not supported'), { code: 'EPERM' }); },
            rename: async (a, b) => { await fs.promises.rename(a, b); take(b); },
        },
    });
    // After a link() the part's name still names this upload's file: the
    // link was right and the file was saved, then taken. A rename leaves
    // no part to ask, so it says neither; Replace says the old file is gone.
    const cases = [
        [viaLink, { name: 'l.txt' }, (error) => {
            assert.match(error, /^l\.txt was saved in .*race-taken, but it was moved or replaced the moment it was put there/);
            assert.doesNotMatch(error, /nothing was saved/);
        }],
        [viaReplace, { name: 'old.txt', onConflict: 'replace' }, (error) => assert.match(error, /was overwritten/)],
        [noLinks, { name: 'n.txt' }, (error) => {
            assert.match(error, /^n\.txt in .*race-taken is not the upload, or is not there/);
            assert.doesNotMatch(error, /nothing was saved|was saved in/);
        }],
    ];
    try {
        for (const [uploads, params, says] of cases) {
            fs.rmSync(away, { force: true });
            fs.writeFileSync(path.join(f.dir, 'old.txt'), 'old');
            await withServer({ uploads, log: (m) => logged.push(m) }, async (url) => {
                const res = await post(url, { dest: 'race-taken', ...params }, 'USER CONTENT');
                assert.strictEqual(res.status, 409, JSON.stringify(params));
                const body = await res.json();
                assert.strictEqual(body.reason, 'changed');
                says(body.error);
            });
            assert.strictEqual(fs.readFileSync(away, 'utf8'), 'USER CONTENT', JSON.stringify(params));
            assert.deepStrictEqual(Object.keys(filesIn(f.dir)).filter((n) => n !== 'old.txt'), [], JSON.stringify(params));
        }
        assert.ok(logged.every((m) => !/temporary file was replaced/.test(m)), logged.join('\n'));
    } finally {
        f.cleanup();
    }
    assert.deepStrictEqual(recorded(), []);
});

test('race: a Replace that put something else in place says the old file is gone, not that nothing was saved', async () => {
    const f = raceFixture('race-replaced');
    const viaReplace = createUploads({
        api, record, partName: () => PART,
        fsOps: { rename: async (a, b) => { fs.unlinkSync(a); fs.writeFileSync(a, 'not the upload'); return fs.promises.rename(a, b); } },
    });
    fs.writeFileSync(path.join(f.dir, 'old.txt'), 'old');
    try {
        await withServer({ uploads: viaReplace }, async (url) => {
            let res = await post(url, { dest: 'race-replaced', name: 'old.txt', onConflict: 'replace' }, 'content');
            assert.strictEqual(res.status, 409);
            let body = await res.json();
            assert.strictEqual(body.reason, 'changed');
            assert.strictEqual(body.replaced, true);
            assert.doesNotMatch(body.error, /nothing was saved/);
            assert.match(body.error, /old\.txt in .*race-replaced was overwritten/);
            assert.match(body.error, /previous old\.txt is gone/);
            // Replace onto a free name overwrote nothing: no such claim.
            res = await post(url, { dest: 'race-replaced', name: 'free.txt', onConflict: 'replace' }, 'content');
            assert.strictEqual(res.status, 409);
            body = await res.json();
            assert.strictEqual(body.reason, 'changed');
            assert.strictEqual(body.replaced, undefined);
            assert.doesNotMatch(body.error, /overwritten|nothing was saved/);
            assert.match(body.error, /^free\.txt in .*race-replaced is not the upload, or is not there/);
        });
    } finally {
        f.cleanup();
    }
    assert.deepStrictEqual(recorded(), []);
});

test('race: a folder swapped for a file, or a link loop, as the part is put in place is a 409, not a 500', async () => {
    const f = raceFixture('race-notdir');
    const away = path.join(base, 'away-race-notdir');
    // ENOTDIR: the folder's path names a regular file now. ELOOP: a link
    // that points at itself.
    const toFile = () => { fs.renameSync(f.dir, away); fs.writeFileSync(f.dir, 'a file now'); };
    const toLoop = () => { fs.renameSync(f.dir, away); fs.symlinkSync(f.dir, f.dir); };
    const restore = () => { fs.rmSync(f.dir, { force: true }); fs.renameSync(away, f.dir); };
    const at = (swap) => [
        [createUploads({ api, record, fsOps: { link: async (a, b) => { swap(); return fs.promises.link(a, b); } } }), { name: 'n.txt' }],
        [createUploads({ api, record, fsOps: { rename: async (a, b) => { swap(); return fs.promises.rename(a, b); } } }),
            { name: 'old.txt', onConflict: 'replace' }],
    ];
    const logged = [];
    try {
        for (const [uploads, params] of [...at(toFile), ...at(toLoop)]) {
            fs.writeFileSync(path.join(f.dir, 'old.txt'), 'old');
            await withServer({ uploads, log: (m) => logged.push(m) }, async (url) => {
                const res = await post(url, { dest: 'race-notdir', ...params }, 'USER CONTENT');
                assert.strictEqual(res.status, 409, JSON.stringify(params));
                assert.strictEqual((await res.json()).reason, 'changed');
            });
            restore();
            // The part went with the folder, out of the unlink's reach:
            // back with it now, emptied through its descriptor.
            const left = filesIn(f.dir);
            const parts = Object.keys(left).filter((n) => /^\.ctp-upload-.*\.part$/.test(n));
            assert.deepStrictEqual(parts.map((n) => left[n]), [''], JSON.stringify(params));
            for (const n of parts) fs.unlinkSync(path.join(f.dir, n));
            assert.deepStrictEqual(filesIn(f.dir), { 'old.txt': 'old' }, JSON.stringify(params));
        }
        assert.ok(logged.some((m) => /ENOTDIR/.test(m)), logged.join('\n'));
        assert.ok(logged.some((m) => /ELOOP/.test(m)), logged.join('\n'));
    } finally {
        if (fs.existsSync(away)) restore();
        f.cleanup();
    }
    assert.deepStrictEqual(partsUnder(), []);
    assert.deepStrictEqual(recorded(), []);
});

test('race: a link loop met just after the file is put in place never says nothing was saved', async () => {
    // The rename or link went through, then the folder became a link that
    // points at itself: the check after it (an lstat of the name) raises
    // ELOOP. A Replace has overwritten the old file by then, and either
    // way the file may be the upload, so "nothing was saved" would be untrue.
    const f = raceFixture('race-afterloop');
    const away = path.join(base, 'away-race-afterloop');
    const toLoop = () => { fs.renameSync(f.dir, away); fs.symlinkSync(f.dir, f.dir); };
    const restore = () => { fs.unlinkSync(f.dir); fs.renameSync(away, f.dir); };
    const viaReplace = createUploads({
        api, record, fsOps: { rename: async (a, b) => { await fs.promises.rename(a, b); toLoop(); } },
    });
    const viaLink = createUploads({
        api, record, fsOps: { link: async (a, b) => { await fs.promises.link(a, b); toLoop(); } },
    });
    const logged = [];
    fs.writeFileSync(path.join(f.dir, 'old.txt'), 'old');
    try {
        await withServer({ uploads: viaReplace, log: (m) => logged.push(m) }, async (url) => {
            const res = await post(url, { dest: 'race-afterloop', name: 'old.txt', onConflict: 'replace' }, 'USER CONTENT');
            assert.strictEqual(res.status, 409);
            const body = await res.json();
            assert.strictEqual(body.reason, 'changed');
            assert.strictEqual(body.replaced, true);
            assert.match(body.error, /old\.txt in .*race-afterloop was overwritten/);
            assert.doesNotMatch(body.error, /nothing was saved/);
        });
        restore();
        assert.deepStrictEqual(filesIn(f.dir), { 'old.txt': 'USER CONTENT' });
        await withServer({ uploads: viaLink, log: (m) => logged.push(m) }, async (url) => {
            const res = await post(url, { dest: 'race-afterloop', name: 'n.txt' }, 'USER CONTENT');
            assert.strictEqual(res.status, 409);
            const body = await res.json();
            assert.strictEqual(body.reason, 'changed');
            assert.strictEqual(body.replaced, undefined);
            assert.match(body.error, /^n\.txt in .*race-afterloop is not the upload/);
            assert.doesNotMatch(body.error, /nothing was saved/);
        });
        restore();
        // Every byte kept. The part went with the folder, out of the
        // unlink's reach: a second name for the file, never emptied.
        const left = filesIn(f.dir);
        assert.strictEqual(left['n.txt'], 'USER CONTENT');
        for (const n of Object.keys(left).filter((n) => /^\.ctp-upload-.*\.part$/.test(n))) {
            assert.strictEqual(left[n], 'USER CONTENT');
            fs.unlinkSync(path.join(f.dir, n));
        }
        assert.ok(logged.some((m) => /ELOOP/.test(m)), logged.join('\n'));
    } finally {
        if (fs.existsSync(away)) restore();
        f.cleanup();
    }
    assert.deepStrictEqual(partsUnder(), []);
    assert.deepStrictEqual(recorded(), []);
});

test('race: a folder moved or swapped for a file just after the link never says nothing was saved', async () => {
    // The link went through; the moment after, the folder is moved away (or
    // a file put at its path). Every check then finds nothing at either name
    // (ENOENT, ENOTDIR), but the moved folder holds the upload.
    const f = raceFixture('race-afterlink');
    const away = path.join(base, 'away-race-afterlink');
    const moves = [
        ['moved', () => fs.renameSync(f.dir, away)],
        ['swapped for a file', () => { fs.renameSync(f.dir, away); fs.writeFileSync(f.dir, 'a file now'); }],
    ];
    try {
        for (const [how, move] of moves) {
            const uploads = createUploads({
                api, record, fsOps: { link: async (a, b) => { await fs.promises.link(a, b); move(); } },
            });
            await withServer({ uploads }, async (url) => {
                const res = await post(url, { dest: 'race-afterlink', name: 'n.txt' }, 'USER CONTENT');
                assert.strictEqual(res.status, 409, how);
                const body = await res.json();
                assert.strictEqual(body.reason, 'changed');
                assert.doesNotMatch(body.error, /nothing was saved/, how);
                assert.match(body.error, /^n\.txt in .*race-afterlink is not the upload, or is not there/, how);
            });
            // Every byte, where the folder went. Its part is a second name
            // for the file, out of the unlink's reach, never emptied.
            const left = filesIn(away);
            assert.strictEqual(left['n.txt'], 'USER CONTENT', how);
            for (const n of Object.keys(left).filter((n) => /^\.ctp-upload-.*\.part$/.test(n))) {
                assert.strictEqual(left[n], 'USER CONTENT', how);
            }
            fs.rmSync(f.dir, { recursive: true, force: true });
            fs.rmSync(away, { recursive: true, force: true });
            fs.mkdirSync(f.dir);
        }
    } finally {
        fs.rmSync(away, { recursive: true, force: true });
        f.cleanup();
    }
    assert.deepStrictEqual(recorded(), []);
});

test('race: any other failure of the check after the file is put in place is no "not saved" refusal', async () => {
    // The lstat of the name after the link or rename fails some other way
    // (EACCES, EIO). FS_REFUSALS words those as "the file was not saved",
    // untrue once it was put in place: the answer says neither, or, for a
    // Replace that overwrote a file, that the old one is gone.
    const f = raceFixture('race-afterfail');
    const failingAfter = (code, place) => {
        let placed = null;
        return createUploads({
            api, record,
            fsOps: {
                [place]: async (a, b) => { await fs.promises[place](a, b); placed = b; },
                lstat: async (p, opts) => {
                    if (p === placed) { placed = null; throw Object.assign(new Error(`${code}: lstat failed`), { code }); }
                    return fs.promises.lstat(p, opts);
                },
            },
        });
    };
    const logged = [];
    fs.writeFileSync(path.join(f.dir, 'old.txt'), 'old');
    try {
        await withServer({ uploads: failingAfter('EACCES', 'link'), log: (m) => logged.push(m) }, async (url) => {
            const res = await post(url, { dest: 'race-afterfail', name: 'n.txt' }, 'USER CONTENT');
            assert.strictEqual(res.status, 409);
            const body = await res.json();
            assert.strictEqual(body.reason, 'changed');
            assert.doesNotMatch(body.error, /not saved|nothing was saved/);
            assert.match(body.error, /^n\.txt in .*race-afterfail is not the upload, or is not there/);
        });
        await withServer({ uploads: failingAfter('EIO', 'rename'), log: (m) => logged.push(m) }, async (url) => {
            const res = await post(url, { dest: 'race-afterfail', name: 'old.txt', onConflict: 'replace' }, 'USER CONTENT');
            assert.strictEqual(res.status, 409);
            const body = await res.json();
            assert.strictEqual(body.replaced, true);
            assert.match(body.error, /old\.txt in .*race-afterfail was overwritten/);
        });
        // both files are the upload, every byte, and no part is left
        assert.deepStrictEqual(filesIn(f.dir), { 'n.txt': 'USER CONTENT', 'old.txt': 'USER CONTENT' });
        assert.ok(logged.some((m) => /EACCES/.test(m)) && logged.some((m) => /EIO/.test(m)), logged.join('\n'));
    } finally {
        f.cleanup();
    }
    assert.deepStrictEqual(recorded(), []);
});

test('race: the part is told apart by its exact inode, never one rounded to a Number', async () => {
    // Inode numbers can be over 2^53, where two of them can round to the
    // same Number. Modelled here: the open part reports, exactly, an inode
    // one past the one at its path; rounded, the two look the same.
    const f = raceFixture('race-bigint');
    const off = createUploads({
        api, record,
        openPart: async (p) => {
            const handle = await openNoFollow(p);
            return {
                stat: async (opts) => {
                    const st = await handle.stat(opts);
                    if (opts && opts.bigint) st.ino += 1n;
                    return st;
                },
                chmod: (m) => handle.chmod(m),
                write: (...args) => handle.write(...args),
                datasync: () => handle.datasync(),
                truncate: (n) => handle.truncate(n),
                close: () => handle.close(),
            };
        },
    });
    try {
        await withServer({ uploads: off }, async (url) => {
            const res = await post(url, { name: 'b.txt', dest: 'race-bigint' }, 'content');
            assert.strictEqual(res.status, 409);
            assert.strictEqual((await res.json()).reason, 'changed');
        });
        assert.strictEqual(fs.existsSync(path.join(f.dir, 'b.txt')), false);
    } finally {
        f.cleanup();
    }
    assert.deepStrictEqual(recorded(), []);
});
