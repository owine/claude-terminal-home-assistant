'use strict';

const assert = require('node:assert');
const {
    createLoginNotifier,
    loginNotifierFromEnv,
    notificationBody,
    NOTIFICATION_ID,
} = require('../login-notifier.js');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const NOW = 1_800_000_000_000;
const URL_A = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=AAA';
const URL_B = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=BBB';
const CRED_PATH = '/home/.claude/.credentials.json';

// A fake world for one notifier: a tmux pane, a credentials file and the
// Supervisor. Each piece is mutable so a test can move it between ticks.
function world() {
    const w = {
        screen: '',            // what capture-pane prints; null = no session
        width: '80',
        credentials: null,     // file contents; null = missing
        status: 200,           // Supervisor response status; 'throw' = network error
        calls: [],             // [{ service, body, headers }]
        logs: [],
        captures: 0,           // capture-pane calls, i.e. ticks that got that far
        gate: null,            // a promise execFile waits on, to hold a tick in flight
        fetchGate: null,       // the same for fetch
    };
    w.execFile = async (file, args, opts, cb) => {
        assert.strictEqual(file, 'tmux');
        if (args[0] === 'capture-pane') w.captures++;
        if (w.gate) await w.gate;
        if (w.screen === null) return cb(new Error('no server running'));
        if (args[0] === 'capture-pane') return cb(null, w.screen);
        if (args[0] === 'display-message') return cb(null, `${w.width}\n`);
        return cb(new Error(`unexpected tmux ${args[0]}`));
    };
    w.readFile = async (p) => {
        assert.strictEqual(p, CRED_PATH);
        if (w.credentials === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return w.credentials;
    };
    w.fetch = async (url, init) => {
        const service = url.split('/').pop();
        w.calls.push({ url, service, body: JSON.parse(init.body), headers: init.headers });
        if (w.fetchGate) await w.fetchGate;
        if (w.status === 'throw') throw new Error('connect ECONNREFUSED');
        return { ok: w.status >= 200 && w.status < 300, status: w.status };
    };
    w.notifier = (opts = {}) => createLoginNotifier({
        supervisorToken: 'SUPTOKEN',
        homeDir: '/home',
        execFile: w.execFile,
        readFile: w.readFile,
        fetch: w.fetch,
        now: () => NOW,
        log: { log: (m) => w.logs.push(m) },
        ...opts,
    });
    w.loggedIn = (expiresAt = NOW + 3600_000) => {
        w.credentials = JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt } });
    };
    w.loginScreen = (url) => {
        w.screen = ['Browser didn\'t open? Use the url below to sign in:', '', url, '', 'Paste code here if prompted > '].join('\n');
    };
    w.services = () => w.calls.map((c) => c.service);
    return w;
}

// --- posting ---

test('posts the login URL found on the pane', async () => {
    const w = world();
    w.loginScreen(URL_A);
    await w.notifier().tick();
    assert.deepStrictEqual(w.services(), ['create']);
    const call = w.calls[0];
    assert.strictEqual(call.url, 'http://supervisor/core/api/services/persistent_notification/create');
    assert.strictEqual(call.headers.Authorization, 'Bearer SUPTOKEN');
    assert.strictEqual(call.body.notification_id, NOTIFICATION_ID);
    assert.ok(call.body.message.includes(`](${URL_A})`), 'markdown link');
    assert.ok(call.body.message.includes(`\`${URL_A}\``), 'plain-text fallback');
    assert.match(call.body.message, /paste the code/i);
});

test('rebuilds a URL Ink hard-wrapped across rows, using the pane width', async () => {
    const w = world();
    w.width = '40';
    const rows = [URL_A.slice(0, 40), URL_A.slice(40)];
    w.screen = ['Sign in:', ...rows, '', 'Paste code here if prompted >'].join('\n');
    await w.notifier().tick();
    assert.strictEqual(w.calls.length, 1);
    assert.ok(w.calls[0].body.message.includes(URL_A));
});

test('posts nothing when the pane has no auth URL', async () => {
    const w = world();
    w.screen = 'https://claude.ai/code/session_123 is a Remote Control link\n$ ';
    await w.notifier().tick();
    assert.deepStrictEqual(w.calls, []);
});

