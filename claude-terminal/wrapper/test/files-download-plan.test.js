'use strict';

// Files sidebar downloads (files-download.js), part 1 of 4: the zip plan.
// What a folder's zip holds (tiers, symlinks, upload parts, odd names), the
// size cap and the walk's bounds. What may be read at all is decided by
// files-api.js and tested there. The others: files-download-single (one file
// as an attachment), files-download-zip (the archive and its transfer) and
// files-download-guards (who may start a download). Their shared fixture is
// files-download-fixture.js.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const yazl = require('yazl');
const { createDownloads, MAX_ZIP_BYTES, MAX_CONCURRENT_ZIPS } = require('../files-download.js');
const {
    root, outside, write, BLUEPRINT_NAMES, api, downloads, refused, names, withServer, q, unzip,
} = require('./files-download-fixture.js');

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

test('a symlinked folder zips under the name that was asked for, not its target\'s', async () => {
    write('link-target/a.txt', 'a\n');
    write('link-target/sub/b.txt', 'b\n');
    fs.symlinkSync(path.join(root, 'link-target'), path.join(root, 'link'));
    fs.symlinkSync(path.join(root, 'link-target'), path.join(root, 'C:lnk'));
    try {
        const plan = await downloads.planZip('link');
        assert.strictEqual(plan.name, 'link.zip');
        assert.deepStrictEqual(names(plan), ['link/a.txt', 'link/sub/b.txt']);
        // The name is the requested path's, normalised, with the same
        // treatment as a real folder's: a drive letter becomes C_.
        assert.strictEqual((await downloads.planZip('link/')).name, 'link.zip');
        assert.strictEqual((await downloads.planZip('link/.')).name, 'link.zip');
        assert.strictEqual((await downloads.planZip(path.join(root, 'link'))).name, 'link.zip');
        assert.deepStrictEqual(names(await downloads.planZip('C:lnk')), ['C_lnk/a.txt', 'C_lnk/sub/b.txt']);
        // A path that normalises to a real folder is named after it.
        assert.strictEqual((await downloads.planZip('link/sub/..')).name, 'link.zip');
        assert.strictEqual((await downloads.planZip('blueprints/..')).name, 'config.zip');
        await withServer({}, async (url) => {
            const check = await fetch(`${url}/download-zip?path=link&check=1`);
            assert.strictEqual(check.status, 200);
            assert.strictEqual((await check.json()).name, 'link.zip');
            const res = await fetch(`${url}/download-zip?path=link`);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.headers.get('content-disposition'), 'attachment; filename=link.zip');
            const entries = await unzip(Buffer.from(await res.arrayBuffer()));
            assert.deepStrictEqual(Object.keys(entries).sort(), ['link/a.txt', 'link/sub/b.txt']);
        });
    } finally {
        fs.unlinkSync(path.join(root, 'link'));
        fs.unlinkSync(path.join(root, 'C:lnk'));
        fs.rmSync(path.join(root, 'link-target'), { recursive: true });
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

test('an upload-part folder is not zipped; another *.part folder is', async () => {
    write('blueprints/.ctp-upload-0a1b2c3d4e5f6a7b.part/inner.txt', 'inner');
    write('blueprints/mine.part/inner.txt', 'inner');
    try {
        assert.deepStrictEqual(names(await downloads.planZip('blueprints')),
            [...BLUEPRINT_NAMES, 'blueprints/mine.part/inner.txt'].sort());
    } finally {
        fs.rmSync(path.join(root, 'blueprints', '.ctp-upload-0a1b2c3d4e5f6a7b.part'), { recursive: true });
        fs.rmSync(path.join(root, 'blueprints', 'mine.part'), { recursive: true });
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
