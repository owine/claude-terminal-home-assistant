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
    procFdPath,
    sendError,
    FilesError,
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
write('backup.tar.part', 'a user file');                   // an ordinary name
write('.ctp-upload-0a1b2c3d4e5f6a7b.part', 'partial');      // an upload in flight
write('.credentials.json', 'login\n', outside);
write('home/.claude/.credentials.json', 'login\n', outside);
fs.symlinkSync(outside, path.join(root, 'data-link'));
fs.symlinkSync(path.join(outside, '.credentials.json'), path.join(root, 'creds-link'));
fs.symlinkSync(path.join(root, '.env'), path.join(root, 'innocent.yaml'));
fs.symlinkSync(path.join(root, '.git'), path.join(root, 'repo-meta'));
fs.symlinkSync(path.join(root, 'automations.yaml'), path.join(root, 'autos-link.yaml'));
fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'dangling'));
fs.symlinkSync(path.join(root, '.storage', 'auth'), path.join(root, 'notes.txt'));
write('f.txt', 'OUTSIDE\n', outside);

const api = createFilesApi({ root });

async function refused(promise, status = 404) {
    await assert.rejects(promise, (err) => {
        assert.strictEqual(err.status, status, `status ${err.status}: ${err.message}`);
        return true;
    });
}

// --- classification ---

test('hidden: .git anywhere, any case, and bare repositories', () => {
    for (const p of ['.git', '.git/config', 'sub/.git/HEAD', '.GIT/config', 'homeassistant.git', 'backup.git/config', 'x/Repo.GIT/HEAD']) {
        assert.strictEqual(classifyRelative(p), 'hidden', p);
    }
});

test('sensitive: keys, .env, credential stores, .storage, .cloud, claude-config', () => {
    for (const p of ['.storage', '.storage/auth', '.cloud/x', 'sub/.ssh/id_rsa', 'id_ed25519', 'certs/a.pem', 'certs/server.key',
        '.env', '.env.local', '.git-credentials', '.gitconfig', '.netrc', 'x/.npmrc', '.credentials.json', '.claude.json',
        'claude-config', 'claude-config/.credentials.json', 'x.p12', '.envrc', 'sub/.envrc',
        'service_account.json', 'google/SERVICE_ACCOUNT.JSON']) {
        assert.strictEqual(classifyRelative(p), 'sensitive', p);
    }
});

