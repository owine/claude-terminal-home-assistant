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
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), []);
    assert.deepStrictEqual(logged, ['Upload parts: removed 1 left by an earlier run']);
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
