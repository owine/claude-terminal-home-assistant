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
const net = require('node:net');
const { once } = require('node:events');
const express = require('express');
const yauzl = require('yauzl');
const yazl = require('yazl');
const { createFilesApi } = require('../files-api.js');
const { createDownloads, createDownloadRouter, sendAttachment, streamBody, MAX_ZIP_BYTES, MAX_CONCURRENT_ZIPS } = require('../files-download.js');
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

test('a folder named like a drive (C:backup) zips under a name yazl accepts', async () => {
    write('C:backup/x.txt', 'x\n');
    write('C:backup/D:sub/y.txt', 'y\n');
    try {
        const plan = await downloads.planZip('C:backup');
        assert.strictEqual(plan.name, 'C_backup.zip');
        assert.deepStrictEqual(names(plan), ['C_backup/D:sub/y.txt', 'C_backup/x.txt']);
        // yazl's own check (validateMetadataPath) passes every planned name,
        // so the preflight and the download cannot disagree.
        const zip = new yazl.ZipFile();
        for (const f of plan.files) zip.addBuffer(Buffer.alloc(0), f.name);
        await withServer({}, async (url) => {
            const check = await fetch(`${url}/download-zip?path=${q('C:backup')}&check=1`);
            assert.strictEqual(check.status, 200);
            assert.strictEqual((await check.json()).name, 'C_backup.zip');
            const res = await fetch(`${url}/download-zip?path=${q('C:backup')}`);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.headers.get('content-disposition'), 'attachment; filename=C_backup.zip');
            const entries = await unzip(Buffer.from(await res.arrayBuffer()));
            assert.deepStrictEqual(Object.keys(entries).sort(), ['C_backup/D:sub/y.txt', 'C_backup/x.txt']);
        });
    } finally {
        fs.rmSync(path.join(root, 'C:backup'), { recursive: true });
    }
});

test('a zip lists each folder\'s files by name, then its folders by name', async () => {
    // Created out of order, so the listing order of the filesystem (hash
    // order on ext4, its own on APFS) would show through.
    const files = ['m.txt', 'B.txt', 'a.txt', 'Z.txt', '10.txt', '2.txt', '_x.txt', 'é.txt', 'q.txt', 'c.txt',
        'k.txt', 'y.txt', 'D.txt', 'f.txt', '0.txt', 'w.txt', 'n.txt', 'h.txt', 'j.txt', 'u.txt'];
    for (const name of files) write(`order/${name}`, name);
    for (const name of ['t.txt', 'b.txt']) write(`order/sub2/${name}`, name);
    for (const name of ['s.txt', 'e.txt']) write(`order/Sub1/${name}`, name);
    try {
        const expected = [
            ...[...files].sort().map((n) => `order/${n}`),
            'order/Sub1/e.txt', 'order/Sub1/s.txt',
            'order/sub2/b.txt', 'order/sub2/t.txt',
        ];
        const plan = await downloads.planZip('order');
        assert.deepStrictEqual(plan.files.map((f) => f.name), expected);
        // And the archive holds them in that order.
        await withServer({}, async (url) => {
            const entries = await unzip(Buffer.from(await (await fetch(`${url}/download-zip?path=order`)).arrayBuffer()));
            assert.deepStrictEqual(Object.keys(entries), expected);
        });
    } finally {
        fs.rmSync(path.join(root, 'order'), { recursive: true });
    }
});

test('zipping a sensitive folder is refused, not an empty archive', async () => {
    await refused(downloads.planZip('.storage'), 403);
    await refused(downloads.planZip('blueprints/.ssh'), 403);
});

test('zipping a sensitive-named symlink to an ordinary folder is refused', async () => {
    const link = path.join(root, '.ssh');
    fs.symlinkSync(path.join(root, 'blueprints', 'notes'), link);
    try {
        await refused(downloads.planZip('.ssh'), 403);
    } finally {
        fs.unlinkSync(link);
    }
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

test('the default cap is 200 MB, and two zips at once', () => {
    assert.strictEqual(MAX_ZIP_BYTES, 200 * 1024 * 1024);
    assert.strictEqual(MAX_CONCURRENT_ZIPS, 2);
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
        assert.ok(await until(() => logged.length > 0, 1000), 'nothing logged');
        // the wrapper is still serving
        assert.strictEqual((await fetch(`${url}/download?path=configuration.yaml`)).status, 200);
    });
    assert.ok(logged.some((m) => /"shrinking\.txt" aborted/.test(m)), logged.join('\n'));
    fs.unlinkSync(file);
});

