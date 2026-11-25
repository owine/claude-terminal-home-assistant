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

// After this long the starting page (below) says so, and where to look: a
// start can take minutes (package installs), but one stuck in run.sh would
// otherwise show "Starting" for ever. Declared first: STARTING_PAGE is built
// at load time and reads it.
const SLOW_START_S = 300;

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
function startingPage(uptimeSeconds = 0) {
    const note = uptimeSeconds >= SLOW_START_S
        ? `<p>Still starting after ${Math.floor(uptimeSeconds / 60)} minutes. The app's Log tab shows what it is doing.</p>`
        : '';
    return `<!doctype html>
<html lang="en" data-terminal-starting><head><meta charset="utf-8">
<meta http-equiv="refresh" content="1">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Starting the terminal</title>
<style>html,body{margin:0;height:100%;background:#1e1e1e;color:#ccc;color-scheme:dark}
body{display:flex;align-items:center;justify-content:center;text-align:center;padding:0 16px;box-sizing:border-box;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
@media (prefers-color-scheme: light){html,body{background:#f5f5f5;color:#333;color-scheme:light}}</style>
</head><body><div><p>Starting the terminal…</p>${note}</div></body></html>
`;
}
const STARTING_PAGE = startingPage(0);

// The refusals a page request meets while ttyd is not listening yet are
// expected, and with the page reloading once a second they would fill the
// app's log. They are logged at most once a minute, with a count.
const QUIET_MS = 60000;
const startingLog = { last: -Infinity, skipped: 0 };

// A document request: what the iframe (or a browser tab) sends, as opposed to
// ttyd's own token fetch or a script. Read from the raw header so this does
// not depend on Express's req.accepts().
function wantsPage(req) {
    if (!req || req.method !== 'GET') return false;
    const accept = req.headers && req.headers.accept;
    return typeof accept === 'string' && /(^|[\s,])text\/html(\s*[;,]|\s*$)/i.test(accept);
}

function handleProxyError(err, req, res, {
    log = console.error,
    uptime = process.uptime,
    now = Date.now,
    logState = startingLog,
} = {}) {
    const reason = err.message || err.code || err.name;
    if (wantsPage(req) && err.code === 'ECONNREFUSED') {
        if (now() - logState.last >= QUIET_MS) {
            const more = logState.skipped ? `; ${logState.skipped} more since the last line` : '';
            log(`Proxy error: ${reason} (terminal not listening yet, starting page served${more})`);
            logState.last = now();
            logState.skipped = 0;
        } else {
            logState.skipped++;
        }
    } else {
        log(`Proxy error: ${reason}`);
    }
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
        const page = startingPage(uptime());
        res.writeHead(503, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': Buffer.byteLength(page),
            'Retry-After': '1',
            'Cache-Control': 'no-store',
        });
        res.end(page);
        return;
    }

    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(MESSAGE);
}

// The logger for http-proxy-middleware. With `logger` set, its default
// logger plugin logs a copy of every proxy error, beside the line
// handleProxyError writes, which throttles the refusals of a ttyd that is
// still starting; the copy was one line per starting-page reload, about 60 a
// minute through a slow start. The plugin also logs every proxied request
// ("[HPM] GET /terminal/ -> ... [200]"). Both are dropped here. Kept: its
// WebSocket connect/disconnect lines, which date a dropped terminal, its
// warnings, and any other error it reports (a path filter that throws).
// Called from inside the library's event listeners, so it must never throw.
const HPM_PROXY_ERROR = /^\[HPM\] Error occurred while proxying request /;
const HPM_EXCHANGE = /^\[HPM\] [A-Z]+ \S+ -> /;

function createProxyLogger(base = console) {
    const matches = (re, msg) => typeof msg === 'string' && re.test(msg);
    const safe = (fn) => (...args) => {
        try { fn(...args); } catch { /* logging must not break the proxy */ }
    };
    return {
        info: safe((msg, ...args) => { if (!matches(HPM_EXCHANGE, msg)) base.info(msg, ...args); }),
        warn: safe((...args) => base.warn(...args)),
        error: safe((msg, ...args) => { if (!matches(HPM_PROXY_ERROR, msg)) base.error(msg, ...args); }),
    };
}

module.exports = { handleProxyError, startingPage, STARTING_PAGE, SLOW_START_S, createProxyLogger };
