'use strict';

const assert = require('node:assert');
const { createRateLimiter, createOriginGuard, createUpgradeGuard, createCrossSiteGuard, errorResponseFor } = require('../http-guards.js');

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`ok - ${name}`);
    } catch (err) {
        console.error(`FAIL - ${name}`);
        console.error(err.message);
        process.exitCode = 1;
    }
}

// Minimal Express-shaped doubles. The real thing is not needed: every unit
// under test reads a couple of headers and either calls next() or writes a
// status and a JSON body.
function makeReq({ method = 'GET', headers = {}, ip = '10.0.0.1' } = {}) {
    const lower = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    return {
        method,
        ip,
        socket: { remoteAddress: ip },
        get(name) { return lower[name.toLowerCase()]; },
    };
}

function makeRes() {
    return {
        statusCode: null,
        body: null,
        headers: {},
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
        set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    };
}

// Runs a middleware and reports what it did, so assertions read as behaviour
// ("was it allowed?") rather than as call bookkeeping.
function run(middleware, req) {
    const res = makeRes();
    let nexted = false;
    middleware(req, res, () => { nexted = true; });
    return { allowed: nexted, status: res.statusCode, body: res.body };
}

// ---------------------------------------------------------------------------
// createOriginGuard
// ---------------------------------------------------------------------------
//
// This is the wrapper's only defence against a page on another origin POSTing
// to the add-on through a user's browser. It is deliberately permissive about
// a MISSING Origin (curl, and non-browser clients generally) and strict about
// a present one that does not match.
//
// Every guard here is built with a silenced logger so a blocked request does
// not print during the run; one case below asserts the logging itself.
const silent = { log: () => {} };

test('lets non-POST requests through untouched', () => {
    const guard = createOriginGuard(silent);
    assert.strictEqual(run(guard, makeReq({ method: 'GET' })).allowed, true);
});

test('allows a POST with no Origin and no Referer', () => {
    // curl and server-to-server callers send neither. A browser always sends
    // one on a cross-origin POST, so absence is not the attack case.
    const guard = createOriginGuard(silent);
    const req = makeReq({ method: 'POST', headers: { Host: 'ha.local:7680' } });
    assert.strictEqual(run(guard, req).allowed, true);
});

test('allows a POST whose Origin matches the Host', () => {
    const guard = createOriginGuard(silent);
    const req = makeReq({
        method: 'POST',
        headers: { Host: 'ha.local:7680', Origin: 'http://ha.local:7680' },
    });
    assert.strictEqual(run(guard, req).allowed, true);
});

test('allows a POST whose Referer matches the Host when Origin is absent', () => {
    const guard = createOriginGuard(silent);
    const req = makeReq({
        method: 'POST',
        headers: { Host: 'ha.local:7680', Referer: 'http://ha.local:7680/index.html' },
    });
    assert.strictEqual(run(guard, req).allowed, true);
});

// Both sides of the comparison have to have been through the same
// normalization. `new URL(origin).host` lowercases the hostname and drops a
// default port; the raw Host header gets neither, so comparing them directly
// rejects requests that are in fact same-origin. Same bug class as the
// canonicalization note in prune_claude_versions (run.sh).
test('allows a same-origin POST when the Host header differs only in case', () => {
    const guard = createOriginGuard(silent);
    const req = makeReq({
        method: 'POST',
        headers: { Host: 'HA.LOCAL:7680', Origin: 'http://HA.LOCAL:7680' },
    });
    assert.strictEqual(run(guard, req).allowed, true);
});

test('allows a same-origin POST when only one side spells out the default port', () => {
    // Origin http://ha.local:80 parses to host "ha.local"; a proxy that passes
    // the Host through unnormalized still says "ha.local:80".
    const guard = createOriginGuard(silent);
    const req = makeReq({
        method: 'POST',
        headers: { Host: 'ha.local:80', Origin: 'http://ha.local' },
    });
    assert.strictEqual(run(guard, req).allowed, true);
});

