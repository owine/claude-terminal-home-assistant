'use strict';

// Files sidebar downloads (files-download.js), part 3 of 4: a folder as a zip.
// The archive itself (entries, mtimes and modes, UTF-8 names, stored or
// deflated), check=1 and HEAD, files that change after planning, read errors,
// clients that leave or stall mid-zip, and the concurrent-zip slots.
// Fixture: files-download-fixture.js.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { createDownloads } = require('../files-download.js');
const {
    root, write, LARGE, BLUEPRINT_NAMES, api, downloads, withServer, q, aborted,
    sleep, openFds, until, rawRequest, unzip, within, noStrays,
} = require('./files-download-fixture.js');

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
        'h.gz', 'i.tgz', 'j.zip', 'k.7z', 'l.xz', 'm.bz2', 'n.zst',
        'o.heic', 'p.avif', 'q.m4a', 'r.aac', 's.ogg', 't.opus', 'u.flac', 'v.webm', 'w.MOV', 'x.rar',
        'y.br', 'z.lz4', 'aa.docx', 'ab.xlsx', 'ac.pptx', 'ad.jar', 'ae.apk'];
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
            unreadableNames: 0,
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

test('sendZip: takes { log, onSettled }, and settles once, after the transfer', async () => {
    const victim = write('blueprints/zz-direct.yaml', 'd'.repeat(64 * 1024));
    let shrink = false;
    const d = createDownloads({ api, beforeStream: async () => { if (shrink) fs.truncateSync(victim, 3); } });
    const logged = [];
    let settled = 0;
    const app = express();
    app.get('/z', async (req, res) => {
        const plan = await d.planZip('blueprints');
        await d.sendZip(plan, req, res, { log: (m) => logged.push(m), onSettled: () => { settled++; } });
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/z`;
    try {
        const entries = await unzip(Buffer.from(await (await fetch(url)).arrayBuffer()));
        assert.ok('blueprints/zz-direct.yaml' in entries);
        assert.ok(await until(() => settled === 1, 1000), `settled ${settled} times`);
        shrink = true;
        assert.strictEqual(await aborted(fetch(url)), true);
        assert.ok(await until(() => settled === 2 && logged.length === 1, 1000), `settled ${settled}, logged ${logged}`);
        assert.match(logged[0], /"blueprints\/zz-direct\.yaml"/);
    } finally {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
        fs.rmSync(victim, { force: true });
    }
});
