'use strict';

/**
 * Request guards for the wrapper service.
 *
 * These live outside server.js so they can be unit tested: server.js opens a
 * listener and creates directories at require time, so importing it from a test
 * would start the add-on. Same reason cache-policy.js is its own module.
 */

/**
 * Sliding-window rate limiter, keyed by client address. No external dependency:
 * this runs on a Raspberry Pi and the whole policy is "a handful of requests a
 * minute".
 *
 * `now` is injectable so the window can be tested without sleeping.
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

    return (req, res, next) => {
        // req.ip is undefined until Express has resolved trust proxy, which
        // behind ingress it may not. Falling back to the socket address keeps
        // clients in separate buckets; collapsing them into one 'unknown' key
        // would let a single uploader rate-limit everyone.
        const key = req.ip || req.socket?.remoteAddress || 'unknown';
        const timestamp = now();
        const cutoff = timestamp - windowMs;

        const timestamps = (hits.get(key) || []).filter(t => t > cutoff);

        if (timestamps.length >= max) {
            return res.status(429).json({ error: message });
        }

        timestamps.push(timestamp);
        hits.set(key, timestamps);
        next();
    };
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
        return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
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
    createUpgradeGuard,
    errorResponseFor,
    INVALID_FILE_TYPE,
};