test('blocks a POST from a different origin', () => {
    const guard = createOriginGuard(silent);
    const req = makeReq({
        method: 'POST',
        headers: { Host: 'ha.local:7680', Origin: 'http://evil.example' },
    });
    const result = run(guard, req);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.status, 403);
});

test('blocks a POST from a different port on the same hostname', () => {
    // Same host, different port is still a different origin, and on a LAN it is
    // the realistic attack: another service on the same machine.
    const guard = createOriginGuard(silent);
    const req = makeReq({
        method: 'POST',
        headers: { Host: 'ha.local:7680', Origin: 'http://ha.local:8123' },
    });
    assert.strictEqual(run(guard, req).allowed, false);
});

test('still blocks a different port once normalization is applied', () => {
    // Normalizing must not become "close enough": a non-default port that
    // genuinely differs is still a different origin.
    const guard = createOriginGuard(silent);
    const req = makeReq({
        method: 'POST',
        headers: { Host: 'ha.local:7680', Origin: 'http://ha.local:9999' },
    });
    assert.strictEqual(run(guard, req).allowed, false);
});

test('blocks a POST whose Host header is unparsable', () => {
    // Normalizing the Host means parsing it, and a garbage value must fail
    // closed rather than throw out of the middleware.
    const guard = createOriginGuard(silent);
    const req = makeReq({
        method: 'POST',
        headers: { Host: 'not a host', Origin: 'http://ha.local:7680' },
    });
    assert.strictEqual(run(guard, req).allowed, false);
});

test('blocks a POST whose Origin is not a parsable URL', () => {
    const guard = createOriginGuard(silent);
    const req = makeReq({
        method: 'POST',
        headers: { Host: 'ha.local:7680', Origin: 'not a url' },
    });
    assert.strictEqual(run(guard, req).allowed, false);
});

test('allows a mismatched Origin when the request arrived through HA ingress', () => {
    // Ingress rewrites Host, so the Origin legitimately will not match. A
    // cross-origin page cannot forge this header: it is not CORS-safelisted,
    // so a preflight the add-on never answers would be required first.
    const guard = createOriginGuard(silent);
    const req = makeReq({
        method: 'POST',
        headers: {
            Host: 'ha.local:7680',
            Origin: 'https://hass.example',
            'X-Ingress-Path': '/api/hassio_ingress/abc123',
        },
    });
    assert.strictEqual(run(guard, req).allowed, true);
});

test('reports a blocked request as JSON rather than an HTML error page', () => {
    const guard = createOriginGuard(silent);
    const req = makeReq({
        method: 'POST',
        headers: { Host: 'ha.local:7680', Origin: 'http://evil.example' },
    });
    assert.deepStrictEqual(run(guard, req).body, {
        error: 'Cross-origin requests are not allowed',
    });
});

test('records the rejected source so a blocked POST is diagnosable', () => {
    // Silenced above so the run stays quiet; a block still has to be traceable
    // in the add-on log, otherwise a misconfigured reverse proxy looks like the
    // upload button simply not working.
    const lines = [];
    const guard = createOriginGuard({ log: (line) => lines.push(line) });
    const req = makeReq({
        method: 'POST',
        headers: { Host: 'ha.local:7680', Origin: 'http://evil.example' },
    });
    run(guard, req);
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /evil\.example/);
});

// ---------------------------------------------------------------------------
// createCrossSiteGuard
// ---------------------------------------------------------------------------

// Runs the guard on one request; returns whether it passed, and the response.
function crossSite(headers, log = () => {}) {
    const res = makeRes();
    let passedOn = false;
    createCrossSiteGuard({ log })(makeReq({ headers }), res, () => { passedOn = true; });
    return { passedOn, res };
}

test('refuses a GET a browser marks cross-site, with a 403 JSON', () => {
    const { passedOn, res } = crossSite({ 'Sec-Fetch-Site': 'cross-site' });
    assert.strictEqual(passedOn, false);
    assert.strictEqual(res.statusCode, 403);
    assert.match(res.body.error, /another site/);
});

