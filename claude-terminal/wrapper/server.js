#!/usr/bin/env node

/**
 * Claude Terminal Pro - Wrapper Service
 *
 * Express server that wraps ttyd with a custom UI and additional features.
 * Designed for resource-constrained environments (Raspberry Pi).
 *
 * Features:
 * - Serves HTML interface with embedded ttyd terminal
 * - WebSocket proxy for Home Assistant ingress compatibility
 * - Image uploads via POST /upload (paste/drag-drop)
 * - Read-only /config browser and HA config check for the Files sidebar (/api/files)
 * - File and folder (zip) downloads from /config for the Files sidebar
 * - File uploads into /config for the Files sidebar (inbox or a chosen folder)
 * - ARM-compatible (no native dependencies)
 */

const express = require('express');
const http = require('http');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { cacheControlFor } = require('./cache-policy');
const { handleProxyError } = require('./proxy-error');
const {
    createRateLimiter,
    createOriginGuard,
    createUpgradeGuard,
    errorResponseFor,
    INVALID_FILE_TYPE,
} = require('./http-guards');
const { uploadFilename, isAllowedImageMime, IMAGE_MAX_BYTES } = require('./upload-naming');
const { loginNotifierFromEnv } = require('./login-notifier');
const { createFilesApi, createFilesRouter, createHaCheck } = require('./files-api');
const { createDownloads, createDownloadRouter } = require('./files-download');
const { createUploads, createUploadRouter, uploadMaxBytes, uploadRequestTimeoutMs } = require('./files-upload');
const { createPartRecord } = require('./upload-parts');

const app = express();
const PORT = process.env.WRAPPER_PORT || 7680;
// Baked into the image from the builder's BUILD_VERSION (see Dockerfile);
// empty in local and CI test builds.
const ADDON_VERSION = process.env.ADDON_VERSION || '';
const TTYD_PORT = process.env.TTYD_PORT || 7681;
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/images';

// Rate limiters: generous for general use, stricter for uploads
const generalLimiter = createRateLimiter({ windowMs: 60000, max: 60 });
const uploadLimiter = createRateLimiter({ windowMs: 60000, max: 10, message: 'Upload rate limit exceeded, try again in a minute' });
// Files sidebar. Its own buckets: expanding folders is bursty and must not eat
// into /health's, and behind ingress every browser shares one client address.
// The config check runs a process, so it gets the strict one.
const filesLimiter = createRateLimiter({ windowMs: 60000, max: 240, message: 'Too many file requests, try again in a minute' });
const haCheckLimiter = createRateLimiter({ windowMs: 60000, max: 6, message: 'Too many configuration checks, try again in a minute' });
// A zip walks a folder and deflates up to 200 MB on the Pi. The UI makes two
// requests per zip (check=1, then the download). The integration test budgets
// its requests against this max (ZIP_LIMIT in
// test/integration/mouse-and-clipboard.mjs); change both together.
const zipLimiter = createRateLimiter({ windowMs: 60000, max: 20, message: 'Too many zip downloads, try again in a minute' });
// Files sidebar uploads, one file per request: a dropped handful must not meet
// the image limiter's 10. Their check=1 preflights count against filesLimiter,
// and answer this limiter's 429 (asked without spending) once it is used up.
// The integration test budgets its uploads against this max (UPLOAD_LIMIT in
// test/integration/mouse-and-clipboard.mjs); change both together.
const filesUploadLimiter = createRateLimiter({ windowMs: 60000, max: 60, message: 'Too many uploads, try again in a minute' });

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o755 });
    console.log(`Created upload directory: ${UPLOAD_DIR}`);
}

// Configure multer for image uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    // Random suffix: two same-millisecond uploads used to collide and the
    // second silently overwrote the first. Extension from the filter-checked
    // mimetype, never the client's originalname: the path is typed into a
    // shell. See upload-naming.js.
    filename: (req, file, cb) => {
        try {
            cb(null, uploadFilename(file.mimetype));
        } catch (err) {
            err.code = INVALID_FILE_TYPE;
            cb(err);
        }
    }
});

const upload = multer({
    storage: storage,
    limits: {
        // 10 MB. The terminal routes bigger images to the Files inbox by the
        // same constant (public/upload-client.js).
        fileSize: IMAGE_MAX_BYTES
    },
    fileFilter: (req, file, cb) => {
        // Accept images only - the same table the filename is derived from
        if (isAllowedImageMime(file.mimetype)) {
            cb(null, true);
        } else {
            const err = new Error('Only image files are allowed');
            // Untagged, this reached the error handler as a plain Error and
            // was reported as a 500 - the add-on claiming it had broken when
            // the upload was simply refused.
            err.code = INVALID_FILE_TYPE;
            cb(err);
        }
    }
});

// CSRF protection for state-changing requests (POST). See http-guards.js.
app.use(createOriginGuard());

// API routes MUST come before static files middleware
// Otherwise static middleware will intercept API requests

// Health check endpoint
app.get('/health', generalLimiter, (req, res) => {
    res.json({ status: 'ok', version: ADDON_VERSION });
});

// Provide ttyd port to frontend (no longer exposes internal paths)
app.get('/config', generalLimiter, (req, res) => {
    res.json({
        ttydPort: TTYD_PORT,
        version: ADDON_VERSION
    });
});

