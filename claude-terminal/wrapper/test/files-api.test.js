'use strict';

// Files sidebar API (files-api.js): confinement to the root, hidden and
// sensitive entries, preview limits, binary detection, recent changes, the
// `ha core check` runner, and the express routes on a real listener.
//
// Fixture: a temporary tree with `config/` standing in for /config and
// `data/` beside it standing in for /data, where Claude's login lives.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const {
    createFilesApi,
    createFilesRouter,
    createHaCheck,
    classifyRelative,
    looksBinary,
} = require('../files-api.js');
const { createRateLimiter } = require('../http-guards.js');

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'files-api-')));
const root = path.join(base, 'config');
const outside = path.join(base, 'data');
after(() => fs.rmSync(base, { recursive: true, force: true }));

function write(rel, content = 'x', at = root) {
    const full = path.join(at, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
}

write('configuration.yaml', 'homeassistant:\n  name: Home\n');
write('automations.yaml', '[]\n');
write('secrets.yaml', 'api_key: hunter2\n');
write('packages/climate.yaml', 'climate: []\n');
write('packages/secrets.yaml', 'nested: secret\n');
write('.git/config', '[remote "origin"]\n  url = https://token@github.com/x/y\n');
write('.storage/auth', '{"refresh_tokens": []}\n');
write('.cloud/x', 'cloud\n');
write('.env', 'TOKEN=1\n');
write('certs/server.key', 'KEY\n');
write('claude-config/.credentials.json', '{"token": "t"}\n');
write('with space.yaml', 'a: 1\n');
write('backup.tar.part', 'partial');
write('.credentials.json', 'login\n', outside);
write('home/.claude/.credentials.json', 'login\n', outside);
fs.symlinkSync(outside, path.join(root, 'data-link'));
fs.symlinkSync(path.join(outside, '.credentials.json'), path.join(root, 'creds-link'));
fs.symlinkSync(path.join(root, '.env'), path.join(root, 'innocent.yaml'));
fs.symlinkSync(path.join(root, '.git'), path.join(root, 'repo-meta'));
fs.symlinkSync(path.join(root, 'automations.yaml'), path.join(root, 'autos-link.yaml'));
fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'dangling'));

const api = createFilesApi({ root });

async function refused(promise, status = 404) {
    await assert.rejects(promise, (err) => {
        assert.strictEqual(err.status, status, `status ${err.status}: ${err.message}`);
        return true;
    });
}

// --- classification ---

test('hidden: .git anywhere, any case', () => {
    for (const p of ['.git', '.git/config', 'sub/.git/HEAD', '.GIT/config']) {
        assert.strictEqual(classifyRelative(p), 'hidden', p);
    }
});

test('sensitive: keys, .env, credential stores, .storage, .cloud, claude-config', () => {
    for (const p of ['.storage', '.storage/auth', '.cloud/x', 'sub/.ssh/id_rsa', 'id_ed25519', 'certs/a.pem', 'certs/server.key',
        '.env', '.env.local', '.git-credentials', '.gitconfig', '.netrc', 'x/.npmrc', '.credentials.json', '.claude.json',
        'claude-config', 'claude-config/.credentials.json', 'x.p12']) {
        assert.strictEqual(classifyRelative(p), 'sensitive', p);
    }
});

test('ordinary config files are neither', () => {
    // secrets.yaml is an ordinary file, as in Studio Code Server
    for (const p of ['', 'configuration.yaml', 'packages/climate.yaml', 'secrets.yaml', 'packages/secrets.yml', 'secrets_example.md', 'storage.yaml', 'keyboard.yaml',
        '.gitignore', '.github/workflows/ci.yaml', 'environment.yaml', 'sub/claude-config/notes.md', 'home-assistant_v2.db']) {
        assert.strictEqual(classifyRelative(p), 'ok', p);
    }
});

// --- confinement ---

test('lists the root by default', async () => {
    const { path: listed, entries } = await api.list('');
    assert.strictEqual(listed, root);
    const names = entries.map((e) => e.name);
    assert.ok(names.includes('configuration.yaml'));
    assert.ok(names.includes('packages'));
    // folders first
    assert.strictEqual(entries[0].type, 'dir');
});