test('lets same-origin, same-site and user-started (none) requests through', () => {
    for (const site of ['same-origin', 'same-site', 'none']) {
        const { passedOn, res } = crossSite({ 'Sec-Fetch-Site': site });
        assert.strictEqual(passedOn, true, site);
        assert.strictEqual(res.statusCode, null, site);
    }
});

test('lets a request with no Sec-Fetch-Site through (older browsers, curl)', () => {
    const { passedOn, res } = crossSite({});
    assert.strictEqual(passedOn, true);
    assert.strictEqual(res.statusCode, null);
});

test('reads Sec-Fetch-Site case-insensitively', () => {
    assert.strictEqual(crossSite({ 'Sec-Fetch-Site': 'Cross-Site' }).passedOn, false);
});

test('words its refusal as the route asks, and downloads by default', () => {
    const res = makeRes();
    createCrossSiteGuard({ log: () => {}, message: 'Uploads cannot come from another site.' })(
        makeReq({ method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } }), res, () => {});
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.body, { error: 'Uploads cannot come from another site.' });
    assert.match(crossSite({ 'Sec-Fetch-Site': 'cross-site' }).res.body.error, /^Downloads cannot be started/);
});

// An upload writes into /config, and a same-site page (another port or
// subdomain of the same registrable domain: another add-on, a router's admin
// page) can send one: a no-cors POST of a raw body needs no preflight. The
// upload route refuses same-site as well; the sidebar's own requests are
// same-origin, ingress included. Downloads keep allowing it.
function uploadGuard(headers) {
    const res = makeRes();
    let passedOn = false;
    createCrossSiteGuard({ log: () => {}, allowSameSite: false, message: 'Uploads cannot come from another site.' })(
        makeReq({ method: 'POST', headers }), res, () => { passedOn = true; });
    return { passedOn, res };
}

test('allowSameSite: false refuses a same-site request too, with the route\'s 403', () => {
    for (const site of ['same-site', 'Same-Site', 'cross-site']) {
        const { passedOn, res } = uploadGuard({ 'Sec-Fetch-Site': site });
        assert.strictEqual(passedOn, false, site);
        assert.strictEqual(res.statusCode, 403, site);
        assert.deepStrictEqual(res.body, { error: 'Uploads cannot come from another site.' }, site);
    }
});

test('allowSameSite: false still lets same-origin, none and a missing header through', () => {
    for (const headers of [{ 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Site': 'none' }, {}]) {
        const { passedOn, res } = uploadGuard(headers);
        assert.strictEqual(passedOn, true, JSON.stringify(headers));
        assert.strictEqual(res.statusCode, null, JSON.stringify(headers));
    }
});

test('logs a refused same-site request as such', () => {
    const lines = [];
    createCrossSiteGuard({ log: (line) => lines.push(line), allowSameSite: false })(
        makeReq({ method: 'POST', headers: { 'Sec-Fetch-Site': 'same-site' } }), makeRes(), () => {});
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /^Blocked same-site request for /);
});

test('logs a refused cross-site request', () => {
    const lines = [];
    crossSite({ 'Sec-Fetch-Site': 'cross-site' }, (line) => lines.push(line));
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /cross-site/);
});

// The requests this guard refuses are the ones a hostile page can send in a
// loop (an <img> per frame), and each one used to log a line: the add-on log
// could be flooded from any site the user visited. The refusal stays; only
// the logging is capped. One guard for many requests, on a clock the test
// moves; returns the status each request got.
function loggingGuard() {
    const clock = { t: 1000000 };
    const lines = [];
    const guard = createCrossSiteGuard({ log: (line) => lines.push(line), now: () => clock.t });
    const send = (n, headers = { 'Sec-Fetch-Site': 'cross-site' }) => {
        const statuses = [];
        for (let i = 0; i < n; i++) {
            const res = makeRes();
            guard(makeReq({ headers }), res, () => {});
            statuses.push(res.statusCode);
        }
        return statuses;
    };
    return { lines, clock, send };
}

