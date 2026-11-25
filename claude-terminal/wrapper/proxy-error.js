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
 *  - An HTTP response. If the upstream failed before responding, answer 502 -
 *    except to a request for a page (GET, Accept naming text/html), which
 *    gets the self-reloading starting page below with a 503. If it failed
 *    mid-response (ttyd dropping the connection after the proxy
 *    had already piped its headers), writeHead() would throw
 *    ERR_HTTP_HEADERS_SENT; the only signal left is to cut the connection.
 *  - The raw net.Socket of a WebSocket upgrade, which has no writeHead(). Write
 *    the status line by hand and close it, or the client waits on it forever.
 */
const MESSAGE = 'Failed to connect to terminal';

// run.sh starts the wrapper minutes before ttyd: package installs, Docker,
// ha-mcp and init commands all run in between, so the UI is up long before
// the terminal is. The terminal frame asks for `terminal/` straight away, and
// a bare 502 would sit in it for that whole window. A page request gets this
// instead: the meta refresh reloads the frame's own URL every second, so
// ttyd's page replaces it as soon as ttyd listens.
//
// No external assets (nothing else is served from /terminal/ while ttyd is
// down) and the offline page's palette, dark unless the system is light.
// `data-terminal-starting` lets index.html tell this page from ttyd's: its
// "did not finish loading" timeout must not run while this is legitimately
// waiting. Keep the attribute if this markup changes.
const STARTING_PAGE = `<!doctype html>
<html lang="en" data-terminal-starting><head><meta charset="utf-8">
<meta http-equiv="refresh" content="1">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Starting the terminal</title>
<style>html,body{margin:0;height:100%;background:#1e1e1e;color:#ccc;color-scheme:dark}
body{display:flex;align-items:center;justify-content:center;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
@media (prefers-color-scheme: light){html,body{background:#f5f5f5;color:#333;color-scheme:light}}</style>
</head><body>Starting the terminal…</body></html>
`;

// A document request: what the iframe (or a browser tab) sends, as opposed to
// ttyd's own token fetch or a script. Read from the raw header so this does
// not depend on Express's req.accepts().
function wantsPage(req) {
    if (!req || req.method !== 'GET') return false;
    const accept = req.headers && req.headers.accept;
    return typeof accept === 'string' && /(^|[\s,])text\/html(\s*[;,]|\s*$)/i.test(accept);
}

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

    if (wantsPage(req)) {
        res.writeHead(503, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': Buffer.byteLength(STARTING_PAGE),
            'Retry-After': '1',
            'Cache-Control': 'no-store',
        });
        res.end(STARTING_PAGE);
        return;
    }

    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(MESSAGE);
}

module.exports = { handleProxyError, STARTING_PAGE };