test('routes: an unexpected error is a 500 JSON, not a thrown exception', async () => {
    const broken = {
        planZip: async () => { throw new TypeError('bug'); },
        openForDownload: async () => { throw new TypeError('bug'); },
    };
    const brokenStream = {
        planZip: async () => ({ name: 'x.zip', files: [], bytes: 0 }),
        sendZip: async () => { throw new TypeError('bug'); },
    };
    await withServer({ downloads: brokenStream }, async (url) => {
        const res = await fetch(`${url}/download-zip?path=x`);
        assert.strictEqual(res.status, 500);
        assert.deepStrictEqual(await res.json(), { error: 'Internal error' });
    });
    await withServer({ downloads: broken }, async (url) => {
        for (const route of ['download', 'download-zip']) {
            const res = await fetch(`${url}/${route}?path=x`);
            assert.strictEqual(res.status, 500);
            assert.deepStrictEqual(await res.json(), { error: 'Internal error' });
        }
    });
});

test('download: a sensitive-named symlink to an ordinary file needs protected=1', async () => {
    const link = path.join(root, 'blueprints', '.env.link');
    fs.symlinkSync(path.join(root, 'with space.yaml'), link);
    try {
        await withServer({}, async (url) => {
            let res = await fetch(`${url}/download?path=${q('blueprints/.env.link')}`);
            assert.strictEqual(res.status, 403);
            await res.arrayBuffer();
            res = await fetch(`${url}/download?path=${q('blueprints/.env.link')}&protected=1`);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(await res.text(), 'a: 1\n');
        });
    } finally {
        fs.unlinkSync(link);
    }
});

// --- cleanup, timeouts, names ---

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

async function until(predicate, ms = 3000) {
    const end = Date.now() + ms;
    while (!predicate() && Date.now() < end) await sleep(20);
    return predicate();
}

const BIG = 'big.bin';
write(BIG, Buffer.alloc(32 * 1024 * 1024, 1));
const bigIno = fs.statSync(path.join(root, BIG)).ino;

function rawRequest(port, target, method = 'GET') {
    return new Promise((resolve) => {
        const sock = net.connect(port, '127.0.0.1', () => {
            sock.write(`${method} ${target} HTTP/1.1\r\nHost: x\r\n\r\n`);
            resolve(sock);
        });
    });
}

const rawGet = (port, target, method = 'GET') => rawRequest(port, `/api/files/download?path=${target}`, method);

test('download: a client that leaves while the file is being opened leaks no descriptor', async () => {
    let entered;
    let left;
    const inBeforeStream = new Promise((r) => { entered = r; });
    const pastBeforeStream = new Promise((r) => { left = r; });
    const d = createDownloads({
        api,
        beforeStream: async () => {
            entered(openFds(bigIno));
            await sleep(300);
            left();
        },
    });
    const logged = [];
    const escapes = [];
    // Nothing may throw out of the route: not synchronously, not as a rejection.
    const stray = [];
    const onStray = (err) => stray.push(err);
    process.on('uncaughtException', onStray);
    process.on('unhandledRejection', onStray);
    try {
        await withServer({ downloads: d, escapes, log: (m) => logged.push(m) }, async (url) => {
            const sock = await rawGet(Number(new URL(url).port), BIG);
            // Positive control: the file is open while the request waits.
            assert.strictEqual(await inBeforeStream, 1);
            sock.destroy();
            await pastBeforeStream;
            assert.ok(await until(() => openFds(bigIno) === 0, 1000), 'descriptor left open');
            // still serving
            assert.strictEqual((await fetch(`${url}/download?path=configuration.yaml`)).status, 200);
        });
    } finally {
        process.off('uncaughtException', onStray);
        process.off('unhandledRejection', onStray);
    }
    assert.deepStrictEqual(escapes.map((e) => e.code || String(e)), []);
    assert.deepStrictEqual(stray.map(String), []);
});

test('download: a client that leaves mid-transfer releases the descriptor, quietly', async () => {
    const logged = [];
    const escapes = [];
    await withServer({ escapes, log: (m) => logged.push(m) }, async (url) => {
        const sock = await rawGet(Number(new URL(url).port), BIG);
        await once(sock, 'data');
        assert.ok(openFds(bigIno) >= 1, 'not streaming');
        sock.destroy();
        assert.ok(await until(() => openFds(bigIno) === 0), 'descriptor left open');
        await sleep(100);   // the pipeline has settled; now it must not have logged
    });
    assert.deepStrictEqual(logged, []);
    assert.deepStrictEqual(escapes.map((e) => e.code || String(e)), []);
});

