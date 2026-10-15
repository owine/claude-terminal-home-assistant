'use strict';

// Files sidebar downloads (files-download.js): one file as an attachment, a
// folder as a zip. What may be read is decided by files-api.js and tested
// there; this file tests what a download adds: the zip plan (tiers, symlinks,
// partial files, the size cap and walk bounds), the response headers, the
// archive itself, and failures after streaming has started.
//
// Fixture: a temporary tree with `config/` standing in for /config and
// `data/` beside it standing in for /data.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { createFilesApi } = require('../files-api.js');
const { createDownloads, createDownloadRouter, MAX_ZIP_BYTES } = require('../files-download.js');
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

// --- the zip plan ---

test('a zip holds the ordinary files under the folder, named below it', async () => {
    const plan = await downloads.planZip('blueprints');
    assert.strictEqual(plan.name, 'blueprints.zip');
    assert.deepStrictEqual(names(plan), BLUEPRINT_NAMES);
    assert.strictEqual(plan.bytes, plan.files.reduce((n, f) => n + f.size, 0));
});

test('a zip leaves out sensitive and never-shown entries, whatever the flag', async () => {
    const all = names(await downloads.planZip('blueprints'));
    for (const gone of ['.env', '.ssh', 'id_rsa', 'repo.git', 'HEAD']) {
        assert.ok(!all.some((n) => n.split('/').includes(gone)), `${gone} zipped`);
    }
});

test('a zip neither follows nor archives symlinks', async () => {
    const all = names(await downloads.planZip('blueprints'));
    for (const link of ['escape.txt', 'inside-link.yaml', 'notes-link']) {
        assert.ok(!all.some((n) => n.split('/').includes(link)), `${link} zipped`);
    }
});

test('a zip leaves out in-flight upload parts', async () => {
    const all = names(await downloads.planZip('blueprints'));
    assert.ok(!all.some((n) => n.endsWith('.part')));
});

test('a zip of the root is named after the root as configured', async () => {
    const plan = await downloads.planZip('');
    assert.strictEqual(plan.name, 'config.zip');
    const all = names(plan);
    assert.ok(all.includes('config/configuration.yaml'));
    assert.ok(all.includes('config/blueprints/large.yaml'));
    assert.ok(!all.some((n) => /\.storage|\.git\/|\.env$|innocent/.test(n)), all.join(', '));
});

test('a FIFO is not zipped (reading it would block)', { skip: process.platform === 'win32' }, async () => {
    const fifo = path.join(root, 'blueprints', 'pipe');
    require('node:child_process').execFileSync('mkfifo', [fifo]);
    try {
        assert.ok(!names(await downloads.planZip('blueprints')).includes('blueprints/pipe'));
    } finally {
        fs.unlinkSync(fifo);
    }
});

test('a backslash in a name is archived as _ (zip names use / only)', async () => {
    write('odd/a\\..\\b.txt', 'odd\n');
    try {
        assert.deepStrictEqual(names(await downloads.planZip('odd')), ['odd/a_.._b.txt']);
    } finally {
        fs.rmSync(path.join(root, 'odd'), { recursive: true });
    }
});

test('zipping a sensitive folder is refused, not an empty archive', async () => {
    await refused(downloads.planZip('.storage'), 403);
    await refused(downloads.planZip('blueprints/.ssh'), 403);
});

test('zipping .git, a file, or a path outside the root is refused', async () => {
    await refused(downloads.planZip('.git'), 404);
    await refused(downloads.planZip('blueprints/repo.git'), 404);
    await refused(downloads.planZip('configuration.yaml'), 400);
    await refused(downloads.planZip('../data'), 404);
    await refused(downloads.planZip('nope'), 404);
});

test('over the size cap: 413, naming the largest files', async () => {
    const capped = createDownloads({ api, maxZipBytes: 1024 });
    await assert.rejects(capped.planZip('blueprints'), (err) => {
        assert.strictEqual(err.status, 413);
        assert.match(err.message, /over the 1\.0 KB zip limit/);
        assert.match(err.message, /Largest: large\.yaml \(4\.0 KB\)/);
        return true;
    });
});

test('the default cap is 200 MB', () => {
    assert.strictEqual(MAX_ZIP_BYTES, 200 * 1024 * 1024);
});

test('a walk that hits a bound is a 413, never a partial zip', async () => {
    const bound = async (opts, pattern) => {
        await assert.rejects(createDownloads({ api, ...opts }).planZip('blueprints'), (err) => {
            assert.strictEqual(err.status, 413);
            assert.match(err.message, pattern);
            return true;
        });
    };
    await bound({ maxVisits: 2 }, /more than 2 entries/);
    await bound({ timeBudgetMs: -1 }, /took too long/);
    await bound({ maxDepth: 0 }, /nested more than 0 folders deep/);
});

test('a bound refusal names the largest files found so far', async () => {
    await assert.rejects(createDownloads({ api, maxDepth: 0 }).planZip('blueprints'), (err) => {
        assert.match(err.message, /Largest so far: large\.yaml \(4\.0 KB\)/);
        return true;
    });
});

test('a *.part folder is not zipped', async () => {
    write('blueprints/upload.part/inner.txt', 'inner');
    try {
        assert.deepStrictEqual(names(await downloads.planZip('blueprints')), BLUEPRINT_NAMES);
    } finally {
        fs.rmSync(path.join(root, 'blueprints', 'upload.part'), { recursive: true });
    }
});

