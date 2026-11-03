'use strict';

// The Scratchpad tab's discovery (scratchpad.js): which Claude Code sessions
// exist, which is active, and where each one's scratchpad folder is. Each
// test builds its own tree: sessions/ stands in for ~/.claude/sessions and
// tmp/ for /tmp/claude-0. isAlive is injected; the default (kill + /proc) has
// a test of its own at the end.

const { test, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { once } = require('node:events');
const { createRateLimiter } = require('../http-guards.js');
const { createZipSlots } = require('../files-download.js');
const { createScratchpads, createScratchpadRouter, looksLikeClaude, defaultIsAlive, defaultProcStartOf, startTimeFromStat, UUID } = require('../scratchpad.js');

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scratchpad-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

let n = 0;
function tree() {
    const dir = path.join(base, `t${n++}`);
    const sessionsDir = path.join(dir, 'sessions');
    const tmpRoot = path.join(dir, 'tmp');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(tmpRoot, { recursive: true });
    return {
        sessionsDir,
        tmpRoot,
        record(pid, fields) {
            fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify({ pid, cwd: '/config', ...fields }));
        },
        pad(slug, id, file = 'note.md') {
            const p = path.join(tmpRoot, slug, id, 'scratchpad');
            fs.mkdirSync(p, { recursive: true });
            if (file) fs.writeFileSync(path.join(p, file), 'x');
            return fs.realpathSync(p);
        },
    };
}
const alive = (...pids) => async (pid) => pids.includes(pid);
const quiet = () => {};

test('UUID: only the 8-4-4-4-12 shape', () => {
    assert.ok(UUID.test(A));
    for (const bad of ['-'.repeat(36), 'a'.repeat(36), A.slice(1), A + 'a', A.replace(/-/g, '')]) {
        assert.ok(!UUID.test(bad), bad);
    }
});

test('a live session with a folder is active and exists', async () => {
    const t = tree();
    t.record(100, { sessionId: A, kind: 'interactive', status: 'busy', name: 'main', updatedAt: 5 });
    const dir = t.pad('-config', A);
    const s = createScratchpads({ ...t, isAlive: alive(100), log: quiet });
    const { active, sessions, dirs } = await s.discover();
    assert.strictEqual(active, A);
    assert.deepStrictEqual(sessions.map((x) => [x.id, x.label, x.live, x.exists, x.status]), [[A, 'main', true, true, 'busy']]);
    assert.strictEqual(dirs.get(A), dir);
});

test('a dead or reused PID is not live; its folder is listed as ended', async () => {
    const t = tree();
    t.record(100, { sessionId: A, updatedAt: 5 });
    t.pad('-config', A);
    const { active, sessions } = await createScratchpads({ ...t, isAlive: alive(), log: quiet }).discover();
    assert.strictEqual(active, A, 'falls back to the newest folder');
    assert.deepStrictEqual(sessions.map((x) => [x.id, x.live, x.exists, x.label]), [[A, false, true, '-config']]);
});

test('malformed records are skipped, never fatal', async () => {
    const t = tree();
    fs.writeFileSync(path.join(t.sessionsDir, '100.json'), '{not json');
    t.record(101, { sessionId: 'not-a-uuid' });
    fs.writeFileSync(path.join(t.sessionsDir, '102.json'), JSON.stringify({ pid: 999, sessionId: A, cwd: '/config' }));   // pid != name
    fs.writeFileSync(path.join(t.sessionsDir, '103.json'), JSON.stringify({ pid: 103, sessionId: B }));   // no cwd
    fs.writeFileSync(path.join(t.sessionsDir, '104.json'), JSON.stringify({ pid: 104, sessionId: C, cwd: '/config', pad: 'x'.repeat(70 * 1024) }));
    const { sessions } = await createScratchpads({ ...t, isAlive: alive(100, 101, 102, 103, 104), log: quiet }).discover();
    assert.deepStrictEqual(sessions, []);
});

