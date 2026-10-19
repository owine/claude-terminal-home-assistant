'use strict';

// The upload part record (upload-parts.js): rewritten whole and in order as
// uploads come and go, and at startup the parts an earlier run left are
// deleted - only those the record names, only while they are still regular
// files named like parts, in a real folder inside the root.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPartRecord } = require('../upload-parts.js');

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'upload-parts-')));
const root = path.join(base, 'config');
fs.mkdirSync(root);
after(() => fs.rmSync(base, { recursive: true, force: true }));

function write(rel, content = 'x', at = root) {
    const full = path.join(at, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
}

test('startup removes the parts the record names, and nothing else', async () => {
    const r = path.join(base, 'sweep');
    const conf = path.join(r, 'config');
    const stale = write('a/.ctp-upload-0123456789abcdef.part', 'stale', conf);
    const unrecorded = write('a/.ctp-upload-fedcba9876543210.part', 'not recorded', conf);
    const notAPart = write('a/notes.part', 'a user file', conf);
    const outsidePart = write('.ctp-upload-1111111111111111.part', 'outside the root', path.join(r, 'elsewhere'));
    fs.mkdirSync(path.join(conf, 'b'));
    fs.symlinkSync(path.join(r, 'elsewhere'), path.join(conf, 'b', 'link'));
    const viaLink = path.join(conf, 'b', 'link', '.ctp-upload-1111111111111111.part');
    // named like parts, but a link and a folder: only regular files go
    const linkPart = path.join(conf, 'a', '.ctp-upload-4444444444444444.part');
    fs.symlinkSync(path.join(r, 'elsewhere', '.ctp-upload-1111111111111111.part'), linkPart);
    const dirPart = path.join(conf, 'a', '.ctp-upload-5555555555555555.part');
    fs.mkdirSync(dirPart);
    const file = path.join(r, 'upload-parts');
    fs.writeFileSync(file, JSON.stringify([stale, notAPart, outsidePart, viaLink, linkPart, dirPart, path.join(conf, 'a', 'gone.part'),
        path.join(conf, 'a', '.ctp-upload-2222222222222222.part'), 'relative/.ctp-upload-3333333333333333.part', 42]));
    const logged = [];
    const sweeper = createPartRecord({ file, root: conf, log: (m) => logged.push(m) });
    assert.strictEqual(await sweeper.start(), 1);
    assert.strictEqual(fs.existsSync(stale), false);
    for (const kept of [unrecorded, notAPart, outsidePart, dirPart]) assert.strictEqual(fs.existsSync(kept), true, kept);
    assert.strictEqual(fs.lstatSync(linkPart).isSymbolicLink(), true);
    // A part that is there but not in a real folder inside the root stays
    // named, for a later start that may find it there again; the rest go.
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [outsidePart, viaLink]);
    assert.deepStrictEqual(logged, [
        'Upload parts: removed 1 left by an earlier run',
        `Upload parts: 2 left in the record, not removable now (outside ${conf}, not in a real folder, not readable, or not deleted); tried again at the next start`,
    ]);
});

test('startup keeps naming a part it cannot judge now, and sweeps it once it can', async () => {
    // /config resolved to old/ when the part was made, and to new/ at this
    // start: the part is outside the root now. Dropped from the record, it
    // would be left behind for good.
    const r = path.join(base, 'moved-root');
    const conf = path.join(r, 'config');
    fs.mkdirSync(path.join(r, 'new'), { recursive: true });
    const part = write('a/.ctp-upload-0123456789abcdef.part', '', path.join(r, 'old'));
    const goneOutside = path.join(r, 'old', 'a', '.ctp-upload-1111111111111111.part');
    fs.symlinkSync(path.join(r, 'new'), conf);
    const file = path.join(r, 'upload-parts');
    fs.writeFileSync(file, JSON.stringify([part, goneOutside]));
    const logged = [];
    const rec = createPartRecord({ file, root: conf, log: (m) => logged.push(m) });
    assert.strictEqual(await rec.start(), 0);
    assert.strictEqual(fs.existsSync(part), true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [part]);
    assert.match(logged.join('\n'), /1 left in the record, not removable now/);
    // carried through the record's writes while this run goes on
    await rec.add('/p/1');
    await rec.remove('/p/1');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [part]);
    // the next start, with the root back where the part is, removes it
    fs.unlinkSync(conf);
    fs.symlinkSync(path.join(r, 'old'), conf);
    assert.strictEqual(await createPartRecord({ file, root: conf, log: () => {} }).start(), 1);
    assert.strictEqual(fs.existsSync(part), false);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), []);
});