test('download: a client that stops reading is cut off after idleMs and its descriptor closed', async () => {
    const d = createDownloads({ api, idleMs: 300 });
    const logged = [];
    await withServer({ downloads: d, log: (m) => logged.push(m) }, async (url) => {
        const sock = await rawGet(Number(new URL(url).port), BIG);
        sock.pause();
        assert.ok(await until(() => openFds(bigIno) === 1, 2000), 'positive control: the file is open');
        assert.ok(await until(() => openFds(bigIno) === 0, 4000), 'stalled download kept its descriptor');
        sock.destroy();
        assert.ok(await until(() => logged.length > 0, 1000), 'nothing logged');
        await sleep(100);   // and nothing more
    });
    // One quiet line, so a proxy that stops reading can be diagnosed.
    assert.deepStrictEqual(logged, ['Download of "big.bin" cut off: client stalled for 300 ms']);
});

test('download: a file that grows is cut at the announced length', async () => {
    const file = write('growing.txt', 'g'.repeat(1000));
    const growing = createDownloads({ api, beforeStream: async () => fs.appendFileSync(file, 'MORE'.repeat(500)) });
    await withServer({ downloads: growing }, async (url) => {
        const res = await fetch(`${url}/download?path=growing.txt`);
        assert.strictEqual(res.headers.get('content-length'), '1000');
        assert.strictEqual((await res.text()), 'g'.repeat(1000));
    });
    fs.unlinkSync(file);
});