test('ordinary config files are neither', () => {
    // secrets.yaml is an ordinary file, as in Studio Code Server
    for (const p of ['', 'configuration.yaml', 'packages/climate.yaml', 'secrets.yaml', 'packages/secrets.yml', 'secrets_example.md', 'storage.yaml', 'keyboard.yaml',
        '.gitignore', '.github/workflows/ci.yaml', 'my.github', 'service_account.json.example', 'envrc', 'environment.yaml', 'sub/claude-config/notes.md', 'home-assistant_v2.db']) {
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

test('a symlink is locked if its name OR its target is secret-shaped', async () => {
    const entries = (await api.list('')).entries;
    const notes = entries.find((e) => e.name === 'notes.txt');
    assert.ok(notes, 'notes.txt listed');
    assert.strictEqual(notes.sensitive, true);
    const innocent = entries.find((e) => e.name === 'innocent.yaml');
    assert.strictEqual(innocent.sensitive, true);
    const autos = entries.find((e) => e.name === 'autos-link.yaml');
    assert.strictEqual(autos.sensitive, undefined);
    await refused(api.preview('notes.txt'), 403);
});

test('listing leaves out .git, upload parts and escaping or hidden symlinks', async () => {
    const names = (await api.list('')).entries.map((e) => e.name);
    for (const gone of ['.git', '.ctp-upload-0a1b2c3d4e5f6a7b.part', 'data-link', 'creds-link', 'repo-meta', 'dangling']) {
        assert.ok(!names.includes(gone), `${gone} listed`);
    }
    // Only the wrapper's own .ctp-upload-*.part is a partial file: any other
    // *.part is somebody's file, and is listed.
    for (const kept of ['autos-link.yaml', 'innocent.yaml', 'secrets.yaml', 'backup.tar.part']) {
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

// --- parent folder swapped after resolve() ---
//
// O_NOFOLLOW only covers the last component. A folder swapped for a symlink
// between resolve() and open() is followed by the open, and only the
// descriptor check (/proc/self/fd) catches it.

const hasProcFd = fs.existsSync(`/proc/self/fd`);

function swapApi(target, opts = {}) {
    write('swap/f.txt', 'inside\n');
    const dir = path.join(root, 'swap');
    return {
        api: createFilesApi({
            root,
            onResolved: async () => {
                fs.renameSync(dir, path.join(root, 'swap-old'));
                fs.symlinkSync(target, dir);
            },
            ...opts,
        }),
        cleanup: () => {
            fs.rmSync(dir, { force: true });
            fs.rmSync(path.join(root, 'swap-old'), { recursive: true, force: true });
        },
    };
}

test('negative control: without the descriptor check a parent swap escapes', async () => {
    const { api: swapping, cleanup } = swapApi(outside, { fdPath: async () => null });
    try {
        assert.strictEqual((await swapping.preview('swap/f.txt')).content, 'OUTSIDE\n');
    } finally {
        cleanup();
    }
});

test('a parent folder swapped for a symlink out of the root is refused',
    { skip: !hasProcFd && 'needs /proc/self/fd (Linux)' }, async () => {
        const { api: swapping, cleanup } = swapApi(outside);
        try {
            await refused(swapping.preview('swap/f.txt'));
        } finally {
            cleanup();
        }
    });

test('a parent folder swapped for a symlink into .storage is refused',
    { skip: !hasProcFd && 'needs /proc/self/fd (Linux)' }, async () => {
        write('.storage/f.txt', 'token\n');
        const { api: swapping, cleanup } = swapApi(path.join(root, '.storage'));
        try {
            await refused(swapping.preview('swap/f.txt'), 403);
        } finally {
            cleanup();
            fs.rmSync(path.join(root, '.storage', 'f.txt'));
        }
    });

test('the descriptor check rejects what the descriptor really is', async () => {
    const at = (p) => createFilesApi({ root, fdPath: async () => p });
    await refused(at(path.join(outside, 'f.txt')).preview('configuration.yaml'));
    await refused(at(path.join(root, '.git', 'config')).preview('configuration.yaml'));
    await refused(at(path.join(root, '.storage', 'auth')).preview('configuration.yaml'), 403);
    // unknown (no /proc): falls back to the path checks
    assert.match((await at(null).preview('configuration.yaml')).content, /name: Home/);
    assert.match((await at(path.join(root, 'configuration.yaml')).preview('configuration.yaml')).content, /name: Home/);
});

test('procFdPath names the open file on Linux, and is null elsewhere', async () => {
    const file = path.join(root, 'configuration.yaml');
    const handle = await fs.promises.open(file, 'r');
    try {
        assert.strictEqual(await procFdPath(handle.fd), hasProcFd ? file : null);
    } finally {
        await handle.close();
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
    touch('backup.part', 0.3);   // a user's own *.part is an ordinary file
    // left out whatever their age
    touch('.ctp-upload-0a1b2c3d4e5f6a7b.part', 0.1);
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
    touch('service_account.json', 0.1);
    touch('.envrc', 0.1);
    touch('backup.git/HEAD', 0.1);
    touch('venv/lib/x.py', 0.1);
    touch('.venv/lib/x.py', 0.1);
    touch('node_modules/x/index.js', 0.1);
    touch('esphome/.esphome/build/node/src/main.cpp', 0.1);
    touch('esphome/.pio/x', 0.1);
    touch('esphome/.pioenvs/x', 0.1);
    // `build` is only skipped under .esphome
    touch('www/build/card.js', 1.5);
    fs.symlinkSync(outside, path.join(recentRoot, 'data-link'));

    const recentApi = createFilesApi({ root: recentRoot, now: () => NOW });
    const day = await recentApi.recent(24);
    assert.deepStrictEqual(day.entries.map((e) => e.relative),
        ['secrets.yaml', 'backup.part', 'automations.yaml', path.join('www', 'build', 'card.js'), path.join('packages', 'climate.yaml')]);
    assert.strictEqual(day.hours, 24);

    const hour = await recentApi.recent(1);
    assert.deepStrictEqual(hour.entries.map((e) => e.relative), ['secrets.yaml', 'backup.part', 'automations.yaml']);

    const week = await recentApi.recent(168);
    assert.deepStrictEqual(week.entries.map((e) => e.relative),
        ['secrets.yaml', 'backup.part', 'automations.yaml', path.join('www', 'build', 'card.js'), path.join('packages', 'climate.yaml'), 'scripts.yaml']);
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

// --- protected=1: the "Show protected files" toggle ---

test('allowSensitive lifts the sensitive tier for preview, and nothing else', async () => {
    assert.strictEqual((await api.preview('.env', { allowSensitive: true })).content, 'TOKEN=1\n');
    assert.strictEqual((await api.preview('.storage/auth', { allowSensitive: true })).content, '{"refresh_tokens": []}\n');
    assert.strictEqual((await api.preview('claude-config/.credentials.json', { allowSensitive: true })).content, '{"token": "t"}\n');
    // a symlink named innocently, pointing at .env
    assert.strictEqual((await api.preview('innocent.yaml', { allowSensitive: true })).content, 'TOKEN=1\n');
    // never-shown and outside the root stay refused
    await refused(api.preview('.git/config', { allowSensitive: true }));
    await refused(api.preview('repo-meta/config', { allowSensitive: true }));
    await refused(api.preview('../data/.credentials.json', { allowSensitive: true }));
    await refused(api.preview('creds-link', { allowSensitive: true }));
});

test('preview says whether the file it opened is protected, by name or target', async () => {
    // The UI clears a protected preview when the toggle goes off, and must
    // know it is one even when its listing was stale (a file since replaced
    // by a link to .env), so the server says so on every answer.
    const open = (p) => api.preview(p, { allowSensitive: true });
    assert.strictEqual((await open('configuration.yaml')).sensitive, false);
    assert.strictEqual((await open('autos-link.yaml')).sensitive, false);
    assert.strictEqual((await api.preview('configuration.yaml')).sensitive, false);
    assert.strictEqual((await open('.env')).sensitive, true);
    assert.strictEqual((await open('.storage/auth')).sensitive, true);
    assert.strictEqual((await open('innocent.yaml')).sensitive, true);   // link named innocently, to .env
    assert.strictEqual((await open('notes.txt')).sensitive, true);       // to .storage/auth
    write('certs/blob.key', Buffer.from([0, 1, 2]));
    try {
        const binary = await open('certs/blob.key');
        assert.strictEqual(binary.binary, true);
        assert.strictEqual(binary.sensitive, true);
    } finally {
        fs.rmSync(path.join(root, 'certs', 'blob.key'));
    }
    // A descriptor that turns out to be a protected file (a parent folder
    // swapped after resolve()) is reported as one too.
    const swapped = createFilesApi({ root, fdPath: async () => path.join(root, '.storage', 'auth') });
    assert.strictEqual((await swapped.preview('configuration.yaml', { allowSensitive: true })).sensitive, true);
});

test('openFile: a regular file comes back open, with its stat', async () => {
    const { handle, stat } = await api.openFile(path.join(root, 'configuration.yaml'));
    try {
        assert.strictEqual(stat.isFile(), true);
        assert.strictEqual(stat.size, 'homeassistant:\n  name: Home\n'.length);
    } finally {
        await handle.close();
    }
});

test('openFile refuses a symlink as the last component, and a folder', async () => {
    await refused(api.openFile(path.join(root, 'autos-link.yaml')), 400);   // O_NOFOLLOW
    await refused(api.openFile(path.join(root, 'packages')), 400);
});

test('the descriptor check honours allowSensitive, never for hidden or outside', async () => {
    const at = (p) => createFilesApi({ root, fdPath: async () => p });
    const storage = path.join(root, '.storage', 'auth');
    assert.match((await at(storage).preview('configuration.yaml', { allowSensitive: true })).content, /name: Home/);
    await refused(at(storage).openFile(path.join(root, 'configuration.yaml')), 403);
    await refused(at(path.join(root, '.git', 'config')).preview('configuration.yaml', { allowSensitive: true }));
    await refused(at(path.join(outside, 'f.txt')).preview('configuration.yaml', { allowSensitive: true }));
});

test('routes: protected=1 lifts the refusal for preview; list ignores it', async () => {
    await withServer({}, async (url) => {
        let res = await fetch(`${url}/files/preview?path=.env&protected=1`);
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.content, 'TOKEN=1\n');
        assert.strictEqual(body.sensitive, true);
        res = await fetch(`${url}/files/preview?path=configuration.yaml&protected=1`);
        assert.strictEqual((await res.json()).sensitive, false);

        // only exactly '1' counts; a repeated flag arrives as an array
        for (const flag of ['0', 'true', 'yes', '1&protected=1']) {
            res = await fetch(`${url}/files/preview?path=.env&protected=${flag}`);
            assert.strictEqual(res.status, 403, `protected=${flag}`);
            assert.match((await res.json()).error, /Show protected files/);
        }

        res = await fetch(`${url}/files/preview?path=${encodeURIComponent('.git/config')}&protected=1`);
        assert.strictEqual(res.status, 404);

        const plain = await (await fetch(`${url}/files/list`)).json();
        const flagged = await (await fetch(`${url}/files/list?protected=1`)).json();
        assert.deepStrictEqual(flagged, plain);
    });
});

// --- openFile checks the path itself, not only the descriptor ---

test('openFile enforces the tiers without /proc (fdPath unavailable)', async () => {
    const bare = createFilesApi({ root, fdPath: async () => null });
    await refused(bare.openFile(path.join(root, '.env')), 403);
    const { handle } = await bare.openFile(path.join(root, '.env'), { allowSensitive: true });
    await handle.close();
    await refused(bare.openFile(path.join(root, '.git', 'config')), 404);
    await refused(bare.openFile(path.join(root, '.git', 'config'), { allowSensitive: true }), 404);
    await refused(bare.openFile(path.join(outside, 'f.txt')), 404);
    await refused(bare.openFile(path.join(outside, 'f.txt'), { allowSensitive: true }), 404);
});

test('a refused openFile leaks no descriptor', { skip: !hasProcFd && 'needs /proc/self/fd (Linux)' }, async () => {
    const count = () => fs.readdirSync('/proc/self/fd').length;
    const gitConfig = path.join(root, '.git', 'config');
    const viaFd = createFilesApi({ root, fdPath: async () => gitConfig });
    const before = count();
    await refused(viaFd.openFile(path.join(root, 'configuration.yaml')));   // refused after the open
    await refused(api.openFile(path.join(root, 'packages')), 400);          // a folder
    assert.strictEqual(count(), before);
});

test('sendError destroys the response instead of throwing once headers are sent', () => {
    const logged = [];
    let destroyed = false;
    const res = {
        headersSent: true,
        destroy() { destroyed = true; },
        status() { throw new Error('must not write after headers'); },
    };
    assert.doesNotThrow(() => sendError(res, new FilesError(403, 'x'), (m) => logged.push(m)));
    assert.strictEqual(destroyed, true);
    assert.strictEqual(logged.length, 1);
});

test('openFile normalises its input: a ../ path out of the root is refused without /proc', async () => {
    const bare = createFilesApi({ root, fdPath: async () => null });
    const sneaky = `${root}/../${path.basename(outside)}/f.txt`;   // not normalised
    assert.ok(fs.existsSync(sneaky), 'the target exists, so only the check can refuse it');
    await refused(bare.openFile(sneaky, { allowSensitive: true }), 404);
});

// --- one visibility rule for the listing, recent changes and zips ---

test('an upload-part folder is hidden from the listing and from recent changes alike', async () => {
    const partRoot = path.join(base, 'parts');
    write('kept/a.txt', 'x', partRoot);
    write('.ctp-upload-0a1b2c3d4e5f6a7b.part/inner.txt', 'x', partRoot);
    write('mine.part/b.txt', 'x', partRoot);   // positive control: not ours, so shown
    const partApi = createFilesApi({ root: partRoot });
    assert.deepStrictEqual((await partApi.list('')).entries.map((e) => e.name), ['kept', 'mine.part']);
    const found = (await partApi.recent(24)).entries.map((e) => e.relative).sort();
    assert.deepStrictEqual(found, [path.join('kept', 'a.txt'), path.join('mine.part', 'b.txt')]);
});

test('the api exposes the root it was configured with', () => {
    assert.strictEqual(api.root, root);
});

// Documents a LIMIT, not a goal. Without /proc the before-open check is a
// string-prefix check and O_NOFOLLOW covers only the last component, so a
// symlinked PARENT folder escapes. Callers must pass paths from resolve() or
// from a walk that never follows symlinks (see openFile's JSDoc). If this
// ever starts failing, the limit was lifted: update the JSDoc.
test('openFile limit: without /proc a symlinked parent folder is NOT caught', async () => {
    fs.symlinkSync(outside, path.join(root, 'escape-dir'));
    try {
        const bare = createFilesApi({ root, fdPath: async () => null });
        const { handle } = await bare.openFile(path.join(root, 'escape-dir', 'f.txt'));
        await handle.close();
    } finally {
        fs.unlinkSync(path.join(root, 'escape-dir'));
    }
});

// --- for uploads (files-upload.js) ---

test('locate maps a path under the root without following it', async () => {
    const at = await api.locate('packages');
    assert.deepStrictEqual(at, { asked: path.join(root, 'packages'), relative: 'packages', kind: 'ok', root });
    // a symlink is located by its own name: where it points is not looked at
    assert.strictEqual((await api.locate('data-link')).asked, path.join(root, 'data-link'));
    assert.strictEqual((await api.locate('not-there-yet')).relative, 'not-there-yet');
    assert.strictEqual((await api.locate('.storage')).kind, 'sensitive');
    assert.strictEqual((await api.locate('')).relative, '');
    await refused(api.locate('.git'), 404);
    await refused(api.locate('../data'), 404);
    await refused(api.locate(['a', 'b']), 400);
    await refused(api.locate('a\0b'), 400);
});

test('locate accepts the root as configured when it is a symlink', async () => {
    const linked = path.join(base, 'config-link');
    fs.symlinkSync(root, linked);
    try {
        const viaLink = createFilesApi({ root: linked });
        const at = await viaLink.locate(path.join(linked, 'packages'));
        assert.strictEqual(at.asked, path.join(root, 'packages'));
        assert.strictEqual(at.root, root);
    } finally {
        fs.unlinkSync(linked);
    }
});

test('a listing marks symlinked entries, and only those', async () => {
    fs.symlinkSync(path.join(root, 'packages'), path.join(root, 'packages-link'));
    try {
        const entries = (await api.list('')).entries;
        const byName = (n) => entries.find((e) => e.name === n);
        assert.strictEqual(byName('packages-link').symlink, true);
        assert.strictEqual(byName('packages-link').type, 'dir');
        assert.strictEqual(byName('autos-link.yaml').symlink, true);
        assert.strictEqual(byName('packages').symlink, undefined);
        assert.strictEqual(byName('configuration.yaml').symlink, undefined);
    } finally {
        fs.unlinkSync(path.join(root, 'packages-link'));
    }
});

test('sendError adds a FilesError\'s details to the JSON body, under its own error', () => {
    let status;
    let body;
    const res = { headersSent: false, status(s) { status = s; return this; }, json(b) { body = b; } };
    sendError(res, new FilesError(409, 'a.yaml already exists', { reason: 'exists', replaceable: true, error: 'ignored' }));
    assert.strictEqual(status, 409);
    assert.deepStrictEqual(body, { reason: 'exists', replaceable: true, error: 'a.yaml already exists' });
    sendError(res, new FilesError(404, 'gone'));
    assert.deepStrictEqual(body, { error: 'gone' });
});