test('only <pid>.json is ever opened: the .key peer tokens beside it are not', async () => {
    const t = tree();
    t.record(100, { sessionId: A });
    fs.writeFileSync(path.join(t.sessionsDir, '100.abc123.key'), 'SECRET');
    const opened = [];
    const spy = {
        ...fsp,
        open: (p, ...rest) => { opened.push(path.basename(p)); return fsp.open(p, ...rest); },
        readFile: (p, ...rest) => { opened.push(path.basename(String(p))); return fsp.readFile(p, ...rest); },
    };
    await createScratchpads({ ...t, fs: spy, isAlive: alive(100), log: quiet }).discover();
    assert.ok(opened.includes('100.json'), 'positive control: the record was read');
    assert.ok(!opened.some((f) => f.endsWith('.key')), opened.join(', '));
});

test('a live session that has not used its scratchpad yet: listed, exists false', async () => {
    const t = tree();
    t.record(100, { sessionId: A, kind: 'interactive', updatedAt: 1 });
    const { active, sessions, dirs } = await createScratchpads({ ...t, isAlive: alive(100), log: quiet }).discover();
    assert.strictEqual(active, A);
    assert.strictEqual(sessions[0].exists, false);
    assert.strictEqual(dirs.has(A), false);
});

test('a live session\'s folder is found past the ended-session caps and non-slug folders', async () => {
    const t = tree();
    for (const name of ['bash-edit-diff', 'bundled-skills', 'fdprobe']) fs.mkdirSync(path.join(t.tmpRoot, name));
    // 300 ended sessions under one slug: more than discover() lists.
    for (let i = 0; i < 300; i++) {
        const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
        t.pad('-config', id, null);
    }
    t.record(100, { sessionId: A, kind: 'interactive', updatedAt: 9 });
    const dir = t.pad('-config', A);
    const { active, dirs } = await createScratchpads({ ...t, isAlive: alive(100), log: quiet }).discover();
    assert.strictEqual(active, A);
    assert.strictEqual(dirs.get(A), dir);
});

test('ended sessions: the newest are listed, whatever order readdir gives, and empty folders take no place', async () => {
    const t = tree();
    const ids = [];
    // 300 ended sessions under one slug, as every session started in /config
    // shares one. Folder mtimes rise with the index, so the newest 50 are the
    // last 50 by name and by creation, wherever readdir puts them.
    for (let i = 0; i < 300; i++) {
        const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
        const dir = t.pad('-config', id, null);
        const when = new Date(Date.UTC(2026, 0, 1) + i * 60_000);
        fs.utimesSync(dir, when, when);
        ids.push(id);
    }
    // uuid folders with no scratchpad inside: nothing to list, and no cap spent.
    for (let i = 0; i < 300; i++) fs.mkdirSync(path.join(t.tmpRoot, '-config', `ffffffff-0000-4000-8000-${String(i).padStart(12, '0')}`));
    const { active, sessions } = await createScratchpads({ ...t, isAlive: alive(), log: quiet }).discover();
    assert.deepStrictEqual(sessions.map((x) => x.id), ids.slice(-50).reverse());
    assert.strictEqual(active, ids[299], 'the newest folder');
});

test('symlinks: a scratchpad that is a symlink, or a slug pointing out of the tmp root, is refused', async () => {
    const t = tree();
    const outside = path.join(base, `outside${n++}`);
    fs.mkdirSync(path.join(outside, A, 'scratchpad'), { recursive: true });
    fs.mkdirSync(path.join(t.tmpRoot, '-config', B), { recursive: true });
    fs.symlinkSync(path.join(outside, A, 'scratchpad'), path.join(t.tmpRoot, '-config', B, 'scratchpad'));
    fs.symlinkSync(outside, path.join(t.tmpRoot, '-escape'));
    // cwd /escape makes A's direct slug lookup go through the -escape symlink.
    t.record(100, { sessionId: A, cwd: '/escape' });
    t.record(101, { sessionId: B });
    const { dirs } = await createScratchpads({ ...t, isAlive: alive(100, 101), log: quiet }).discover();
    assert.strictEqual(dirs.size, 0, [...dirs.values()].join(', '));
});

