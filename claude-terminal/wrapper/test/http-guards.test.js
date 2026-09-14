'use strict';

const assert = require('node:assert');
const { createRateLimiter, createOriginGuard, errorResponseFor } = require('../http-guards.js');

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
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
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