test('refuses ../ out of the root', async () => {
    await refused(api.list('..'));
    await refused(api.list('../data'));
    await refused(api.preview('../data/.credentials.json'));
    await refused(api.preview('packages/../../data/.credentials.json'));
    await refused(api.preview(`${root}/../data/.credentials.json`));
});

test('refuses absolute paths outside the root: /etc, /data', async () => {
    await refused(api.preview('/etc/passwd'));
    await refused(api.list('/etc'));
    await refused(api.preview(path.join(outside, '.credentials.json')));
    await refused(api.list(outside));
    await refused(api.preview('/data/home/.claude/.credentials.json'));
});

test('accepts absolute paths inside the root', async () => {
    const res = await api.preview(path.join(root, 'configuration.yaml'));
    assert.match(res.content, /name: Home/);
});

test('refuses symlinks that escape the root', async () => {
    await refused(api.list('data-link'));
    await refused(api.preview('data-link/.credentials.json'));
    await refused(api.preview('creds-link'));
});

test('refuses symlinks to hidden entries', async () => {
    await refused(api.list('repo-meta'));
    await refused(api.preview('repo-meta/config'));
});

test('a symlink to a secret-shaped file is refused like the file', async () => {
    await refused(api.preview('innocent.yaml'), 403);
});

test('follows symlinks that stay inside the root', async () => {
    const res = await api.preview('autos-link.yaml');
    assert.strictEqual(res.content, '[]\n');
});

test('rejects NUL bytes and overlong paths', async () => {
    await refused(api.preview('configuration.yaml\0.txt'), 400);
    await refused(api.preview('a'.repeat(5000)), 400);
});

test('a missing path is a 404, not a crash', async () => {
    await refused(api.preview('nope.yaml'));
    await refused(api.preview('dangling'));
});

// --- hidden and sensitive entries ---

test('listing leaves out .git, *.part and escaping or hidden symlinks', async () => {
    const names = (await api.list('')).entries.map((e) => e.name);
    for (const gone of ['.git', 'backup.tar.part', 'data-link', 'creds-link', 'repo-meta', 'dangling']) {
        assert.ok(!names.includes(gone), `${gone} listed`);
    }
    for (const kept of ['autos-link.yaml', 'innocent.yaml', 'secrets.yaml']) {
        assert.ok(names.includes(kept), `${kept} not listed`);
    }
    const nested = (await api.list('packages')).entries.map((e) => e.name);
    assert.deepStrictEqual(nested, ['climate.yaml', 'secrets.yaml']);
});

test('.git cannot be listed or previewed directly', async () => {
    await refused(api.list('.git'));
    await refused(api.preview('.git/config'));
    await refused(api.preview('.git/../.git/config'));
    await refused(api.preview(path.join(root, '.git', 'config')));
});

test('secrets.yaml is an ordinary file: listed and previewed', async () => {
    assert.strictEqual((await api.preview('secrets.yaml')).content, 'api_key: hunter2\n');
    assert.strictEqual((await api.preview('packages/secrets.yaml')).content, 'nested: secret\n');
});

test('sensitive files are listed, flagged, and refused for preview', async () => {
    const entries = (await api.list('')).entries;
    const storage = entries.find((e) => e.name === '.storage');
    assert.ok(storage && storage.sensitive);
    for (const p of ['.storage/auth', '.cloud/x', '.env', 'certs/server.key', 'claude-config/.credentials.json']) {
        await refused(api.preview(p), 403);
    }
});

// --- preview ---

test('preview returns text as a string with size and mtime', async () => {
    const res = await api.preview('configuration.yaml');
    assert.strictEqual(res.binary, false);
    assert.strictEqual(res.truncated, false);
    assert.strictEqual(res.content, 'homeassistant:\n  name: Home\n');
    assert.strictEqual(res.size, res.content.length);
    assert.ok(res.mtime > 0);
});