test('logs at most 5 refusals a minute, the fifth saying so, and refuses every one', () => {
    const { lines, send } = loggingGuard();
    assert.deepStrictEqual(send(20), new Array(20).fill(403));
    assert.strictEqual(lines.length, 5, lines.join('\n'));
    assert.ok(lines.slice(0, 4).every((line) => !/not logged/.test(line)), lines.join('\n'));
    assert.match(lines[4], /; any more this minute are counted, not logged$/);
});

test('logs again once the minute is over, with how many it left out', () => {
    const { lines, clock, send } = loggingGuard();
    send(20);
    clock.t += 59999;
    send(1);
    assert.strictEqual(lines.length, 5, 'still inside the minute');
    clock.t += 1;
    send(1);
    assert.strictEqual(lines.length, 6);
    assert.match(lines[5], /^Blocked cross-site request for "[^"]*" \(16 earlier refusals not logged\)$/);
    send(5);   // the new minute's other four, then one over
    clock.t += 60000;
    send(1);
    assert.strictEqual(lines.length, 11);
    assert.match(lines[10], /\(1 earlier refusal not logged\)$/);
});

test('a request let through spends none of the log budget', () => {
    const { lines, send } = loggingGuard();
    send(10, { 'Sec-Fetch-Site': 'same-origin' });
    assert.strictEqual(lines.length, 0);
    send(5);
    assert.strictEqual(lines.length, 5);
    assert.ok(lines.slice(0, 4).every((line) => !/not logged/.test(line)), lines.join('\n'));
});

// ---------------------------------------------------------------------------
// createUpgradeGuard
// ---------------------------------------------------------------------------
//
// WebSocket upgrades never reach Express - server.js hands them straight to the
// proxy from the http server's 'upgrade' event - so the origin guard above
// never saw them. Browsers do not apply CORS to WebSockets: without this, any
// page a LAN user visited could open the terminal socket and drive a root
// shell. Same policy as the POST guard, applied at the socket.

// A raw http.IncomingMessage, not an Express request: headers are a plain
// object with lowercased keys and there is no req.get().
function makeUpgradeReq(headers = {}) {
    const lower = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    return { url: '/terminal/ws', headers: lower };
}

function makeSocket() {
    return {
        written: '',
        closed: false,
        end(data) { if (data) this.written += data; this.closed = true; },
        destroy() { this.closed = true; },
    };
}

function upgrade(guard, req) {
    const socket = makeSocket();
    const allowed = guard(req, socket);
    return { allowed, socket };
}

test('allows an upgrade whose Origin matches the Host', () => {
    const guard = createUpgradeGuard(silent);
    const req = makeUpgradeReq({ Host: 'ha.local:7680', Origin: 'http://ha.local:7680' });
    const { allowed, socket } = upgrade(guard, req);
    assert.strictEqual(allowed, true);
    assert.strictEqual(socket.closed, false);
});

test('allows an upgrade with no Origin', () => {
    // Browsers always send Origin on a WebSocket handshake; its absence means a
    // non-browser client, which is not the cross-site case being defended.
    const guard = createUpgradeGuard(silent);
    const req = makeUpgradeReq({ Host: 'ha.local:7680' });
    assert.strictEqual(upgrade(guard, req).allowed, true);
});

test('allows a same-origin upgrade when the Host header differs only in case', () => {
    const guard = createUpgradeGuard(silent);
    const req = makeUpgradeReq({ Host: 'HA.LOCAL:7680', Origin: 'http://HA.LOCAL:7680' });
    assert.strictEqual(upgrade(guard, req).allowed, true);
});