test('posts nothing while logged in, even with a URL on screen', async () => {
    const w = world();
    w.loggedIn();
    w.loginScreen(URL_A);
    await w.notifier().tick();
    assert.deepStrictEqual(w.calls, []);
});

test('the same URL is posted once, not every poll', async () => {
    const w = world();
    w.loginScreen(URL_A);
    const n = w.notifier();
    await n.tick();
    await n.tick();
    await n.tick();
    assert.deepStrictEqual(w.services(), ['create']);
});

test('a new login (new URL) is posted again', async () => {
    const w = world();
    const n = w.notifier();
    w.loginScreen(URL_A);
    await n.tick();
    w.loginScreen(URL_B);
    await n.tick();
    assert.deepStrictEqual(w.services(), ['create', 'create']);
    assert.ok(w.calls[1].body.message.includes(URL_B));
});

// --- dismissal ---

test('dismisses once the login succeeds', async () => {
    const w = world();
    const n = w.notifier();
    w.loginScreen(URL_A);
    await n.tick();
    w.loggedIn();
    await n.tick();
    await n.tick();
    assert.deepStrictEqual(w.services(), ['create', 'dismiss']);
    assert.deepStrictEqual(w.calls[1].body, { notification_id: NOTIFICATION_ID });
});

test('a used URL is not re-posted when the access token later expires', async () => {
    const w = world();
    const n = w.notifier();
    w.loginScreen(URL_A);
    await n.tick();
    w.loggedIn();
    await n.tick();
    w.loggedIn(NOW - 1); // expired, URL still on screen
    await n.tick();
    assert.deepStrictEqual(w.services(), ['create', 'dismiss']);
});

test('a failed dismiss is retried on the next poll', async () => {
    const w = world();
    const n = w.notifier();
    w.loginScreen(URL_A);
    await n.tick();
    w.loggedIn();
    w.status = 500;
    await n.tick();
    w.status = 200;
    await n.tick();
    await n.tick();
    assert.deepStrictEqual(w.services(), ['create', 'dismiss', 'dismiss']);
});

test('a failed create is retried on the next poll', async () => {
    const w = world();
    const n = w.notifier();
    w.loginScreen(URL_A);
    w.status = 'throw';
    await n.tick();
    w.status = 200;
    await n.tick();
    await n.tick();
    assert.deepStrictEqual(w.services(), ['create', 'create']);
});

// A Console (API-billing) login stores an API key in ~/.claude.json and never
// writes claudeAiOauth, so the credentials check never sees it finish. The
// login screen going away is what ends it.
test('Console login: dismissed once the URL has left the pane for two polls', async () => {
    const w = world();
    w.credentials = '{}';
    const n = w.notifier();
    w.loginScreen(URL_A);
    await n.tick();
    w.screen = 'Login successful. Press Enter to continue\n> ';
    await n.tick();
    assert.deepStrictEqual(w.services(), ['create'], 'not after one poll');
    await n.tick();
    await n.tick();
    await n.tick();
    assert.deepStrictEqual(w.services(), ['create', 'dismiss']);
    assert.ok(w.logs.some((m) => /login screen gone/.test(m)));
});

test('aborted login (claude exited to a shell): dismissed after two polls', async () => {
    const w = world();
    const n = w.notifier();
    w.loginScreen(URL_A);
    await n.tick();
    w.screen = 'root@ha:/config# ';
    await n.tick();
    await n.tick();
    assert.deepStrictEqual(w.services(), ['create', 'dismiss']);
});

// The capture sees the active window of the session only. Switching to
// another tmux window for a few seconds takes the URL off the capture while
// the login still waits for its code. It was dismissed for good: a URL once
// posted was never posted again.
test('a login screen that leaves the capture and comes back is posted again', async () => {
    const w = world();
    const n = w.notifier();
    w.loginScreen(URL_A);
    await n.tick();
    w.screen = 'root@ha:/config# '; // another window
    await n.tick();
    await n.tick();
    assert.deepStrictEqual(w.services(), ['create', 'dismiss']);
    w.loginScreen(URL_A);
    await n.tick();
    await n.tick();
    assert.deepStrictEqual(w.services(), ['create', 'dismiss', 'create']);
    assert.ok(w.calls[2].body.message.includes(URL_A));
});

