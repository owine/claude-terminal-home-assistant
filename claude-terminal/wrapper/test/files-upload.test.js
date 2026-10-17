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
const { createFilesApi } = require('../files-api.js');
const { createPartRecord } = require('../upload-parts.js');
const {
    createUploads,
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