test('refuses an upgrade from a different origin with a 403 and closes the socket', () => {
    const guard = createUpgradeGuard(silent);
    const req = makeUpgradeReq({ Host: 'ha.local:7680', Origin: 'http://evil.example' });
    const { allowed, socket } = upgrade(guard, req);
    assert.strictEqual(allowed, false);
    assert.match(socket.written, /^HTTP\/1\.1 403 /);
    assert.strictEqual(socket.closed, true);
});

test('refuses an upgrade from a different port on the same hostname', () => {
    const guard = createUpgradeGuard(silent);
    const req = makeUpgradeReq({ Host: 'ha.local:7680', Origin: 'http://ha.local:8123' });
    assert.strictEqual(upgrade(guard, req).allowed, false);
});

test('refuses an upgrade whose Origin is the opaque "null"', () => {
    // Sandboxed iframes and file:// pages send `Origin: null`. It is a browser,
    // so it is not the no-Origin case, and it matches no Host.
    const guard = createUpgradeGuard(silent);
    const req = makeUpgradeReq({ Host: 'ha.local:7680', Origin: 'null' });
    assert.strictEqual(upgrade(guard, req).allowed, false);
});

test('allows a mismatched Origin when the upgrade arrived through HA ingress', () => {
    // Core's ingress proxy sets X-Ingress-Path on WebSocket upgrades as well as
    // plain requests (homeassistant/components/hassio/ingress.py _init_header).
    // A browser page cannot put a custom header on a WebSocket handshake at
    // all, so it cannot forge this.
    const guard = createUpgradeGuard(silent);
    const req = makeUpgradeReq({
        Host: 'localhost:7680',
        Origin: 'https://hass.example',
        'X-Ingress-Path': '/api/hassio_ingress/abc123',
    });
    assert.strictEqual(upgrade(guard, req).allowed, true);
});

test('records the rejected origin so a refused terminal is diagnosable', () => {
    // A reverse proxy that rewrites Host will trip this. The log line is the
    // only thing distinguishing that from the terminal simply not loading.
    const lines = [];
    const guard = createUpgradeGuard({ log: (line) => lines.push(line) });
    const req = makeUpgradeReq({ Host: 'ha.local:7680', Origin: 'http://evil.example' });
    upgrade(guard, req);
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /evil\.example/);
});

// ---------------------------------------------------------------------------
// The refusal log cap, on every guard
// ---------------------------------------------------------------------------
//
// The origin guard and the upgrade guard refuse what any page can send in a
// loop too (a form POST, a `new WebSocket` per frame), and they logged every
// refusal: the add-on log could be flooded from a site the user visited. The
// origin guard runs first, so for a hostile upload POST the cross-site
// guard's cap never came into play. Each guard caps its log the same way,
// with one shared implementation. Each takes the guard, and returns how many
// requests it refused of `n`.
const capped = {
    'origin guard': (options) => {
        const guard = createOriginGuard(options);
        return (n) => {
            let refused = 0;
            for (let i = 0; i < n; i++) {
                const req = makeReq({ method: 'POST', headers: { Host: 'ha.local', Origin: 'http://evil.example' } });
                if (!run(guard, req).allowed) refused++;
            }
            return refused;
        };
    },
    'upgrade guard': (options) => {
        const guard = createUpgradeGuard(options);
        return (n) => {
            let refused = 0;
            for (let i = 0; i < n; i++) {
                const { allowed, socket } = upgrade(guard, makeUpgradeReq({ Host: 'ha.local', Origin: 'http://evil.example' }));
                if (!allowed && socket.closed) refused++;
            }
            return refused;
        };
    },
    'cross-site guard': (options) => {
        const guard = createCrossSiteGuard(options);
        return (n) => {
            let refused = 0;
            for (let i = 0; i < n; i++) {
                if (!run(guard, makeReq({ headers: { 'Sec-Fetch-Site': 'cross-site' } })).allowed) refused++;
            }
            return refused;
        };
    },
};

