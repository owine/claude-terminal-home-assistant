'use strict';

const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const { handleProxyError } = require('../proxy-error.js');

// These run against real http servers and sockets rather than doubles. The bug
// being guarded is a property of Node's ServerResponse - writeHead() throws
// ERR_HTTP_HEADERS_SENT once headers are on the wire - and a double would only
// restate whatever the handler happens to call.
let passed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const silent = { log: () => {} };

// Start a server whose request (or upgrade) handler is `onRequest`, and resolve
// with its port. Every server is closed after its test.
function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// A connection the handler leaves open is itself the failure being tested for,
// so the client gives up after this long and reports 'timeout' instead of
// stalling the suite.
const CLIENT_TIMEOUT_MS = 2000;

// Issue a GET and resolve with what the client observed: a status and body, or
// the error that ended the request. Never rejects, so tests assert on outcome.
function get(port) {
    return new Promise((resolve) => {
        const req = http.get({ port, host: '127.0.0.1', path: '/', agent: false }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body, complete: res.complete }));
            res.on('error', (err) => resolve({ status: res.statusCode, error: err.code || err.message }));
            res.on('aborted', () => resolve({ status: res.statusCode, error: 'aborted' }));
        });
        req.on('error', (err) => resolve({ error: err.code || err.message }));
        req.setTimeout(CLIENT_TIMEOUT_MS, () => {
            resolve({ error: 'timeout' });
            req.destroy();
        });
    });
}

// Write a raw upgrade request and resolve with everything the server sent back
// before closing the connection.
function rawUpgrade(port) {
    return new Promise((resolve) => {
        const sock = net.connect(port, '127.0.0.1', () => {
            sock.write('GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
        });
        let data = '';
        sock.on('data', (c) => { data += c; });
        sock.on('close', () => resolve(data));
        sock.on('error', () => {});
        sock.setTimeout(CLIENT_TIMEOUT_MS, () => sock.destroy());
    });
}

test('answers 502 when the upstream fails before any response was sent', async () => {
    const server = http.createServer((req, res) => {
        handleProxyError(new Error('ECONNREFUSED'), req, res, silent);
    });
    const port = await listen(server);
    try {
        const result = await get(port);
        assert.strictEqual(result.status, 502);
        assert.match(result.body, /terminal/i);
    } finally { server.close(); }
});

test('does not throw when the upstream fails after headers were already sent', async () => {
    // ttyd dropping mid-response: http-proxy has piped the 200 and part of the
    // body before the error fires. Answering 502 at that point throws
    // ERR_HTTP_HEADERS_SENT out of an event listener, which kills the wrapper.
    let thrown = null;
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.write('<html>partial');
        try {
            handleProxyError(new Error('socket hang up'), req, res, silent);
        } catch (err) {
            thrown = err;
        }
    });
    const port = await listen(server);
    try {
        await get(port);
        assert.strictEqual(thrown, null, `handler threw: ${thrown && thrown.code}`);
    } finally { server.close(); }
});

test('cuts the connection when headers were already sent, rather than hanging', async () => {
    // The client already has a 200. The only honest signal left is an abrupt
    // close: left open, the browser would wait on a body that never finishes.
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.write('<html>partial');
        handleProxyError(new Error('socket hang up'), req, res, silent);
    });
    const port = await listen(server);
    try {
        const result = await get(port);
        assert.notStrictEqual(result.error, 'timeout', 'connection was left hanging');
        assert.ok(result.error || result.complete === false,
            `expected a truncated response, got ${JSON.stringify(result)}`);
    } finally { server.close(); }
});

test('answers a failed WebSocket upgrade with 502 and closes the socket', async () => {
    // On the upgrade path `res` is the raw net.Socket, which has no
    // writeHead(). Before, nothing was written and the client socket was left
    // open until it timed out.
    const server = http.createServer();
    server.on('upgrade', (req, socket) => {
        handleProxyError(new Error('ECONNREFUSED'), req, socket, silent);
    });
    const port = await listen(server);
    try {
        const started = Date.now();
        const reply = await rawUpgrade(port);
        assert.match(reply, /^HTTP\/1\.1 502 /);
        assert.ok(Date.now() - started < CLIENT_TIMEOUT_MS, 'socket was left open until the client gave up');
    } finally { server.close(); }
});

test('does not throw when the upgrade socket is already gone', async () => {
    const server = http.createServer();
    let thrown = null;
    server.on('upgrade', (req, socket) => {
        socket.destroy();
        try {
            handleProxyError(new Error('ECONNRESET'), req, socket, silent);
        } catch (err) {
            thrown = err;
        }
    });
    const port = await listen(server);
    try {
        await rawUpgrade(port);
        assert.strictEqual(thrown, null, `handler threw: ${thrown && thrown.message}`);
    } finally { server.close(); }
});

test('logs the upstream error so a dropped terminal is diagnosable', async () => {
    const lines = [];
    const server = http.createServer((req, res) => {
        handleProxyError(new Error('ECONNREFUSED 127.0.0.1:7681'), req, res, { log: (l) => lines.push(l) });
    });
    const port = await listen(server);
    try {
        await get(port);
        assert.strictEqual(lines.length, 1);
        assert.match(lines[0], /ECONNREFUSED/);
    } finally { server.close(); }
});

test('falls back to the error code when the message is empty', async () => {
    // A refused connection to ttyd surfaces as an error whose message is empty
    // and whose code is ECONNREFUSED; logging only the message printed a bare
    // "Proxy error: " with nothing to act on.
    const lines = [];
    const err = new Error('');
    err.code = 'ECONNREFUSED';
    const server = http.createServer((req, res) => {
        handleProxyError(err, req, res, { log: (l) => lines.push(l) });
    });
    const port = await listen(server);
    try {
        await get(port);
        assert.match(lines[0], /ECONNREFUSED/);
    } finally { server.close(); }
});

(async () => {
    for (const { name, fn } of tests) {
        try {
            await fn();
            passed++;
            console.log(`ok - ${name}`);
        } catch (err) {
            console.error(`FAIL - ${name}`);
            console.error(err.message);
            process.exitCode = 1;
        }
    }
    console.log(`\n${passed} passed`);
})();