test('a link dismissed because the login completed is still never re-posted', async () => {
    const w = world();
    const n = w.notifier();
    w.loginScreen(URL_A);
    await n.tick();
    w.loggedIn();
    await n.tick();
    w.screen = '';
    await n.tick();
    w.loggedIn(NOW - 1);
    w.loginScreen(URL_A);
    await n.tick();
    assert.deepStrictEqual(w.services(), ['create', 'dismiss']);
});

// --- truncated captures ---
//
// capture-pane and the pane-width query are two tmux calls. One that lands
// mid-resize rebuilds the URL from rows at the wrong width and stops short:
// a prefix of the real URL that still looks like an auth URL. Posted, it
// replaced the good link with a broken one, and the good one - already
// posted - was never put back.

const TRUNCATED_A = URL_A.slice(0, 50);

test('a truncated capture of the posted URL does not replace it', async () => {
    assert.ok(require('../public/login-link.js').isAuthUrl(TRUNCATED_A), 'fixture still looks like an auth URL');
    const w = world();
    const n = w.notifier();
    w.loginScreen(URL_A);
    await n.tick();
    w.loginScreen(TRUNCATED_A);
    await n.tick();
    w.loginScreen(URL_A);
    await n.tick();
    assert.deepStrictEqual(w.services(), ['create']);
});

test('a truncated capture still counts as the login screen being up', async () => {
    const w = world();
    const n = w.notifier();
    w.loginScreen(URL_A);
    await n.tick();
    w.loginScreen(TRUNCATED_A);
    for (let i = 0; i < 4; i++) await n.tick();
    assert.deepStrictEqual(w.services(), ['create']);
});

test('a truncated URL seen first is replaced by the full one', async () => {
    const w = world();
    const n = w.notifier();
    w.loginScreen(TRUNCATED_A);
    await n.tick();
    w.loginScreen(URL_A);
    await n.tick();
    w.loginScreen(TRUNCATED_A);
    await n.tick();
    assert.deepStrictEqual(w.services(), ['create', 'create']);
    assert.ok(w.calls[1].body.message.includes(`\`${URL_A}\``));
});

test('a single blank capture between good ones does not dismiss', async () => {
    const w = world();
    const n = w.notifier();
    w.loginScreen(URL_A);
    await n.tick();
    w.screen = '';
    await n.tick();
    w.loginScreen(URL_A);
    await n.tick();
    w.screen = '';
    await n.tick();
    w.loginScreen(URL_A);
    await n.tick();
    assert.deepStrictEqual(w.services(), ['create']);
});

test('failed captures do not count towards dismissal', async () => {
    const w = world();
    const n = w.notifier();
    w.loginScreen(URL_A);
    await n.tick();
    w.screen = null; // tmux unreachable
    for (let i = 0; i < 5; i++) await n.tick();
    assert.deepStrictEqual(w.services(), ['create']);
});

// --- logging ---

test('a Supervisor that keeps failing logs once, then once on recovery', async () => {
    const w = world();
    const n = w.notifier();
    w.loginScreen(URL_A);
    w.status = 502;
    for (let i = 0; i < 10; i++) await n.tick();
    assert.strictEqual(w.calls.length, 10, 'still retried every poll');
    assert.strictEqual(w.logs.filter((m) => /HTTP 502/.test(m)).length, 1);
    w.status = 401;
    await n.tick();
    await n.tick();
    assert.strictEqual(w.logs.filter((m) => /HTTP 401/.test(m)).length, 1, 'a new failure is logged');
    w.status = 200;
    await n.tick();
    assert.strictEqual(w.logs.filter((m) => /working again/.test(m)).length, 1);
    assert.ok(w.logs.some((m) => /posted/.test(m)));
});