test('startup keeps naming a part whose folder or name cannot be read now, or that it failed to remove', async () => {
    const r = path.join(base, 'unjudged');
    const conf = path.join(r, 'config');
    fs.mkdirSync(conf, { recursive: true });
    // a folder that is a link loop: realpath fails, but not with "not there"
    fs.symlinkSync(path.join(conf, 'loop'), path.join(conf, 'loop'));
    const inLoop = path.join(conf, 'loop', '.ctp-upload-0123456789abcdef.part');
    // a folder that is not there: nor is the part
    const noDir = path.join(conf, 'gone', '.ctp-upload-1111111111111111.part');
    const stuck = write('b/.ctp-upload-2222222222222222.part', '', conf);
    const freed = write('b/.ctp-upload-3333333333333333.part', '', conf);
    // a part whose own lstat fails, other than "not there"
    const unlooked = write('b/.ctp-upload-4444444444444444.part', '', conf);
    // a "folder" that is a file: nothing can be in it (ENOTDIR from the
    // part's lstat, or from the folder's realpath one level down)
    write('afile', 'a file', conf);
    const inFile = path.join(conf, 'afile', '.ctp-upload-5555555555555555.part');
    const belowFile = path.join(conf, 'afile', 'sub', '.ctp-upload-6666666666666666.part');
    const file = path.join(r, 'upload-parts');
    fs.writeFileSync(file, JSON.stringify([inLoop, noDir, stuck, freed, unlooked, inFile, belowFile]));
    const unlink = async (p) => {
        if (p === stuck) throw Object.assign(new Error('simulated EBUSY'), { code: 'EBUSY' });
        return fs.promises.unlink(p);
    };
    const lstat = async (p, ...rest) => {
        if (p === unlooked) throw Object.assign(new Error('simulated EIO'), { code: 'EIO' });
        return fs.promises.lstat(p, ...rest);
    };
    const logged = [];
    assert.strictEqual(await createPartRecord({ file, root: conf, log: (m) => logged.push(m), unlink, lstat }).start(), 1);
    assert.strictEqual(fs.existsSync(freed), false);
    assert.strictEqual(fs.existsSync(stuck), true);
    assert.strictEqual(fs.existsSync(unlooked), true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [inLoop, stuck, unlooked]);
    assert.ok(logged.some((m) => m.includes(`could not remove ${stuck}: simulated EBUSY`)), logged.join('\n'));
    assert.ok(logged.some((m) => m.startsWith('Upload parts: 3 left in the record, not removable now')), logged.join('\n'));
    // positive control: a part that is gone between the look and the unlink is just gone
    fs.writeFileSync(file, JSON.stringify([stuck]));
    const vanishing = async (p) => {
        await fs.promises.unlink(p);
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    };
    assert.strictEqual(await createPartRecord({ file, root: conf, log: () => {}, unlink: vanishing }).start(), 0);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), []);
});

test('startup with no record, or an unreadable one, removes nothing and never throws', async () => {
    const r = path.join(base, 'sweep2');
    const conf = path.join(r, 'config');
    const part = write('.ctp-upload-0123456789abcdef.part', 'x', conf);
    const file = path.join(r, 'upload-parts');
    assert.strictEqual(await createPartRecord({ file, root: conf, log: () => {} }).start(), 0);
    assert.strictEqual(fs.existsSync(file), false);
    fs.writeFileSync(file, '{not json');
    const logged = [];
    assert.strictEqual(await createPartRecord({ file, root: conf, log: (m) => logged.push(m) }).start(), 0);
    assert.strictEqual(fs.existsSync(part), true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), []);
    assert.match(logged[0], /unreadable record/);
    // a root that is not there yet keeps the record for the next start
    fs.writeFileSync(file, JSON.stringify([part]));
    assert.strictEqual(await createPartRecord({ file, root: path.join(r, 'missing'), log: () => {} }).start(), 0);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [part]);
});

test('a record left for the next start is carried through every write until then', async () => {
    const r = path.join(base, 'carry');
    const part = write('.ctp-upload-0123456789abcdef.part', 'x', path.join(r, 'config'));
    const file = path.join(r, 'upload-parts');
    fs.writeFileSync(file, JSON.stringify([part]));
    const rec = createPartRecord({ file, root: path.join(r, 'missing'), log: () => {} });
    assert.strictEqual(await rec.start(), 0);
    await rec.add('/p/1');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [part, '/p/1']);
    await rec.remove('/p/1');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [part]);
    // and the next start, with the root there, sweeps it
    const next = createPartRecord({ file, root: path.join(r, 'config'), log: () => {} });
    assert.strictEqual(await next.start(), 1);
    assert.strictEqual(fs.existsSync(part), false);
});

test('the record is rewritten whole, in order, as uploads come and go', async () => {
    const file = path.join(base, 'order-record');
    const rec = createPartRecord({ file, root, log: () => {} });
    await rec.start();
    await Promise.all([rec.add('/p/1'), rec.add('/p/2'), rec.add('/p/3')]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), ['/p/1', '/p/2', '/p/3']);
    await Promise.all([rec.remove('/p/2'), rec.remove('/p/1')]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), ['/p/3']);
    assert.strictEqual(fs.existsSync(`${file}.tmp`), false);
});

test('each new record is synced to disk before it replaces the old one', async () => {
    const file = path.join(base, 'synced-record');
    // What the record file held each time a temp file was synced: a sync
    // after the rename would see the new record there already.
    const seen = [];
    const open = async (p, flags, mode) => {
        const handle = await fs.promises.open(p, flags, mode);
        return {
            writeFile: (d) => handle.writeFile(d),
            sync: () => {
                seen.push(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
                return handle.sync();
            },
            close: () => handle.close(),
        };
    };
    const rec = createPartRecord({ file, root, log: () => {}, open });
    await rec.add('/p/1');
    await rec.add('/p/2');
    assert.deepStrictEqual(seen, [null, ['/p/1']]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), ['/p/1', '/p/2']);
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});
