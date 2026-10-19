'use strict';

/**
 * Request guards for the wrapper service.
 *
 * These live outside server.js so they can be unit tested: server.js opens a
 * listener and creates directories at require time, so importing it from a test
 * would start the add-on. Same reason cache-policy.js is its own module.
 */

/**
 * Answer a refusal. A request that declares a body (a Content-Length over 0,
 * or any Transfer-Encoding) and is refused before anything reads it also gets
 * `Connection: close`: kept alive, the connection would have Node read and
 * discard the whole body, 50 MiB of a refused upload, before the socket could
 * carry another request. Closed, the socket goes once the answer is out, as
 * with files-upload.js's own early refusals. A request with no body keeps its
 * connection.
 */
function declaresBody(req) {
    const length = req.get('content-length');
    return req.get('transfer-encoding') !== undefined || (length !== undefined && Number(length) > 0);
}

function refuse(req, res, status, body) {
    if (declaresBody(req)) res.set('Connection', 'close');
    return res.status(status).json(body);
}

/**
 * Sliding-window rate limiter, keyed by client address. No external dependency:
 * this runs on a Raspberry Pi and the whole policy is "a handful of requests a
 * minute".
 *
 * `now` is injectable so the window can be tested without sleeping. The
 * middleware's `peek` is a second middleware that answers the same 429 when
 * the client's budget is spent but spends none of it.
 */
function createRateLimiter({
    windowMs = 60000,
    max = 20,
    message = 'Too many requests, try again later',
    now = Date.now,
} = {}) {
    const hits = new Map();

    // Periodic cleanup to prevent memory leaks from abandoned IPs
    const cleanup = setInterval(() => {
        const cutoff = now() - windowMs;
        for (const [key, timestamps] of hits) {
            const valid = timestamps.filter(t => t > cutoff);
            if (valid.length === 0) hits.delete(key);
            else hits.set(key, valid);
        }
    }, windowMs);
    cleanup.unref(); // Don't prevent process exit

    // req.ip is undefined until Express has resolved trust proxy, which
    // behind ingress it may not. Falling back to the socket address keeps
    // clients in separate buckets; collapsing them into one 'unknown' key
    // would let a single uploader rate-limit everyone.
    const keyOf = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

    const limiter = (req, res, next) => {
        const key = keyOf(req);
        const timestamp = now();
        const cutoff = timestamp - windowMs;

        const timestamps = (hits.get(key) || []).filter(t => t > cutoff);

        if (timestamps.length >= max) {
            return refuse(req, res, 429, { error: message });
        }

        timestamps.push(timestamp);
        hits.set(key, timestamps);
        next();
    };

    // The same answer, without spending: for a request that asks whether
    // another one, counted here, would be let through (the Files upload's
    // check=1). Nothing is recorded, so asking costs nothing here.
    limiter.peek = (req, res, next) => {
        const cutoff = now() - windowMs;
        const used = (hits.get(keyOf(req)) || []).filter(t => t > cutoff).length;
        if (used >= max) return refuse(req, res, 429, { error: message });
        next();
    };

    return limiter;
}

/**
 * The origin policy shared by the POST guard and the WebSocket upgrade guard.
 *
 * `header(name)` reads a request header by lowercase name; the two callers get
 * headers from different shapes (Express request vs raw IncomingMessage).
 * Returns `{ allowed, source }`, where `source` is the Origin/Referer that was
 * judged, for the caller's log line.
 */
function checkOrigin(header) {
    const origin = header('origin');
    const referer = header('referer');
    const host = header('host');

    // Allow requests with no Origin header (same-origin, curl, server-to-server)
    if (!origin && !referer) return { allowed: true };

    // Validate origin matches the Host header.
    //
    // Both sides go through the URL parser, because it is not a neutral
    // read: it lowercases the hostname and drops a default port. Comparing
    // its output against the raw Host header compares a normalized value
    // with an unnormalized one, so `Host: HA.LOCAL:7680` would not match an
    // Origin of `http://HA.LOCAL:7680` and a same-origin upload would be
    // rejected. Parsing the Host with the source's scheme makes the
    // default-port elision symmetric too.
    const source = origin || referer;
    try {
        const sourceUrl = new URL(source);
        const expectedHost = host ? new URL(`${sourceUrl.protocol}//${host}`).host : null;
        if (expectedHost && sourceUrl.host === expectedHost) return { allowed: true };
    } catch {
        // Malformed URL in Origin/Referer, or an unusable Host header.
        // Either way this falls through and is refused.
    }

    // Also allow requests coming through HA ingress, where the Supervisor
    // rewrites Host so a legitimate Origin will not match. This header is
    // not CORS-safelisted, so a cross-origin page cannot set it without a
    // preflight the add-on never answers - and cannot put it on a WebSocket
    // handshake at all.
    //
    // Deferring to ingress here does not open a cross-site route through it.
    // The Supervisor rejects any ingress request - WebSocket upgrades included
    // - without a valid `ingress_session` cookie (supervisor/api/ingress.py,
    // handler), and the HA frontend sets that cookie SameSite=Strict
    // (frontend src/data/hassio/ingress.ts), so a handshake started by another
    // site arrives without it and is refused before reaching the add-on.
    // Comparing Origin to X-Forwarded-Host here instead would add nothing but
    // breakage for reverse proxies in front of HA that do not pass Host.
    if (header('x-ingress-path')) return { allowed: true };

    return { allowed: false, source };
}