for (const [name, make] of Object.entries(capped)) {
    test(`${name}: logs at most 5 refusals a minute, then the count, and refuses every one`, () => {
        const clock = { t: 5000000 };
        const lines = [];
        const send = make({ log: (line) => lines.push(line), now: () => clock.t });
        assert.strictEqual(send(20), 20);
        assert.strictEqual(lines.length, 5, lines.join('\n'));
        assert.match(lines[4], /; any more this minute are counted, not logged$/);
        clock.t += 59999;
        send(1);
        assert.strictEqual(lines.length, 5, 'still inside the minute');
        clock.t += 1;
        send(1);
        assert.strictEqual(lines.length, 6);
        assert.match(lines[5], / \(16 earlier refusals not logged\)$/);
    });

    // Its minute is its own: a refusal another guard logged spends none of it.
    test(`${name}: has a log budget of its own`, () => {
        const lines = [];
        const options = { log: (line) => lines.push(line), now: () => 0 };
        make(options)(5);
        make(options)(5);
        assert.strictEqual(lines.length, 10);
    });

    // Never throws: the upgrade guard runs in the http server's 'upgrade'
    // listener, where a throw is uncaught and restarts the wrapper.
    test(`${name}: a log that throws still refuses, and throws nothing`, () => {
        const send = make({ log: () => { throw new Error('log down'); }, now: () => 0 });
        assert.strictEqual(send(7), 7);
    });
}

// ---------------------------------------------------------------------------
// createRateLimiter
// ---------------------------------------------------------------------------

test('allows requests up to the limit', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 3 });
    const req = makeReq();
    for (let i = 0; i < 3; i++) {
        assert.strictEqual(run(limiter, req).allowed, true, `request ${i + 1} should pass`);
    }
});

test('blocks the request past the limit with 429', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 2 });
    const req = makeReq();
    run(limiter, req);
    run(limiter, req);
    const result = run(limiter, req);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.status, 429);
});

test('counts each client address separately', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
    run(limiter, makeReq({ ip: '10.0.0.1' }));
    assert.strictEqual(run(limiter, makeReq({ ip: '10.0.0.2' })).allowed, true);
});

test('lets a client through again once its window has passed', () => {
    // The window slides, so a blocked client must recover on its own rather
    // than staying blocked until the process restarts.
    let clock = 1000;
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => clock });
    const req = makeReq();
    assert.strictEqual(run(limiter, req).allowed, true);
    assert.strictEqual(run(limiter, req).allowed, false);
    clock += 1001;
    assert.strictEqual(run(limiter, req).allowed, true);
});

test('uses the caller-supplied message when rejecting', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 0, message: 'slow down' });
    assert.deepStrictEqual(run(limiter, makeReq()).body, { error: 'slow down' });
});

test('peek answers what the limiter would, without spending a request', () => {
    // check=1 asks whether an upload would go through: it must hear the
    // upload limiter's 429, but asking must not use up an upload.
    let clock = 1000;
    const limiter = createRateLimiter({ windowMs: 1000, max: 2, message: 'Too many uploads', now: () => clock });
    const req = makeReq();
    for (let i = 0; i < 5; i++) assert.strictEqual(run(limiter.peek, req).allowed, true, `peek ${i + 1}`);
    assert.strictEqual(run(limiter, req).allowed, true);
    assert.strictEqual(run(limiter, req).allowed, true);
    assert.deepStrictEqual(run(limiter.peek, req), { allowed: false, status: 429, body: { error: 'Too many uploads' } });
    assert.strictEqual(run(limiter, req).allowed, false);
    // per client address, and the window slides for it too
    assert.strictEqual(run(limiter.peek, makeReq({ ip: '10.0.0.2' })).allowed, true);
    clock += 1001;
    assert.strictEqual(run(limiter.peek, req).allowed, true);
});

test('falls back to the socket address when req.ip is unset', () => {
    // Express only populates req.ip once trust proxy is resolved; behind the
    // ingress proxy it can be undefined. Without the fallback every client
    // would share one bucket and a single uploader could lock out the add-on.
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
    const a = makeReq({ ip: '10.0.0.1' });
    const b = makeReq({ ip: '10.0.0.2' });
    a.ip = undefined;
    b.ip = undefined;
    run(limiter, a);
    assert.strictEqual(run(limiter, b).allowed, true);
});

