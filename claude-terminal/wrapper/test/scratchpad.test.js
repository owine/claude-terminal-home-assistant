'use strict';

// The Scratchpad tab's discovery (scratchpad.js): which Claude Code sessions
// exist, which is active, and where each one's scratchpad folder is. Each
// test builds its own tree: sessions/ stands in for ~/.claude/sessions and
// tmp/ for /tmp/claude-0. isAlive is injected; the default (kill + /proc) has
// a test of its own at the end.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createScratchpads, looksLikeClaude, defaultIsAlive, UUID } = require('../scratchpad.js');

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
    // 300 ended sessions under one slug: more than the per-entry and total caps.
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

test('symlinks: a scratchpad that is a symlink, or a slug pointing out of the tmp root, is refused', async () => {
    const t = tree();
    const outside = path.join(base, `outside${n++}`);
    fs.mkdirSync(path.join(outside, A, 'scratchpad'), { recursive: true });
    fs.mkdirSync(path.join(t.tmpRoot, '-config', B), { recursive: true });
    fs.symlinkSync(path.join(outside, A, 'scratchpad'), path.join(t.tmpRoot, '-config', B, 'scratchpad'));
    fs.symlinkSync(outside, path.join(t.tmpRoot, '-escape'));
    t.record(100, { sessionId: A });
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