test('active: newest interactive live session wins over a newer non-interactive one', async () => {
    const t = tree();
    t.record(100, { sessionId: A, kind: 'interactive', updatedAt: 5 });
    t.record(101, { sessionId: B, kind: 'print', updatedAt: 9 });
    t.record(102, { sessionId: C, kind: 'interactive', updatedAt: 7 });
    const { active, sessions } = await createScratchpads({ ...t, isAlive: alive(100, 101, 102), log: quiet }).discover();
    assert.strictEqual(active, C);
    assert.deepStrictEqual(sessions.map((x) => x.id), [B, C, A], 'live, newest first');
});

test('at most 50 sessions are listed', async () => {
    const t = tree();
    for (let i = 0; i < 60; i++) t.pad(`-s${i}`, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, null);
    const { sessions } = await createScratchpads({ ...t, isAlive: alive(), log: quiet }).discover();
    assert.strictEqual(sessions.length, 50);
});

test('unreadable or missing folders degrade; discover() never rejects', async () => {
    const t = tree();
    t.pad('-config', A);
    const gone = { sessionsDir: path.join(base, 'nope', 'sessions'), tmpRoot: t.tmpRoot };
    let r = await createScratchpads({ ...gone, isAlive: alive(), log: quiet }).discover();
    assert.strictEqual(r.active, A, 'no sessions dir: folders still listed');
    r = await createScratchpads({ sessionsDir: t.sessionsDir, tmpRoot: path.join(base, 'nope', 'tmp'), isAlive: alive(), log: quiet }).discover();
    assert.deepStrictEqual(r, { active: null, sessions: [], dirs: new Map() });
    const broken = { ...fsp, readdir: async () => { throw Object.assign(new Error('boom'), { code: 'EIO' }); } };
    const logged = [];
    const s = createScratchpads({ ...t, fs: broken, isAlive: alive(), log: (m) => logged.push(m) });
    r = await s.discover();
    await s.discover();
    assert.deepStrictEqual(r.sessions, []);
    assert.strictEqual(logged.length, new Set(logged).size, 'each failure is logged once');
    assert.ok(logged.length >= 1);
});

test('a record whose procStart is not its process\'s start time (a reused PID) is not live', async () => {
    const t = tree();
    t.record(100, { sessionId: A, kind: 'interactive', updatedAt: 9, procStart: '111' });
    t.record(101, { sessionId: B, kind: 'interactive', updatedAt: 5, procStart: '333' });
    t.record(102, { sessionId: C, kind: 'interactive', updatedAt: 1 });   // no procStart: accepted
    const starts = { 100: '222', 101: '333', 102: '444' };
    const s = createScratchpads({ ...t, isAlive: alive(100, 101, 102), procStartOf: async (pid) => starts[pid] ?? null, log: quiet });
    const { active, sessions } = await s.discover();
    assert.deepStrictEqual(sessions.map((x) => x.id), [B, C]);
    assert.strictEqual(active, B);
});

test('procStart is not checked when it is not digits, or where the start time cannot be read', async () => {
    const t = tree();
    t.record(100, { sessionId: A, updatedAt: 9, procStart: 'Mon Nov  2 13:50:25 2026' });   // macOS shape
    t.record(101, { sessionId: B, updatedAt: 5, procStart: '111' });
    let r = await createScratchpads({ ...t, isAlive: alive(100, 101), procStartOf: async () => null, log: quiet }).discover();
    assert.deepStrictEqual(r.sessions.map((x) => x.id), [A, B], 'no start time: both accepted');
    r = await createScratchpads({ ...t, isAlive: alive(100, 101), procStartOf: async () => '222', log: quiet }).discover();
    assert.deepStrictEqual(r.sessions.map((x) => x.id), [A], 'the date-shaped one is not checked');
});

test('dead records are never opened, and any number of them cannot hide a live one', async () => {
    const t = tree();
    for (let pid = 1000; pid < 1100; pid++) {
        t.record(pid, { sessionId: `00000000-0000-4000-8000-${String(pid).padStart(12, '0')}`, updatedAt: 1 });
    }
    t.record(5000, { sessionId: A, kind: 'interactive', updatedAt: 2 });
    const opened = [];
    const readFiles = [];
    const spy = {
        ...fsp,
        open: (p, ...rest) => { opened.push(path.basename(p)); return fsp.open(p, ...rest); },
        readFile: (p, ...rest) => { readFiles.push(path.basename(String(p))); return fsp.readFile(p, ...rest); },
    };
    const { active } = await createScratchpads({ ...t, fs: spy, isAlive: alive(5000), log: quiet }).discover();
    assert.strictEqual(active, A);
    assert.deepStrictEqual(opened, ['5000.json']);
    assert.ok(readFiles.every((f) => f === '5000.json'), readFiles.join(', '));
});