/**
 * CSRF protection for state-changing requests (POST).
 *
 * Validates Origin/Referer against Host to block cross-origin POSTs driven by a
 * malicious page in the user's browser. Requests with neither header (curl,
 * server-to-server) are allowed: a browser always sends one on a cross-origin
 * POST, so absence is not the case being defended against.
 */
function createOriginGuard({ log = console.warn } = {}) {
    return (req, res, next) => {
        if (req.method !== 'POST') return next();

        const { allowed, source } = checkOrigin((name) => req.get(name));
        if (allowed) return next();

        log(`Blocked cross-origin POST from: ${source}`);
        return refuse(req, res, 403, { error: 'Cross-origin requests are not allowed' });
    };
}

/**
 * CSRF protection for requests that act on the user's behalf: the Files
 * sidebar's downloads, which make the browser save a file or build a zip, and
 * its uploads, which write into /config.
 *
 * A page on another site can start a GET (a link, an <img>) but cannot read
 * the answer, so a download leaks nothing to it; refused anyway, so another
 * site cannot make the browser save /config files or start zips. Browsers
 * mark such a request `Sec-Fetch-Site: cross-site`. `same-origin` (the
 * sidebar, ingress included: the wrapper frame shares HA's origin),
 * `same-site`, `none` (typed or bookmarked) and an absent header (older
 * browsers, curl) pass. Origin cannot do this job: a browser sends none on a
 * plain GET.
 *
 * On a POST (uploads) it backs up createOriginGuard rather than replacing it:
 * that guard lets a request with no Origin and no Referer through, and an
 * HA-ingress one whatever its Origin, where Sec-Fetch-Site still says what the
 * browser saw. `message` words the refusal for the route.
 *
 * `allowSameSite: false` refuses `same-site` too, for uploads: they write into
 * /config, and a page on another port or subdomain of the same site (another
 * add-on, a router's admin page) can send one - a no-cors POST of a raw body
 * needs no preflight. Only same-origin, none and an absent header pass then;
 * the sidebar's own requests are same-origin, ingress included. A download
 * leaks nothing to such a page, so it keeps the default.
 *
 * Its log line is capped, because what it refuses is what a hostile page can
 * send in a loop (an <img> per frame): at most CROSS_SITE_LOG_MAX lines a
 * minute per guard (each router builds its own), the last of them saying so.
 * Every request is still refused; the ones not logged are counted, and the
 * count goes out with the next line logged once the minute is over (a burst
 * that ends for good leaves its count unsaid). The minute runs on a
 * monotonic clock, so a wall clock set back cannot silence the log; `now` is
 * injectable for tests, as createRateLimiter's is.
 */
const CROSS_SITE_LOG_MAX = 5;
const CROSS_SITE_LOG_WINDOW_MS = 60000;

function createCrossSiteGuard({
    log = console.warn,
    message = 'Downloads cannot be started from another site. Use the Files sidebar.',
    allowSameSite = true,
    now = () => performance.now(),
} = {}) {
    let windowStart = -Infinity;
    let logged = 0;
    let unlogged = 0;
    const report = (line) => {
        const t = now();
        if (t - windowStart >= CROSS_SITE_LOG_WINDOW_MS) {
            if (unlogged) line += ` (${unlogged} earlier refusal${unlogged === 1 ? '' : 's'} not logged)`;
            windowStart = t;
            logged = 0;
            unlogged = 0;
        }
        if (logged >= CROSS_SITE_LOG_MAX) {
            unlogged++;
            return;
        }
        logged++;
        if (logged === CROSS_SITE_LOG_MAX) line += '; any more this minute are counted, not logged';
        log(line);
    };

    return (req, res, next) => {
        const site = String(req.get('sec-fetch-site') || '').toLowerCase();
        if (site !== 'cross-site' && (allowSameSite || site !== 'same-site')) return next();

        report(`Blocked ${site} request for ${JSON.stringify(`${req.baseUrl || ''}${req.path || ''}`)}`);
        return refuse(req, res, 403, { error: message });
    };
}

/**
 * Cross-site WebSocket hijacking protection for the terminal socket.
 *
 * Upgrades are dispatched from the http server's 'upgrade' event and never pass
 * through Express, so createOriginGuard cannot see them - and browsers do not
 * apply CORS to WebSockets, so any page could otherwise open the terminal.
 *
 * Call with the raw request and socket before handing the upgrade on. Returns
 * true to proceed; on false it has already answered 403 and closed the socket.
 */
function createUpgradeGuard({ log = console.warn } = {}) {
    return (req, socket) => {
        const { allowed, source } = checkOrigin((name) => req.headers[name]);
        if (allowed) return true;

        log(`Blocked cross-origin WebSocket from: ${source}`);
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return false;
    };
}

/**
 * Classify an error from the upload pipeline into a status and a JSON body.
 *
 * multer signals a rejected file type by handing an ordinary Error to the error
 * middleware, so matching on MulterError alone reported a disallowed file as a
 * 500 - the add-on claiming it had broken, when the request was simply refused.
 * Anything unrecognised stays a 500: telling a user to fix their request is
 * wrong and unactionable when the fault is ours.
 */
const INVALID_FILE_TYPE = 'INVALID_FILE_TYPE';

function errorResponseFor(err) {
    const isClientError = err.name === 'MulterError' || err.code === INVALID_FILE_TYPE;

    return {
        status: isClientError ? 400 : 500,
        body: { success: false, error: err.message },
    };
}

module.exports = {
    createRateLimiter,
    createOriginGuard,
    createCrossSiteGuard,
    createUpgradeGuard,
    errorResponseFor,
    INVALID_FILE_TYPE,
};
