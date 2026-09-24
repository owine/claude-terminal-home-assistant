'use strict';

/**
 * Error handler for the terminal proxy (http-proxy-middleware `on.error`).
 *
 * Its own module so it can be unit tested: server.js opens a listener at
 * require time. Same reason as cache-policy.js and http-guards.js.
 *
 * `res` is one of two different things, and neither case may throw: this runs
 * inside an EventEmitter listener, so an exception is uncaught and exits the
 * wrapper - and nothing restarts it except the loop in run.sh.
 *
 *  - An HTTP response. If the upstream failed before responding, answer 502.
 *    If it failed mid-response (ttyd dropping the connection after the proxy
 *    had already piped its headers), writeHead() would throw
 *    ERR_HTTP_HEADERS_SENT; the only signal left is to cut the connection.
 *  - The raw net.Socket of a WebSocket upgrade, which has no writeHead(). Write
 *    the status line by hand and close it, or the client waits on it forever.
 */
const MESSAGE = 'Failed to connect to terminal';

function handleProxyError(err, req, res, { log = console.error } = {}) {
    log(`Proxy error: ${err.message || err.code || err.name}`);
    if (!res) return;

    if (typeof res.writeHead !== 'function') {
        // end() flushes the reply and then closes; destroy() right after it
        // could discard the reply before it left. Only a socket that can no
        // longer be written needs tearing down.
        if (res.writable) {
            res.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: ${MESSAGE.length}\r\n\r\n${MESSAGE}`);
        } else {
            res.destroy();
        }
        return;
    }

    if (res.headersSent) {
        res.destroy();
        return;
    }

    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(MESSAGE);
}

module.exports = { handleProxyError };