test('two records of one session: the newer updatedAt wins, whichever is read first', async () => {
    for (const [older, newer] of [[100, 101], [101, 100]]) {
        const t = tree();
        t.record(older, { sessionId: A, updatedAt: 5, status: 'idle' });
        t.record(newer, { sessionId: A, updatedAt: 9, status: 'busy' });
        const { sessions } = await createScratchpads({ ...t, isAlive: alive(100, 101), log: quiet }).discover();
        assert.deepStrictEqual(sessions.map((x) => [x.id, x.status]), [[A, 'busy']], `newer is ${newer}.json`);
    }
});

test('0.json is never probed: kill(0) would ask about our own process group', async () => {
    const t = tree();
    t.record(0, { sessionId: A });
    const asked = [];
    const isAlive = async (pid) => { asked.push(pid); return true; };
    const { sessions } = await createScratchpads({ ...t, isAlive, log: quiet }).discover();
    assert.deepStrictEqual(sessions, []);
    assert.deepStrictEqual(asked, []);
});

test('a FIFO named <pid>.json is refused, not waited on', async (ctx) => {
    const t = tree();
    const fifo = path.join(t.sessionsDir, '100.json');
    try {
        execFileSync('mkfifo', [fifo]);
    } catch {
        ctx.skip('mkfifo is not available');
        return;
    }
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), 2000); });
    try {
        const won = await Promise.race([
            createScratchpads({ ...t, isAlive: alive(100), log: quiet }).discover(),
            timeout,
        ]);
        assert.notStrictEqual(won, 'timeout', 'discover() blocked opening the FIFO');
        assert.deepStrictEqual(won.sessions, []);
    } finally {
        clearTimeout(timer);
        // Should a reader be stuck in open(), a writer arriving frees it, so
        // a failure here cannot hang the suite. With no reader, ENXIO.
        try {
            fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
        } catch { /* no reader: nothing to free */ }
    }
});

test('a session folder (the uuid level) symlinked out of the tmp root is refused', async () => {
    const t = tree();
    const outside = path.join(base, `outside${n++}`);
    fs.mkdirSync(path.join(outside, 'scratchpad'), { recursive: true });
    fs.mkdirSync(path.join(t.tmpRoot, '-config'), { recursive: true });
    fs.symlinkSync(outside, path.join(t.tmpRoot, '-config', A));
    t.record(100, { sessionId: A });
    const { dirs, sessions } = await createScratchpads({ ...t, isAlive: alive(100), log: quiet }).discover();
    assert.strictEqual(dirs.size, 0, [...dirs.values()].join(', '));
    assert.strictEqual(sessions[0].exists, false);
});

test('a live session\'s folder under its cwd\'s slug is found past MAX_TMP_ENTRIES other folders', async () => {
    const t = tree();
    t.record(100, { sessionId: A, cwd: '/config', kind: 'interactive' });
    const dir = t.pad('-config', A);
    // fs.readdir returns names sorted, and `-aN` sorts before `-config`, so a
    // scan-only lookup never reaches the live folder.
    for (let i = 0; i < 1100; i++) fs.mkdirSync(path.join(t.tmpRoot, `-a${i}`));
    const { active, dirs } = await createScratchpads({ ...t, isAlive: alive(100), log: quiet }).discover();
    assert.strictEqual(active, A);
    assert.strictEqual(dirs.get(A), dir);
});

test('startTimeFromStat: field 22, whatever comm holds', () => {
    const tail = (st) => ` S 1 1 1 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 ${st} 1000 50 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0\n`;
    assert.strictEqual(startTimeFromStat(`74306 (claude)${tail('54924465')}`), '54924465');
    assert.strictEqual(startTimeFromStat(`74306 (a) b) c)${tail('54924465')}`), '54924465', 'comm with ") "');
    assert.strictEqual(startTimeFromStat(`74306 ( ) 1 2 3 4)${tail('54924465')}`), '54924465', 'comm that looks like fields');
    assert.strictEqual(startTimeFromStat(`74306 (x\ny)${tail('7')}`), '7', 'comm with a newline');
    assert.strictEqual(startTimeFromStat('74306 (claude) S 1 1'), null, 'truncated');
    assert.strictEqual(startTimeFromStat('1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22'), null, 'no comm');
});