// --- polling loop ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the loop keeps polling until stop(), then stops', async () => {
    const w = world();
    const n = w.notifier({ pollMs: 5 });
    await n.start();
    await sleep(60);
    n.stop();
    const seen = w.captures;
    assert.ok(seen >= 3, `polled ${seen} times`);
    await sleep(40);
    assert.strictEqual(w.captures, seen, 'no polls after stop()');
});

test('stop() during start()\'s dismiss leaves no loop behind', async () => {
    const w = world();
    let release;
    w.fetchGate = new Promise((r) => { release = r; });
    const n = w.notifier({ pollMs: 5 });
    const starting = n.start();
    n.stop();
    w.fetchGate = null;
    release();
    await starting;
    await sleep(40);
    assert.strictEqual(w.captures, 0);
});

test('stop() then start() during an in-flight tick runs one loop, not two', async () => {
    const w = world();
    const n = w.notifier({ pollMs: 5 });
    await n.start();
    let release;
    w.gate = new Promise((r) => { release = r; });
    await sleep(20);            // first loop's tick is now held in execFile
    n.stop();
    await n.start();            // second loop
    w.gate = null;
    release();                  // first loop's tick finishes
    await sleep(30);
    n.stop();                   // stops the second loop; an orphaned first would carry on
    const seen = w.captures;
    await sleep(40);
    assert.strictEqual(w.captures, seen, 'no loop survives stop()');
});

test('start() clears a stale notification before polling', async () => {
    const w = world();
    const n = w.notifier();
    await n.start();
    n.stop();
    assert.deepStrictEqual(w.services(), ['dismiss']);
});

// --- logged-in detection ---

test('credentials without claudeAiOauth, or unparseable, read as logged out', async () => {
    for (const contents of ['{}', 'not json', JSON.stringify({ claudeAiOauth: {} })]) {
        const w = world();
        w.credentials = contents;
        w.loginScreen(URL_A);
        await w.notifier().tick();
        assert.deepStrictEqual(w.services(), ['create'], contents);
    }
});

// --- never throws ---

test('no tmux session yet: tick resolves quietly', async () => {
    const w = world();
    w.screen = null;
    await w.notifier().tick();
    assert.deepStrictEqual(w.calls, []);
});

test('tick never rejects, even when every dependency throws', async () => {
    const boom = () => { throw new Error('boom'); };
    const n = createLoginNotifier({
        supervisorToken: 't',
        homeDir: '/home',
        execFile: boom,
        readFile: boom,
        fetch: boom,
        now: boom,
        log: { log: () => {} },
    });
    await n.tick();
    await n.start();
    n.stop();
});

// --- notification body ---

test('parentheses and whitespace in the URL cannot break the markdown link', () => {
    const { message } = notificationBody('https://claude.ai/oauth/authorize?x=(a b)');
    assert.ok(message.includes('](https://claude.ai/oauth/authorize?x=%28a%20b%29)'));
});

// --- loginNotifierFromEnv ---

test('from env: runs with a Supervisor token and the option on or unset', () => {
    assert.ok(loginNotifierFromEnv({ SUPERVISOR_TOKEN: 't' }));
    assert.ok(loginNotifierFromEnv({ SUPERVISOR_TOKEN: 't', LOGIN_NOTIFICATION: 'true' }));
});

test('from env: off when the option is false', () => {
    assert.strictEqual(loginNotifierFromEnv({ SUPERVISOR_TOKEN: 't', LOGIN_NOTIFICATION: 'false' }), null);
});

test('from env: off without a Supervisor token (local dev, no HA)', () => {
    assert.strictEqual(loginNotifierFromEnv({}), null);
});

test('from env: off with token auth, where there is no browser login', () => {
    assert.strictEqual(loginNotifierFromEnv({ SUPERVISOR_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'sk' }), null);
});

(async () => {
    for (const { name, fn } of tests) {
        try {
            await fn();
            passed++;
            console.log(`ok - ${name}`);
        } catch (err) {
            console.error(`FAIL - ${name}`);
            console.error(err.stack || err.message);
            process.exitCode = 1;
        }
    }
    console.log(`\n${passed}/${tests.length} login-notifier tests passed`);
})();