// ---------------------------------------------------------------------------
// A refusal of a request that still has its body to come
// ---------------------------------------------------------------------------
//
// Answered with the connection kept alive, a refused upload's body is read
// and thrown away by Node, all of it: a 50 MiB POST refused by the origin
// guard was read to the end. With Connection: close the socket goes once the
// answer is out, as files-upload.js does with its own early refusals. A
// request with no body keeps its connection.

const bodies = {
    'a Content-Length': { 'Content-Length': String(50 * 1024 * 1024) },
    'chunked': { 'Transfer-Encoding': 'chunked' },
};

// Every refusal in this file that an upload can meet, by name.
const refusals = {
    'origin guard': (headers) => refusedConnection(createOriginGuard(silent),
        makeReq({ method: 'POST', headers: { Host: 'ha.local', Origin: 'http://evil.example', ...headers } })),
    'cross-site guard': (headers) => refusedConnection(createCrossSiteGuard(silent),
        makeReq({ method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site', ...headers } })),
    'rate limiter': (headers) => refusedConnection(createRateLimiter({ max: 0 }), makeReq({ method: 'POST', headers })),
    'rate limiter peek': (headers) => refusedConnection(createRateLimiter({ max: 0 }).peek, makeReq({ method: 'POST', headers })),
};
function refusedConnection(middleware, req) {
    const res = makeRes();
    let nexted = false;
    middleware(req, res, () => { nexted = true; });
    assert.strictEqual(nexted, false);
    assert.ok([403, 429].includes(res.statusCode), String(res.statusCode));
    return res.headers.connection;
}

for (const [guard, refuse] of Object.entries(refusals)) {
    for (const [kind, headers] of Object.entries(bodies)) {
        test(`${guard}: refusing a request with ${kind} body closes the connection`, () => {
            assert.strictEqual(refuse(headers), 'close');
        });
    }
    test(`${guard}: refusing a request with no body keeps the connection`, () => {
        assert.strictEqual(refuse({}), undefined);
        assert.strictEqual(refuse({ 'Content-Length': '0' }), undefined);
    });
}

// ---------------------------------------------------------------------------
// errorResponseFor
// ---------------------------------------------------------------------------
//
// multer reports a rejected file type by handing an ordinary Error to the
// error middleware. Only MulterError was mapped to 400, so uploading a PDF
// produced a 500 - the wrapper telling the user it had itself broken, when the
// request was simply not allowed.

test('maps a rejected file type to 400', () => {
    const err = new Error('Only image files are allowed');
    err.code = 'INVALID_FILE_TYPE';
    const { status } = errorResponseFor(err);
    assert.strictEqual(status, 400);
});

test('explains a rejected file type rather than leaking a stack', () => {
    const err = new Error('Only image files are allowed');
    err.code = 'INVALID_FILE_TYPE';
    assert.deepStrictEqual(errorResponseFor(err).body, {
        success: false,
        error: 'Only image files are allowed',
    });
});

test('maps an oversize upload to 400', () => {
    // multer's own size-limit rejection, which arrives as a MulterError.
    const err = new Error('File too large');
    err.name = 'MulterError';
    err.code = 'LIMIT_FILE_SIZE';
    assert.strictEqual(errorResponseFor(err).status, 400);
});

test('maps an unexpected failure to 500', () => {
    assert.strictEqual(errorResponseFor(new Error('disk on fire')).status, 500);
});

test('treats an unrecognised error code as a server error, not a client error', () => {
    // Fail closed on classification: a 400 tells the user to change their
    // request, which is wrong and unactionable when the add-on is at fault.
    const err = new Error('something else');
    err.code = 'ENOSPC';
    assert.strictEqual(errorResponseFor(err).status, 500);
});

console.log(`\n${passed} passed`);