test('defaultProcStartOf: digits where /proc exists, else null; null for a dead PID', async () => {
    const start = await defaultProcStartOf(process.pid);
    if (fs.existsSync('/proc/self/stat')) assert.match(start, /^\d+$/);
    else assert.strictEqual(start, null);
    assert.strictEqual(await defaultProcStartOf(2 ** 30), null, 'a dead PID has no start time');
});

test('looksLikeClaude: an argument whose basename is claude', () => {
    assert.ok(looksLikeClaude('claude\0'));
    assert.ok(looksLikeClaude('/root/.local/bin/claude\0--resume\0'));
    assert.ok(!looksLikeClaude('sleep\x00600\x00'));
    assert.ok(!looksLikeClaude('/usr/bin/claudette\0'));
    assert.ok(!looksLikeClaude(''));
});

test('defaultIsAlive: a dead PID is not; where /proc exists, a live non-claude process is not either', async () => {
    // Above the kernel's pid_max on Linux and macOS: never a running process.
    assert.strictEqual(await defaultIsAlive(2 ** 30), false);
    // This test process is alive but its argv is node, not claude: a reused PID.
    const hasProc = fs.existsSync('/proc/self/cmdline');
    assert.strictEqual(await defaultIsAlive(process.pid), !hasProc,
        hasProc ? 'with /proc, a non-claude process is not a session' : 'without /proc, kill() is all there is');
});

// --- router ---

