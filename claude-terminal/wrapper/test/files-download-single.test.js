'use strict';

// Files sidebar downloads (files-download.js), part 2 of 4: one file as an
// attachment. Its bytes and headers, names (RFC 6266, forged log lines),
// refusals as JSON, and cleanup: descriptors released on every way a
// transfer ends, idle clients cut off, files that shrink or grow mid-transfer.
// Fixture: files-download-fixture.js.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { createDownloads, sendAttachment, streamBody } = require('../files-download.js');
const {
    root, write, api, withServer, q, aborted, sleep, openFds, until, rawRequest,
} = require('./files-download-fixture.js');

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

const BIG = 'big.bin';
write(BIG, Buffer.alloc(32 * 1024 * 1024, 1));
const bigIno = fs.statSync(path.join(root, BIG)).ino;

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

test('download: the name is taken from the requested path once normalised', async () => {
    await withServer({}, async (url) => {
        for (const [asked, name] of [
            ['configuration.yaml/.', 'configuration.yaml'],
            ['blueprints/../configuration.yaml', 'configuration.yaml'],
            ['blueprints/inside-link.yaml/', 'inside-link.yaml'],
            ['./blueprints/./inside-link.yaml/.', 'inside-link.yaml'],
        ]) {
            const res = await fetch(`${url}/download?path=${q(asked)}`);
            assert.strictEqual(res.status, 200, asked);
            assert.strictEqual(res.headers.get('content-disposition'), `attachment; filename=${name}`, asked);
            assert.strictEqual(await res.text(), 'homeassistant:\n');
        }
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