// Image upload endpoint (stricter rate limit)
app.post('/upload', uploadLimiter, upload.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No image file provided' });
    }

    const filePath = path.resolve(UPLOAD_DIR, req.file.filename);
    if (!filePath.startsWith(path.resolve(UPLOAD_DIR) + path.sep) && filePath !== path.resolve(UPLOAD_DIR)) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'Invalid filename' });
    }
    console.log(`Image uploaded: ${filePath} (${(req.file.size / 1024).toFixed(2)} KB)`);

    res.json({
        success: true,
        path: filePath,
        filename: req.file.filename,
        size: req.file.size
    });
});

// Files sidebar: read-only /config browser and `ha core check` (files-api.js).
// FILES_ROOT is a test seam; production browses /config.
const filesApi = createFilesApi({ root: process.env.FILES_ROOT || '/config' });
app.use('/api/files', createFilesRouter({
    api: filesApi,
    haCheck: createHaCheck(),
    readLimiter: filesLimiter,
    checkLimiter: haCheckLimiter,
}));
// Downloads (files-download.js): the same api instance, so the same root,
// resolve() and tiers as above. Still among the API routes: before the
// terminal proxy and static files.
app.use('/api/files', createDownloadRouter({
    downloads: createDownloads({ api: filesApi }),
    fileLimiter: filesLimiter,
    zipLimiter,
}));
// Uploads (files-upload.js): the same api instance again. The part record
// lives in /data, beside the add-on's other state; UPLOAD_PARTS_FILE is a test
// seam. start() deletes the parts a crash left, before any upload can begin
// (every record change queues behind it), and never rejects.
const partRecord = createPartRecord({
    file: process.env.UPLOAD_PARTS_FILE || '/data/upload-parts',
    root: filesApi.root,
});
partRecord.start();
const uploadLimit = uploadMaxBytes(process.env.UPLOAD_MAX_MB);
app.use('/api/files', createUploadRouter({
    uploads: createUploads({ api: filesApi, record: partRecord, maxBytes: uploadLimit }),
    uploadLimiter: filesUploadLimiter,
    checkLimiter: filesLimiter,
}));

// Proxy endpoint for ttyd terminal
// This allows ttyd to work through Home Assistant ingress
// Handles both HTTP and WebSocket connections
const terminalProxy = createProxyMiddleware({
    // 127.0.0.1, not localhost: ttyd binds IPv4 loopback only (run.sh), and
    // localhost may resolve to ::1 first.
    target: `http://127.0.0.1:${TTYD_PORT}`,
    changeOrigin: true,
    ws: true, // Enable WebSocket proxying
    // Explicitly strip /terminal prefix for WebSocket upgrades
    // While v3 strips mount points for HTTP, WebSocket upgrades need explicit rewrite
    pathRewrite: {
        '^/terminal': '' // Remove /terminal prefix
    },
    on: {
        error: (err, req, res) => handleProxyError(err, req, res),
    },
    logger: console
});

app.use('/terminal', terminalProxy);

// Serve static files (HTML interface) - MUST be after API routes.
//
// setHeaders is load-bearing, not a tweak. express.static's default
// `Cache-Control: public, max-age=0` only invites revalidation; Safari
// declined it and served a user 2.7.0's terminal-mouse.js against 2.7.1's
// index.html for a whole release. See cache-policy.js for why bumping
// CACHE_NAME in sw.js does not cover this.
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', cacheControlFor(filePath));
    }
}));

// Upload error handling. errorResponseFor decides client-vs-server fault;
// see http-guards.js for why that is not just `instanceof MulterError`.
app.use((err, req, res, next) => {
    if (!err) return next();

    const { status, body } = errorResponseFor(err);
    console.error(`Upload error (${status}):`, err.message);
    return res.status(status).json(body);
});

// Create HTTP server and start listening
const server = http.createServer(app);
// Node cuts off a request whose body has not all arrived within
// requestTimeout (default 5 minutes) with a 408. A 25 MB upload on a slow
// mobile link can take longer, and upload_max_mb can be raised, so it is 30
// minutes, or as long as a file at the cap takes at 128 kbit/s, but never
// over 12 hours (uploadRequestTimeoutMs, MAX_REQUEST_TIMEOUT_MS): it is
// server-wide, since Node has no per-route setting, so no request of any
// kind may hold a connection open for longer. headersTimeout (60 s) is
// deliberately left alone, so a client that never finishes its headers is
// still cut off quickly, and uploads have their own idle timeout for a body
// that stops arriving (files-upload.js).
server.requestTimeout = uploadRequestTimeoutMs(uploadLimit);

// http-proxy-middleware does not auto-bind WS upgrades; without this the terminal won't connect.
// Upgrades bypass Express entirely, so the origin check has to happen here: the
// POST guard above never sees them, and browsers apply no CORS to WebSockets.
const upgradeGuard = createUpgradeGuard();
server.on('upgrade', (req, socket, head) => {
    if (upgradeGuard(req, socket)) terminalProxy.upgrade(req, socket, head);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Claude Terminal Wrapper Service running on port ${PORT}`);
    console.log(`Upload directory: ${UPLOAD_DIR}`);
    console.log(`Files sidebar upload limit: ${uploadLimit / 1024 / 1024} MB`);
    console.log(`ttyd terminal on port: ${TTYD_PORT}`);
    console.log(`Terminal proxy available at /terminal/`);
    console.log(`WebSocket upgrade handler registered`);
});

// Post Claude's login link as an HA notification. start() never rejects; the
// catch is only so a future change cannot turn into an unhandled rejection.
const loginNotifier = loginNotifierFromEnv();
if (loginNotifier) {
    console.log('Login notifier: watching for a Claude Code login link');
    loginNotifier.start().catch((err) => console.log(`Login notifier: ${err.message}`));
}