async function withRouter(t, { isAlive = alive(), filesLimiter = createRateLimiter({ max: 1000 }), scratchpads } = {}, fn) {
    const app = express();
    app.use('/api/scratchpad', createScratchpadRouter({
        scratchpads: scratchpads || createScratchpads({ ...t, isAlive, log: quiet }),
        filesLimiter,
        zipLimiter: createRateLimiter({ max: 1000 }),
        zipSlots: createZipSlots(2),
        log: quiet,
    }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        await fn(`http://127.0.0.1:${server.address().port}/api/scratchpad`);
    } finally {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
    }
}

test('router: /sessions answers the public fields, no-store, and is not taken for an id', async () => {
    const t = tree();
    t.record(100, { sessionId: A, kind: 'interactive', name: 'main', updatedAt: 1 });
    t.pad('-config', A);
    await withRouter(t, { isAlive: alive(100) }, async (url) => {
        const res = await fetch(`${url}/sessions`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get('cache-control'), 'no-store');
        const body = await res.json();
        assert.strictEqual(body.active, A);
        assert.deepStrictEqual(Object.keys(body.sessions[0]).sort(),
            ['cwd', 'exists', 'id', 'kind', 'label', 'live', 'mtime', 'status', 'updatedAt']);
        assert.ok(!JSON.stringify(body).includes(t.tmpRoot), 'folder paths stay server-side here');
    });
});

test('router: list (empty path = the root), preview, confinement and tiers', async () => {
    const t = tree();
    const dir = t.pad('-config', A);
    fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=1\n');
    fs.writeFileSync(path.join(t.tmpRoot, 'outside.txt'), 'NO');
    await withRouter(t, {}, async (url) => {
        let res = await fetch(`${url}/${A}/list?path=`);
        assert.strictEqual(res.status, 200);
        const listing = await res.json();
        assert.strictEqual(listing.root, dir);
        assert.deepStrictEqual(listing.entries.map((e) => e.name).sort(), ['.env', 'note.md']);
        res = await fetch(`${url}/${A}/preview?path=note.md`);
        assert.strictEqual((await res.json()).content, 'x');
        for (const p of ['../../outside.txt', path.join(t.tmpRoot, 'outside.txt')]) {
            assert.strictEqual((await fetch(`${url}/${A}/preview?path=${encodeURIComponent(p)}`)).status, 404, p);
        }
        assert.strictEqual((await fetch(`${url}/${A}/preview?path=.env`)).status, 403);
        assert.strictEqual((await fetch(`${url}/${A}/preview?path=.env&protected=1`)).status, 200);
    });
});

test('router: bad and unknown ids are 404; a bad id never reaches discovery', async () => {
    const t = tree();
    t.pad('-config', A);
    let discovered = 0;
    const real = createScratchpads({ ...t, isAlive: alive(), log: quiet });
    const counting = { discover: () => { discovered++; return real.discover(); } };
    await withRouter(t, { scratchpads: counting }, async (url) => {
        assert.strictEqual((await fetch(`${url}/not-a-uuid/list`)).status, 404);
        assert.strictEqual(discovered, 0);
        const res = await fetch(`${url}/${B}/list`);
        assert.strictEqual(res.status, 404);
        assert.match((await res.json()).error, /No such scratchpad/);
    });
});

test('router: read-only, no HA check, and downloads keep the same-site guard', async () => {
    const t = tree();
    t.pad('-config', A);
    await withRouter(t, {}, async (url) => {
        for (const [p, method] of [['upload?name=x', 'POST'], ['ha-check', 'POST'], ['nope', 'GET']]) {
            const res = await fetch(`${url}/${A}/${p}`, { method, body: method === 'POST' ? 'x' : undefined });
            assert.strictEqual(res.status, 404, p);
            assert.match(res.headers.get('content-type'), /json/, p);
        }
        const cross = await fetch(`${url}/${A}/download?path=note.md`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
        assert.strictEqual(cross.status, 403);
        const ok = await fetch(`${url}/${A}/download?path=note.md`);
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(await ok.text(), 'x');
    });
});

test('router: an over-limit request is refused before discovery runs', async () => {
    const t = tree();
    t.pad('-config', A);
    let discovered = 0;
    const real = createScratchpads({ ...t, isAlive: alive(), log: quiet });
    const counting = { discover: () => { discovered++; return real.discover(); } };
    await withRouter(t, { scratchpads: counting, filesLimiter: createRateLimiter({ max: 1 }) }, async (url) => {
        assert.strictEqual((await fetch(`${url}/${A}/list`)).status, 200);
        const before = discovered;
        assert.strictEqual((await fetch(`${url}/${A}/list`)).status, 429);
        assert.strictEqual(discovered, before);
    });
});

test('router: a folder that disappears drops its cached router', async () => {
    const t = tree();
    const dir = t.pad('-config', A);
    await withRouter(t, {}, async (url) => {
        assert.strictEqual((await fetch(`${url}/${A}/list`)).status, 200);
        fs.rmSync(path.dirname(dir), { recursive: true });
        assert.strictEqual((await fetch(`${url}/${A}/list`)).status, 404);
    });
});

test('router: a folder swapped for a symlink after discovery is refused by the realpath re-check', async () => {
    const t = tree();
    const dir = t.pad('-config', A);
    const other = t.pad('-other', B);
    // A stub whose dirs map still names dir, as a discover() that ran just
    // before the swap would: only the router's own check can catch it now.
    const stub = { discover: async () => ({ active: A, sessions: [], dirs: new Map([[A, dir]]) }) };
    await withRouter(t, { scratchpads: stub }, async (url) => {
        assert.strictEqual((await fetch(`${url}/${A}/list`)).status, 200);
        fs.rmSync(dir, { recursive: true });
        fs.symlinkSync(other, dir);
        assert.strictEqual((await fetch(`${url}/${A}/list`)).status, 404);
    });
});

test('router: when an id moves to another folder, the new folder is served, not the cached one', async () => {
    const t = tree();
    const dir1 = t.pad('-one', A, 'one.md');
    const dir2 = t.pad('-two', A, 'two.md');
    let call = 0;
    const stub = { discover: async () => ({ active: A, sessions: [], dirs: new Map([[A, call++ === 0 ? dir1 : dir2]]) }) };
    await withRouter(t, { scratchpads: stub }, async (url) => {
        const names = async () => (await (await fetch(`${url}/${A}/list?path=`)).json()).entries.map((e) => e.name);
        assert.deepStrictEqual(await names(), ['one.md']);
        assert.deepStrictEqual(await names(), ['two.md']);
    });
});