test('a folder swapped for a symlink after it was listed is not entered', async () => {
    const swap = () => {
        fs.rmSync(path.join(root, 'swap'), { recursive: true, force: true });
        write('swap/in.txt', 'in');
        write('swap/sub/inner.txt', 'inner');
    };
    // Runs between a folder being listed and being opened.
    const onListed = async (dir) => {
        if (path.basename(dir) !== 'sub') return;
        fs.rmSync(dir, { recursive: true });
        fs.symlinkSync(outside, dir);
    };
    try {
        swap();
        assert.deepStrictEqual(names(await createDownloads({ api, onListed }).planZip('swap')), ['swap/in.txt']);
        // Nor do the outside names and sizes reach the 413 message.
        swap();
        await assert.rejects(createDownloads({ api, onListed, maxZipBytes: 1 }).planZip('swap'), (err) => {
            assert.strictEqual(err.status, 413);
            assert.ok(!/secret\.txt/.test(err.message), err.message);
            return true;
        });
    } finally {
        fs.rmSync(path.join(root, 'swap'), { recursive: true, force: true });
    }
});

// --- routes ---

async function withServer(options, fn) {
    const app = express();
    app.use('/api/files', createDownloadRouter({
        downloads,
        fileLimiter: createRateLimiter({ max: 1000 }),
        zipLimiter: createRateLimiter({ max: 1000 }),
        log: () => {},
        ...options,
    }));
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

test('download: an attachment with its exact bytes and safe headers', async () => {
    await withServer({}, async (url) => {
        const res = await fetch(`${url}/download?path=${q('with space.yaml')}`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get('content-disposition'), 'attachment; filename="with space.yaml"');
        assert.strictEqual(res.headers.get('content-type'), 'application/octet-stream');
        assert.strictEqual(res.headers.get('content-length'), '5');
        assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
        assert.strictEqual(res.headers.get('cache-control'), 'no-store');
        assert.strictEqual(await res.text(), 'a: 1\n');
    });
});

test('download: a binary file arrives byte for byte', async () => {
    await withServer({}, async (url) => {
        const res = await fetch(`${url}/download?path=image.png`);
        assert.deepStrictEqual(Buffer.from(await res.arrayBuffer()),
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]));
    });
});

test('download: a non-ASCII name gets an ASCII fallback and filename* (RFC 6266)', async () => {
    await withServer({}, async (url) => {
        const res = await fetch(`${url}/download?path=${q('ünïcödé ✂.yaml')}`);
        assert.strictEqual(res.status, 200);
        const header = res.headers.get('content-disposition');
        assert.match(header, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
        assert.ok(header.endsWith(`filename*=UTF-8''${q('ünïcödé ✂.yaml')}`), header);
        await res.arrayBuffer();
    });
});

test('download: an empty file is an empty attachment', async () => {
    await withServer({}, async (url) => {
        const res = await fetch(`${url}/download?path=empty.txt`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get('content-length'), '0');
        assert.strictEqual(await res.text(), '');
    });
});

test('download: protected files need protected=1; .git never downloads', async () => {
    await withServer({}, async (url) => {
        let res = await fetch(`${url}/download?path=.env`);
        assert.strictEqual(res.status, 403);
        assert.match((await res.json()).error, /Show protected files/);
        res = await fetch(`${url}/download?path=innocent.yaml`);
        assert.strictEqual(res.status, 403);
        await res.arrayBuffer();

        res = await fetch(`${url}/download?path=.env&protected=1`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(await res.text(), 'TOKEN=1\n');

        res = await fetch(`${url}/download?path=${q('.git/config')}&protected=1`);
        assert.strictEqual(res.status, 404);
        res = await fetch(`${url}/download?path=${q('../data/secret.txt')}&protected=1`);
        assert.strictEqual(res.status, 404);
        res = await fetch(`${url}/download?path=${q('blueprints/escape.txt')}&protected=1`);
        assert.strictEqual(res.status, 404);
        await res.arrayBuffer();
    });
});

test('download: a folder, a missing file, or a repeated path is a JSON error', async () => {
    await withServer({}, async (url) => {
        let res = await fetch(`${url}/download?path=blueprints`);
        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(await res.json(), { error: 'Not a file' });
        res = await fetch(`${url}/download?path=nope.yaml`);
        assert.strictEqual(res.status, 404);
        await res.arrayBuffer();
        res = await fetch(`${url}/download?path=a&path=b`);
        assert.strictEqual(res.status, 400);
        await res.arrayBuffer();
    });
});

test('download: a file that shrinks mid-download aborts it, and is logged', async () => {
    const file = write('shrinking.txt', 'y'.repeat(256 * 1024));
    const logged = [];
    const shrinking = createDownloads({ api, beforeStream: async () => fs.truncateSync(file, 10) });
    await withServer({ downloads: shrinking, log: (m) => logged.push(m) }, async (url) => {
        assert.strictEqual(await aborted(fetch(`${url}/download?path=shrinking.txt`)), true);
        // the wrapper is still serving
        assert.strictEqual((await fetch(`${url}/download?path=configuration.yaml`)).status, 200);
    });
    assert.ok(logged.some((m) => /shrinking\.txt aborted/.test(m)), logged.join('\n'));
    fs.unlinkSync(file);
});

test('routes: an unexpected error is a 500 JSON, not a thrown exception', async () => {
    const broken = {
        planZip: async () => { throw new TypeError('bug'); },
        openForDownload: async () => { throw new TypeError('bug'); },
    };
    await withServer({ downloads: broken }, async (url) => {
        for (const route of ['download']) {
            const res = await fetch(`${url}/${route}?path=x`);
            assert.strictEqual(res.status, 500);
            assert.deepStrictEqual(await res.json(), { error: 'Internal error' });
        }
    });
});