test('preview is cut at the byte limit and says so', async () => {
    const small = createFilesApi({ root, maxPreviewBytes: 1024 });
    write('big.txt', 'a'.repeat(5000));
    const res = await small.preview('big.txt');
    assert.strictEqual(res.truncated, true);
    assert.strictEqual(res.content.length, 1024);
    assert.strictEqual(res.size, 5000);
});

test('a cut in the middle of a UTF-8 character is not called binary', async () => {
    const small = createFilesApi({ root, maxPreviewBytes: 1001 });
    write('utf8.txt', 'é'.repeat(1000));   // 2 bytes each, so byte 1001 splits one
    const res = await small.preview('utf8.txt');
    assert.strictEqual(res.binary, false);
    assert.strictEqual(res.content, 'é'.repeat(500));
});

test('binary files are detected and not returned', async () => {
    write('image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    const res = await api.preview('image.png');
    assert.strictEqual(res.binary, true);
    assert.strictEqual(res.content, undefined);
});

test('looksBinary: NUL or invalid UTF-8', () => {
    assert.strictEqual(looksBinary(Buffer.from('plain text'), false), false);
    assert.strictEqual(looksBinary(Buffer.from([0x41, 0x00, 0x42]), false), true);
    assert.strictEqual(looksBinary(Buffer.from([0xff, 0xfe, 0x41]), false), true);
});

test('a folder is not a file, and a file is not a folder', async () => {
    await refused(api.preview('packages'), 400);
    await refused(api.list('configuration.yaml'), 400);
});

test('a FIFO is not opened (it would block)', { skip: process.platform === 'win32' }, async () => {
    const fifo = path.join(root, 'pipe');
    require('node:child_process').execFileSync('mkfifo', [fifo]);
    try {
        await refused(api.preview('pipe'), 400);
        const names = (await api.list('')).entries.map((e) => e.name);
        assert.ok(!names.includes('pipe'));
    } finally {
        fs.unlinkSync(fifo);
    }
});

test('a folder listing stops at the entry limit', async () => {
    const dir = path.join(root, 'many');
    for (let i = 0; i < 30; i++) write(`many/f${String(i).padStart(2, '0')}.txt`);
    const capped = createFilesApi({ root, maxEntries: 10 });
    const res = await capped.list(dir);
    assert.strictEqual(res.entries.length, 10);
    assert.strictEqual(res.truncated, true);
    const full = await api.list(dir);
    assert.strictEqual(full.entries.length, 30);
    assert.strictEqual(full.truncated, false);
    fs.rmSync(dir, { recursive: true });
});

test('a missing root is a 503, not a crash', async () => {
    const gone = createFilesApi({ root: path.join(base, 'not-mounted') });
    await refused(gone.list(''), 503);
});

// --- recent changes ---

test('recent changes: newest first, inside the window, noise and secret-shaped files left out', async () => {
    const recentRoot = path.join(base, 'recent');
    const NOW = Date.UTC(2026, 0, 10, 12);
    const ago = (h) => new Date(NOW - h * 3600 * 1000);
    const touch = (rel, hoursAgo) => {
        const full = write(rel, 'x', recentRoot);
        fs.utimesSync(full, ago(hoursAgo), ago(hoursAgo));
    };
    touch('automations.yaml', 0.5);
    touch('packages/climate.yaml', 2);
    touch('scripts.yaml', 30);
    touch('old.yaml', 24 * 10);
    touch('secrets.yaml', 0.2);
    // left out whatever their age
    touch('download.part', 0.1);
    touch('.storage/core.config_entries', 0.1);
    touch('.cloud/x', 0.1);
    touch('.git/index', 0.1);
    touch('deps/lib.py', 0.1);
    touch('tts/hello.mp3', 0.1);
    touch('home-assistant_v2.db', 0.1);
    touch('home-assistant_v2.db-wal', 0.1);
    touch('home-assistant.log', 0.1);
    touch('home-assistant.log.1', 0.1);
    touch('.env', 0.1);
    touch('claude-config/.credentials.json', 0.1);
    fs.symlinkSync(outside, path.join(recentRoot, 'data-link'));

    const recentApi = createFilesApi({ root: recentRoot, now: () => NOW });
    const day = await recentApi.recent(24);
    assert.deepStrictEqual(day.entries.map((e) => e.relative),
        ['secrets.yaml', 'automations.yaml', path.join('packages', 'climate.yaml')]);
    assert.strictEqual(day.hours, 24);

    const hour = await recentApi.recent(1);
    assert.deepStrictEqual(hour.entries.map((e) => e.relative), ['secrets.yaml', 'automations.yaml']);

    const week = await recentApi.recent(168);
    assert.deepStrictEqual(week.entries.map((e) => e.relative),
        ['secrets.yaml', 'automations.yaml', path.join('packages', 'climate.yaml'), 'scripts.yaml']);
});

test('recent changes clamps the window', async () => {
    assert.strictEqual((await api.recent('nonsense')).hours, 24);
    assert.strictEqual((await api.recent(0.01)).hours, 1);
    assert.strictEqual((await api.recent(1e9)).hours, 720);
});

test('recent changes stops when its time budget runs out', async () => {
    const hurried = createFilesApi({ root, recentTimeBudgetMs: -1 });
    const res = await hurried.recent(24);
    assert.strictEqual(res.incomplete, true);
    assert.deepStrictEqual(res.entries, []);
});

// --- ha core check ---

// A stand-in for child_process.execFile that records each call and lets the
// test decide when and how it finishes.
function fakeExecFile() {
    const calls = [];
    const fn = (cmd, args, opts, cb) => { calls.push({ cmd, args, opts, cb }); };
    return { fn, calls };
}

test('ha check: fixed argv, no shell, with a timeout', async () => {
    const exec = fakeExecFile();
    const check = createHaCheck({ execFile: exec.fn, timeoutMs: 5000 });
    const pending = check.run();
    assert.strictEqual(exec.calls.length, 1);
    const { cmd, args, opts } = exec.calls[0];
    assert.strictEqual(cmd, 'ha');
    assert.deepStrictEqual(args, ['core', 'check', '--raw-json']);
    assert.strictEqual(opts.timeout, 5000);
    assert.ok(!opts.shell);
    exec.calls[0].cb(null, '{"result":"ok","data":{}}', '');
    assert.deepStrictEqual(await pending, { ok: true, message: 'Configuration is valid' });
});

test('ha check: one at a time', async () => {
    const exec = fakeExecFile();
    const check = createHaCheck({ execFile: exec.fn });
    const first = check.run();
    assert.strictEqual(check.run(), null);
    assert.strictEqual(check.isRunning(), true);
    assert.strictEqual(exec.calls.length, 1);
    exec.calls[0].cb(null, '{"result":"ok"}', '');
    await first;
    assert.strictEqual(check.isRunning(), false);
    // free again once finished
    const second = check.run();
    assert.ok(second);
    exec.calls[1].cb(null, '{"result":"ok"}', '');
    await second;
});

test('ha check: non-zero exit reports HA\'s message', async () => {
    const exec = fakeExecFile();
    const check = createHaCheck({ execFile: exec.fn });
    const pending = check.run();
    const err = Object.assign(new Error('Command failed'), { code: 1 });
    exec.calls[0].cb(err, '{"result":"error","message":"Invalid config for [automation]: bad trigger"}', '');
    assert.deepStrictEqual(await pending, { ok: false, message: 'Invalid config for [automation]: bad trigger' });
});

test('ha check: non-zero exit without JSON falls back to stderr', async () => {
    const exec = fakeExecFile();
    const check = createHaCheck({ execFile: exec.fn });
    const pending = check.run();
    exec.calls[0].cb(Object.assign(new Error('Command failed'), { code: 1 }), '', '\x1b[31mError: unauthorized\x1b[0m\n');
    assert.deepStrictEqual(await pending, { ok: false, message: 'Error: unauthorized' });
});

test('ha check: a timeout says so and frees the slot', async () => {
    const exec = fakeExecFile();
    const check = createHaCheck({ execFile: exec.fn, timeoutMs: 180000 });
    const pending = check.run();
    exec.calls[0].cb(Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' }), '', '');
    const res = await pending;
    assert.strictEqual(res.ok, false);
    assert.match(res.message, /180 seconds/);
    assert.strictEqual(check.isRunning(), false);
});

test('ha check: a missing ha binary, or execFile throwing, never rejects', async () => {
    const missing = createHaCheck({ execFile: (c, a, o, cb) => cb(Object.assign(new Error('spawn ha ENOENT'), { code: 'ENOENT' }), '', '') });
    assert.deepStrictEqual(await missing.run(), { ok: false, message: 'The ha command is not available' });
    const throwing = createHaCheck({ execFile: () => { throw new Error('boom'); } });
    assert.deepStrictEqual(await throwing.run(), { ok: false, message: 'boom' });
    assert.strictEqual(throwing.isRunning(), false);
});

test('ha check: exit 0 with an error result is not ok', async () => {
    const check = createHaCheck({ execFile: (c, a, o, cb) => cb(null, '{"result":"error","message":"nope"}', '') });
    assert.deepStrictEqual(await check.run(), { ok: false, message: 'nope' });
});

// --- routes ---

async function withServer(options, fn) {
    const app = express();
    app.use('/api/files', createFilesRouter({
        api,
        haCheck: createHaCheck({ execFile: (c, a, o, cb) => setTimeout(() => cb(null, '{"result":"ok"}', ''), 50) }),
        readLimiter: createRateLimiter({ max: 1000 }),
        checkLimiter: createRateLimiter({ max: 1000 }),
        log: () => {},
        ...options,
    }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const url = `http://127.0.0.1:${server.address().port}/api`;
    try {
        await fn(url);
    } finally {
        await new Promise((r) => server.close(r));
    }
}

test('routes: list, preview and recent answer JSON, refusals are 404/403', async () => {
    await withServer({}, async (url) => {
        let res = await fetch(`${url}/files/list`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get('cache-control'), 'no-store');
        assert.ok((await res.json()).entries.length > 0);

        res = await fetch(`${url}/files/preview?path=${encodeURIComponent('with space.yaml')}`);
        assert.strictEqual((await res.json()).content, 'a: 1\n');

        res = await fetch(`${url}/files/preview?path=${encodeURIComponent('../data/.credentials.json')}`);
        assert.strictEqual(res.status, 404);
        assert.deepStrictEqual(await res.json(), { error: 'Not found or not allowed' });

        res = await fetch(`${url}/files/preview?path=.env`);
        assert.strictEqual(res.status, 403);

        res = await fetch(`${url}/files/list?path=.git`);
        assert.strictEqual(res.status, 404);
        res = await fetch(`${url}/files/preview?path=${encodeURIComponent('.git/config')}`);
        assert.strictEqual(res.status, 404);

        // ?path=a&path=b arrives as an array; refused, never thrown
        res = await fetch(`${url}/files/preview?path=a&path=b`);
        assert.strictEqual(res.status, 400);

        res = await fetch(`${url}/files/recent?hours=1`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual((await res.json()).hours, 1);
    });
});

test('routes: an unexpected error is a 500 JSON, not a thrown exception', async () => {
    const broken = { list: async () => { throw new TypeError('bug'); } };
    await withServer({ api: broken }, async (url) => {
        const res = await fetch(`${url}/files/list`);
        assert.strictEqual(res.status, 500);
        assert.deepStrictEqual(await res.json(), { error: 'Internal error' });
    });
});

test('routes: a second concurrent check is a 409', async () => {
    await withServer({}, async (url) => {
        const first = fetch(`${url}/files/ha-check`, { method: 'POST' });
        await new Promise((r) => setTimeout(r, 10));
        const second = await fetch(`${url}/files/ha-check`, { method: 'POST' });
        assert.strictEqual(second.status, 409);
        assert.deepStrictEqual(await (await first).json(), { ok: true, message: 'Configuration is valid' });
    });
});

test('routes: the rate limiter applies', async () => {
    await withServer({ readLimiter: createRateLimiter({ max: 1 }) }, async (url) => {
        assert.strictEqual((await fetch(`${url}/files/list`)).status, 200);
        assert.strictEqual((await fetch(`${url}/files/list`)).status, 429);
    });
});