test('download: a quote or newline in the name cannot break the header', async () => {
    const name = 'a"b\nc.txt';
    const file = write(name, 'z');
    await withServer({}, async (url) => {
        const res = await fetch(`${url}/download?path=${q(name)}`);
        assert.strictEqual(res.status, 200);
        const header = res.headers.get('content-disposition');
        assert.doesNotMatch(header, /[\r\n]/);
        assert.match(header, /^attachment; filename="[^"\\]*(\\.[^"\\]*)*"/);
        assert.ok(header.endsWith(`filename*=UTF-8''${q(name)}`.replace(/%22/g, '%22')), header);
        await res.arrayBuffer();
    });
    fs.unlinkSync(file);
});

test('download: HEAD sends the headers and no body, and closes the file', async () => {
    await withServer({}, async (url) => {
        const res = await fetch(`${url}/download?path=${BIG}`, { method: 'HEAD' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get('content-length'), String(32 * 1024 * 1024));
        assert.match(res.headers.get('content-disposition'), /big\.bin/);
        assert.strictEqual((await res.arrayBuffer()).byteLength, 0);
        assert.ok(await until(() => openFds(bigIno) === 0), 'descriptor left open');
    });
});

test('download: a symlink downloads under the name that was asked for', async () => {
    await withServer({}, async (url) => {
        const res = await fetch(`${url}/download?path=${q('blueprints/inside-link.yaml')}`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get('content-disposition'), 'attachment; filename=inside-link.yaml');
        assert.strictEqual(await res.text(), 'homeassistant:\n');
    });
});

test('download: a name in the log cannot forge a line', async () => {
    const name = 'forge\nDownload of x aborted.txt';
    const file = write(name, 'y'.repeat(256 * 1024));
    const logged = [];
    const shrinking = createDownloads({ api, beforeStream: async () => fs.truncateSync(file, 10) });
    await withServer({ downloads: shrinking, log: (m) => logged.push(m) }, async (url) => {
        assert.strictEqual(await aborted(fetch(`${url}/download?path=${q(name)}`)), true);
        // The pipeline's callback logs after the client has seen the abort.
        assert.ok(await until(() => logged.length > 0, 1000), 'nothing logged');
    });
    assert.ok(logged.length > 0 && logged.every((m) => !m.includes('\n')), JSON.stringify(logged));
    fs.unlinkSync(file);
});

test('download: a refusal is JSON, never saved as an attachment', async () => {
    await withServer({}, async (url) => {
        const res = await fetch(`${url}/download?path=${q('blueprints/automation/.env')}`);
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.headers.get('content-disposition'), null);
        assert.match(res.headers.get('content-type'), /json/);
        assert.match((await res.json()).error, /to download it/);
    });
});

test('sendAttachment: a failure while setting up the response sends JSON without attachment headers', async () => {
    const stat = { size: 5 };
    const closed = [];
    const handle = {
        close: async () => { closed.push(1); },
        createReadStream: () => { throw new Error('no stream'); },
    };
    const app = express();
    app.get('/x', (req, res) => sendAttachment({ handle, stat, name: 'f.txt' }, req, res, { log: () => {} }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/x`);
        assert.strictEqual(res.status, 500);
        assert.strictEqual(res.headers.get('content-disposition'), null);
        assert.deepStrictEqual(await res.json(), { error: 'Internal error' });
        assert.ok(closed.length >= 1, 'handle not closed');
    } finally {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
    }
});

test('streamBody: runs its cleanup when the response is already gone, and builds nothing', () => {
    let made = 0;
    let released = 0;
    streamBody({ destroyed: true }, {
        makeSource: () => { made++; },
        release: () => { released++; },
    });
    assert.strictEqual(made, 0);
    assert.strictEqual(released, 1);
});

// --- zip ---

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

test('zip: the archive unzips to the planned entries and their contents', async () => {
    await withServer({}, async (url) => {
        const res = await fetch(`${url}/download-zip?path=blueprints`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get('content-type'), 'application/zip');
        assert.strictEqual(res.headers.get('content-disposition'), 'attachment; filename=blueprints.zip');
        assert.strictEqual(res.headers.get('cache-control'), 'no-store');
        assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
        const entries = await unzip(Buffer.from(await res.arrayBuffer()));
        assert.deepStrictEqual(Object.keys(entries).sort(), BLUEPRINT_NAMES);
        assert.strictEqual(entries['blueprints/automation/motion.yaml'].toString(), 'blueprint: motion\n');
        assert.strictEqual(entries['blueprints/large.yaml'].toString(), LARGE);
        assert.strictEqual(entries['blueprints/empty.yaml'].length, 0);
    });
});

test('zip: entries keep the planned mtime and mode', async () => {
    const file = write('stamped/old.yaml', 'old\n');
    const when = new Date('2024-01-02T03:04:05Z');
    fs.utimesSync(file, when, when);
    fs.chmodSync(file, 0o640);
    try {
        await withServer({}, async (url) => {
            const meta = {};
            await unzip(Buffer.from(await (await fetch(`${url}/download-zip?path=stamped`)).arrayBuffer()), { meta });
            const entry = meta['stamped/old.yaml'];
            assert.strictEqual(entry.getLastModDate().getTime(), when.getTime());
            assert.strictEqual(entry.externalFileAttributes >>> 16, fs.statSync(file).mode);
            assert.strictEqual((entry.externalFileAttributes >>> 16) & 0o777, 0o640);
        });
    } finally {
        fs.rmSync(path.join(root, 'stamped'), { recursive: true });
    }
});

test('zip: a non-ASCII folder gets filename* and UTF-8 entry names', async () => {
    const folder = 'ünïcödé ✂';
    write(`${folder}/naïve.txt`, 'n\n');
    try {
        await withServer({}, async (url) => {
            const res = await fetch(`${url}/download-zip?path=${q(folder)}`);
            assert.strictEqual(res.status, 200);
            const header = res.headers.get('content-disposition');
            assert.match(header, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
            assert.ok(header.endsWith(`filename*=UTF-8''${q(`${folder}.zip`)}`), header);
            const entries = await unzip(Buffer.from(await res.arrayBuffer()));
            assert.deepStrictEqual(Object.keys(entries), [`${folder}/naïve.txt`]);
        });
    } finally {
        fs.rmSync(path.join(root, folder), { recursive: true });
    }
});

test('zip: already-compressed files are stored, everything else deflated', async () => {
    const stored = ['photo.JPG', 'a.jpeg', 'b.png', 'c.webp', 'd.gif', 'e.mp3', 'f.mp4', 'g.mkv',
        'h.gz', 'i.tgz', 'j.zip', 'k.7z', 'l.xz', 'm.bz2', 'n.zst'];
    for (const name of stored) write(`media/${name}`, 'm'.repeat(1024));
    write('media/notes.txt', 'n'.repeat(1024));
    write('media/png.txt', 'p'.repeat(1024));   // the extension, not a substring
    try {
        await withServer({}, async (url) => {
            const meta = {};
            const entries = await unzip(Buffer.from(await (await fetch(`${url}/download-zip?path=media`)).arrayBuffer()), { meta });
            for (const name of stored) {
                assert.strictEqual(meta[`media/${name}`].compressionMethod, 0, `${name} deflated`);
                assert.strictEqual(entries[`media/${name}`].toString(), 'm'.repeat(1024));
            }
            assert.strictEqual(meta['media/notes.txt'].compressionMethod, 8);
            assert.strictEqual(meta['media/png.txt'].compressionMethod, 8);
            assert.strictEqual(entries['media/notes.txt'].toString(), 'n'.repeat(1024));
        });
    } finally {
        fs.rmSync(path.join(root, 'media'), { recursive: true });
    }
});

test('zip: a folder with no files is an empty archive', async () => {
    fs.mkdirSync(path.join(root, 'hollow', 'inner'), { recursive: true });
    try {
        await withServer({}, async (url) => {
            const res = await fetch(`${url}/download-zip?path=hollow`);
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(await unzip(Buffer.from(await res.arrayBuffer())), {});
        });
    } finally {
        fs.rmSync(path.join(root, 'hollow'), { recursive: true });
    }
});

test('zip: protected=1 changes nothing', async () => {
    await withServer({}, async (url) => {
        let res = await fetch(`${url}/download-zip?path=.storage&protected=1`);
        assert.strictEqual(res.status, 403);
        await res.arrayBuffer();
        res = await fetch(`${url}/download-zip?path=blueprints&protected=1`);
        const entries = await unzip(Buffer.from(await res.arrayBuffer()));
        assert.deepStrictEqual(Object.keys(entries).sort(), BLUEPRINT_NAMES);
    });
});

test('zip: check=1 answers the plan as JSON, without streaming', async () => {
    await withServer({}, async (url) => {
        const res = await fetch(`${url}/download-zip?path=blueprints&check=1`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get('content-disposition'), null);
        const plan = await res.json();
        assert.deepStrictEqual(plan, {
            name: 'blueprints.zip',
            files: BLUEPRINT_NAMES.length,
            bytes: (await downloads.planZip('blueprints')).bytes,
        });
    });
});

test('zip: over the cap is a 413 JSON error before any zip bytes', async () => {
    const capped = createDownloads({ api, maxZipBytes: 1024 });
    await withServer({ downloads: capped }, async (url) => {
        for (const check of ['', '&check=1']) {
            const res = await fetch(`${url}/download-zip?path=blueprints${check}`);
            assert.strictEqual(res.status, 413);
            assert.match(res.headers.get('content-type'), /^application\/json/);
            assert.strictEqual(res.headers.get('content-disposition'), null);
            assert.match((await res.json()).error, /large\.yaml/);
        }
    });
});

test('zip: HEAD sends the headers and opens nothing', async () => {
    let opened = 0;
    const counting = createDownloads({ api: { ...api, openFile: (...a) => { opened++; return api.openFile(...a); } } });
    await withServer({ downloads: counting }, async (url) => {
        const res = await fetch(`${url}/download-zip?path=blueprints`, { method: 'HEAD' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get('content-disposition'), 'attachment; filename=blueprints.zip');
        assert.strictEqual((await res.arrayBuffer()).byteLength, 0);
    });
    assert.strictEqual(opened, 0);
});

test('zip: a file deleted after planning aborts the download; nothing throws', async () => {
    const victim = write('blueprints/zz-vanishing.yaml', 'v\n');
    const logged = [];
    const escapes = [];
    const vanishing = createDownloads({ api, beforeStream: async () => fs.unlinkSync(victim) });
    try {
        await noStrays(async () => {
            await withServer({ downloads: vanishing, escapes, log: (m) => logged.push(m) }, async (url) => {
                assert.strictEqual(await aborted(fetch(`${url}/download-zip?path=blueprints`)), true);
                // The log names the file, not just the zip.
                assert.ok(await until(() => logged.some((m) => /"blueprints\.zip" aborted: "blueprints\/zz-vanishing\.yaml": /.test(m)), 1000),
                    logged.join('\n'));
                assert.strictEqual((await fetch(`${url}/download-zip?path=blueprints&check=1`)).status, 200);
            });
        });
        assert.deepStrictEqual(escapes.map(String), []);
    } finally {
        fs.rmSync(victim, { force: true });
    }
});

test('zip: a file that shrinks after planning aborts the download (yazl\'s error event is heard)', async () => {
    const file = write('blueprints/zz-shrinking.yaml', 'z'.repeat(64 * 1024));
    const logged = [];
    const escapes = [];
    const shrinking = createDownloads({ api, beforeStream: async () => fs.truncateSync(file, 3) });
    try {
        await noStrays(async () => {
            await withServer({ downloads: shrinking, escapes, log: (m) => logged.push(m) }, async (url) => {
                assert.strictEqual(await aborted(fetch(`${url}/download-zip?path=blueprints`)), true);
                assert.ok(await until(() => logged.some((m) => /"blueprints\.zip" aborted: "blueprints\/zz-shrinking\.yaml": .*unexpected number of bytes/.test(m)), 1000),
                    logged.join('\n'));
                // still serving
                assert.strictEqual((await fetch(`${url}/download-zip?path=blueprints&check=1`)).status, 200);
            });
        });
        assert.deepStrictEqual(escapes.map(String), []);
    } finally {
        fs.unlinkSync(file);
    }
});

test('zip: a file name in the abort log cannot forge a line', async () => {
    const file = write('forge/a\nDownload of x aborted.txt', 'f'.repeat(64 * 1024));
    const logged = [];
    const shrinking = createDownloads({ api, beforeStream: async () => fs.truncateSync(file, 3) });
    try {
        await withServer({ downloads: shrinking, log: (m) => logged.push(m) }, async (url) => {
            assert.strictEqual(await aborted(fetch(`${url}/download-zip?path=forge`)), true);
            assert.ok(await until(() => logged.length > 0, 1000), 'nothing logged');
        });
        assert.ok(logged.every((m) => !m.includes('\n')), JSON.stringify(logged));
        assert.match(logged[0], /aborted: "forge\/a\\nDownload of x aborted\.txt": /);
    } finally {
        fs.rmSync(path.join(root, 'forge'), { recursive: true });
    }
});

test('zip: a file that grows after planning goes in at its planned size', async () => {
    const file = write('blueprints/zz-growing.log', 'line 1\n');
    const growing = createDownloads({ api, beforeStream: async () => fs.appendFileSync(file, 'line 2\n') });
    try {
        await withServer({ downloads: growing }, async (url) => {
            const res = await fetch(`${url}/download-zip?path=blueprints`);
            const entries = await unzip(Buffer.from(await res.arrayBuffer()));
            assert.strictEqual(entries['blueprints/zz-growing.log'].toString(), 'line 1\n');
        });
    } finally {
        fs.unlinkSync(file);
    }
});

test('zip: an empty file that has gone since planning aborts the download too', async () => {
    const victim = write('blueprints/zz-empty-vanishing.yaml', '');
    const logged = [];
    const vanishing = createDownloads({ api, beforeStream: async () => fs.unlinkSync(victim) });
    try {
        await noStrays(async () => {
            await withServer({ downloads: vanishing, log: (m) => logged.push(m) }, async (url) => {
                assert.strictEqual(await aborted(fetch(`${url}/download-zip?path=blueprints`)), true);
                assert.ok(await until(() => logged.some((m) => /"blueprints\.zip" aborted/.test(m)), 1000), logged.join('\n'));
            });
        });
    } finally {
        fs.rmSync(victim, { force: true });
    }
});

// Several big files of random bytes (deflate cannot shrink them), so a zip of
// the folder is long enough to leave, stall or fail in the middle of, and its
// entries are opened in turn.
const ZIPDIR = 'zipdir';
const ZIP_FILES = ['a.bin', 'b.bin', 'c.bin'];
const zipInos = ZIP_FILES.map((name) => {
    const full = write(`${ZIPDIR}/${name}`, require('node:crypto').randomBytes(8 * 1024 * 1024));
    return fs.statSync(full).ino;
});
const zipFds = () => zipInos.reduce((n, ino) => n + openFds(ino), 0);
const zipTarget = `/api/files/download-zip?path=${ZIPDIR}`;

test('zip: a read error on an entry aborts the download; nothing throws', async () => {
    // yazl pipes an entry's stream without listening for its errors.
    let failed = 0;
    const failing = {
        ...api,
        openFile: async (...args) => {
            const opened = await api.openFile(...args);
            const real = opened.handle.createReadStream.bind(opened.handle);
            opened.handle.createReadStream = (options) => {
                const stream = real(options);
                stream.once('data', () => {
                    failed++;
                    stream.destroy(Object.assign(new Error('simulated EIO'), { code: 'EIO' }));
                });
                return stream;
            };
            return opened;
        },
    };
    const logged = [];
    const escapes = [];
    await noStrays(async () => {
        await withServer({ downloads: createDownloads({ api: failing }), escapes, log: (m) => logged.push(m) }, async (url) => {
            assert.strictEqual(await aborted(fetch(`${url}/download-zip?path=${ZIPDIR}`)), true);
            assert.ok(await until(() => zipFds() === 0), 'descriptor left open');
            assert.ok(await until(() => logged.some((m) => /"zipdir\.zip" aborted: "zipdir\/a\.bin": simulated EIO/.test(m)), 1000),
                logged.join('\n'));
        });
    });
    assert.ok(failed >= 1, 'the fault was never injected');
    assert.deepStrictEqual(escapes.map(String), []);
});

test('zip: entries open one at a time, and a client that leaves mid-zip releases them, quietly', async () => {
    const logged = [];
    const escapes = [];
    await noStrays(async () => {
        await withServer({ escapes, log: (m) => logged.push(m) }, async (url) => {
            const sock = await rawRequest(Number(new URL(url).port), zipTarget);
            let most = 0;
            // Read until the zip has moved past its first file. That means
            // deflating all of a.bin (8 MB of random bytes, deflate's worst
            // case) first, which takes far longer on a slow aarch64 runner.
            await within(new Promise((resolve) => {
                sock.on('data', () => {
                    const counts = zipInos.map(openFds);
                    most = Math.max(most, counts.reduce((x, y) => x + y, 0));
                    if (counts.slice(1).some((n) => n > 0)) {
                        sock.pause();
                        resolve();
                    }
                });
            }), 'the zip to reach its second file', 30000);
            assert.strictEqual(most, 1, 'more than one entry open at once');
            // Let the server back up behind the paused client, as it does
            // behind a slow one: a back-pressured entry stream left alone
            // would hold its descriptor for good.
            await sleep(200);
            // Positive control: an entry is open when the client leaves.
            assert.strictEqual(zipFds(), 1, 'not streaming');
            sock.destroy();
            assert.ok(await until(() => zipFds() === 0), 'descriptor left open');
            await sleep(300);
            assert.strictEqual(zipFds(), 0, 'a later entry was opened after the client left');
        });
    });
    assert.deepStrictEqual(logged, []);
    assert.deepStrictEqual(escapes.map(String), []);
});

test('zip: a client that leaves while an entry is being opened leaks no descriptor', async () => {
    let entered;
    const inOpen = new Promise((r) => { entered = r; });
    const slow = {
        ...api,
        // The descriptor is open; the route has not had it back yet.
        openFile: async (...args) => {
            const opened = await api.openFile(...args);
            entered();
            await sleep(300);
            return opened;
        },
    };
    const escapes = [];
    await noStrays(async () => {
        await withServer({ downloads: createDownloads({ api: slow }), escapes }, async (url) => {
            const sock = await rawRequest(Number(new URL(url).port), zipTarget);
            await within(inOpen, 'an entry being opened');
            assert.strictEqual(zipFds(), 1, 'positive control: the entry is open');
            sock.destroy();
            await sleep(400);   // past the open
            assert.ok(await until(() => zipFds() === 0, 1000), 'descriptor left open');
        });
    });
    assert.deepStrictEqual(escapes.map(String), []);
});

test('zip: a client that leaves before streaming starts opens nothing', async () => {
    let entered;
    let left;
    const inBeforeStream = new Promise((r) => { entered = r; });
    const pastBeforeStream = new Promise((r) => { left = r; });
    let opened = 0;
    const d = createDownloads({
        api: { ...api, openFile: (...a) => { opened++; return api.openFile(...a); } },
        beforeStream: async () => {
            entered();
            await sleep(300);
            left();
        },
    });
    const escapes = [];
    await noStrays(async () => {
        await withServer({ downloads: d, escapes }, async (url) => {
            const sock = await rawRequest(Number(new URL(url).port), zipTarget);
            await within(inBeforeStream, 'beforeStream');
            sock.destroy();
            await within(pastBeforeStream, 'beforeStream to return');
            await sleep(100);
            assert.strictEqual(zipFds(), 0);
            // still serving
            assert.strictEqual((await fetch(`${url}/download-zip?path=blueprints&check=1`)).status, 200);
        });
    });
    assert.strictEqual(opened, 0);
    assert.deepStrictEqual(escapes.map(String), []);
});

test('zip: a client that stops reading is cut off after idleMs, its entry closed, with one log line', async () => {
    const logged = [];
    const d = createDownloads({ api, idleMs: 300 });
    await noStrays(async () => {
        await withServer({ downloads: d, log: (m) => logged.push(m) }, async (url) => {
            const sock = await rawRequest(Number(new URL(url).port), zipTarget);
            sock.pause();
            assert.ok(await until(() => zipFds() === 1, 2000), 'positive control: an entry is open');
            assert.ok(await until(() => zipFds() === 0, 4000), 'stalled zip kept its descriptor');
            assert.ok(await until(() => logged.length > 0, 1000), 'nothing logged');
            await sleep(300);
            assert.strictEqual(zipFds(), 0, 'a later entry was opened after the cut-off');
            sock.destroy();
        });
    });
    assert.strictEqual(logged.length, 1, logged.join('\n'));
    assert.match(logged[0], /^Download of "zipdir\.zip" cut off: client stalled/);
});

test('zip: at most two at once; a third is a 429 before any planning', async () => {
    let planned = 0;
    const counting = { ...downloads, planZip: (...a) => { planned++; return downloads.planZip(...a); } };
    await withServer({ downloads: counting, maxZips: 2 }, async (url) => {
        const port = Number(new URL(url).port);
        // Two stalled clients hold their zips open.
        const held = [await rawRequest(port, zipTarget), await rawRequest(port, zipTarget)];
        for (const sock of held) sock.pause();
        try {
            assert.ok(await until(() => zipFds() === 2, 3000), 'positive control: two zips streaming');
            const before = planned;
            for (const extra of ['', '&check=1']) {
                const res = await fetch(`${url}/download-zip?path=blueprints${extra}`);
                assert.strictEqual(res.status, 429);
                assert.match(res.headers.get('content-type'), /^application\/json/);
                assert.strictEqual(res.headers.get('content-disposition'), null);
                assert.match((await res.json()).error, /2 zips are already being prepared or sent/);
            }
            assert.strictEqual(planned, before, 'a refused zip was planned');
            // One finishes (its client leaves); a new zip gets its slot.
            held.shift().destroy();
            assert.ok(await until(() => zipFds() === 1, 3000), 'the zip left behind kept its descriptor');
            let res;
            const end = Date.now() + 3000;
            do {
                res = await fetch(`${url}/download-zip?path=blueprints`);
                if (res.status === 429) await res.arrayBuffer();
            } while (res.status === 429 && Date.now() < end && (await sleep(20), true));
            assert.strictEqual(res.status, 200);
            const entries = await unzip(Buffer.from(await res.arrayBuffer()));
            assert.deepStrictEqual(Object.keys(entries).sort(), BLUEPRINT_NAMES);
        } finally {
            for (const sock of held) sock.destroy();
        }
    });
});

test('zip: every way a zip ends frees its slot', async () => {
    const victim = path.join(root, 'blueprints', 'zz-slot.yaml');
    let next = null;   // what beforeStream does to the next zip
    const d = createDownloads({
        api,
        beforeStream: async () => {
            const what = next;
            next = null;
            if (what === 'throw') throw new Error('beforeStream failed');
            if (what === 'shrink') fs.truncateSync(victim, 3);
        },
    });
    // With one slot, a zip that kept it would turn the next request away.
    // The slot is freed when the transfer settles, which may trail the
    // client by a moment, so a 429 is retried briefly.
    const status = async (u, init) => {
        const end = Date.now() + 1000;
        for (;;) {
            const res = await fetch(u, init);
            await res.arrayBuffer();
            if (res.status !== 429 || Date.now() > end) return res.status;
            await sleep(20);
        }
    };
    try {
        await withServer({ downloads: d, maxZips: 1 }, async (url) => {
            assert.strictEqual(await status(`${url}/download-zip?path=nope`), 404);
            assert.strictEqual(await status(`${url}/download-zip?path=.storage`), 403);
            assert.strictEqual(await status(`${url}/download-zip?path=blueprints&check=1`), 200);
            assert.strictEqual(await status(`${url}/download-zip?path=blueprints`, { method: 'HEAD' }), 200);
            next = 'throw';
            assert.strictEqual(await status(`${url}/download-zip?path=blueprints`), 500);
            assert.strictEqual(await status(`${url}/download-zip?path=blueprints`), 200);
            // A transfer that aborts mid-stream.
            write('blueprints/zz-slot.yaml', 'z'.repeat(64 * 1024));
            next = 'shrink';
            assert.strictEqual(await aborted(fetch(`${url}/download-zip?path=blueprints`)), true);
            fs.rmSync(victim, { force: true });
            assert.strictEqual(await status(`${url}/download-zip?path=blueprints&check=1`), 200);
        });
    } finally {
        fs.rmSync(victim, { force: true });
    }
});

test('routes: the zip rate limiter applies', async () => {
    await withServer({ zipLimiter: createRateLimiter({ max: 1 }) }, async (url) => {
        assert.strictEqual((await fetch(`${url}/download-zip?path=blueprints&check=1`)).status, 200);
        assert.strictEqual((await fetch(`${url}/download-zip?path=blueprints&check=1`)).status, 429);
    });
});
