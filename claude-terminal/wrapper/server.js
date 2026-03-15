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
 * - Runtime tmux mouse mode toggle via /mouse-mode
 * - ARM-compatible (no native dependencies)
 */

const express = require('express');
const http = require('http');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.IMAGE_SERVICE_PORT || 7680;
const TTYD_PORT = process.env.TTYD_PORT || 7681;
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/images';

// Simple in-memory rate limiter (no external dependencies)
// Uses sliding window to track requests per IP
function createRateLimiter({ windowMs = 60000, max = 20, message = 'Too many requests, try again later' } = {}) {
    const hits = new Map();

    // Periodic cleanup to prevent memory leaks from abandoned IPs
    const cleanup = setInterval(() => {
        const cutoff = Date.now() - windowMs;
        for (const [key, timestamps] of hits) {
            const valid = timestamps.filter(t => t > cutoff);
            if (valid.length === 0) hits.delete(key);
            else hits.set(key, valid);
        }
    }, windowMs);
    cleanup.unref(); // Don't prevent process exit

    return (req, res, next) => {
        const key = req.ip || req.socket?.remoteAddress || 'unknown';
        const now = Date.now();
        const cutoff = now - windowMs;

        const timestamps = (hits.get(key) || []).filter(t => t > cutoff);

        if (timestamps.length >= max) {
            return res.status(429).json({ error: message });
        }

        timestamps.push(now);
        hits.set(key, timestamps);
        next();
    };
}

// Rate limiters: generous for general use, stricter for uploads
const generalLimiter = createRateLimiter({ windowMs: 60000, max: 60 });
const uploadLimiter = createRateLimiter({ windowMs: 60000, max: 10, message: 'Upload rate limit exceeded, try again in a minute' });

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
    filename: (req, file, cb) => {
        const timestamp = Date.now();
        const ext = path.extname(file.originalname) || '.png';
        const filename = `pasted-${timestamp}${ext}`;
        cb(null, filename);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB max file size
    },
    fileFilter: (req, file, cb) => {
        // Accept images only
        const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    }
});

// CSRF protection for state-changing requests (POST)
// Validates Origin/Referer header to block cross-origin attacks from malicious websites
// Allows: same-origin requests, requests with no origin (curl, non-browser clients)
app.use((req, res, next) => {
    if (req.method !== 'POST') return next();

    const origin = req.get('Origin');
    const referer = req.get('Referer');
    const host = req.get('Host');

    // Allow requests with no Origin header (same-origin, curl, server-to-server)
    if (!origin && !referer) return next();

    // Validate origin matches the Host header
    const source = origin || referer;
    try {
        const sourceHost = new URL(source).host;
        if (host && sourceHost === host) return next();
    } catch {
        // Malformed URL in Origin/Referer
    }

    // Also allow requests coming through HA ingress (X-Ingress-Path header present)
    if (req.get('X-Ingress-Path')) return next();

    console.warn(`Blocked cross-origin POST from: ${source}`);
    return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
});

// API routes MUST come before static files middleware
// Otherwise static middleware will intercept API requests

// Health check endpoint
app.get('/health', generalLimiter, (req, res) => {
    res.json({ status: 'ok' });
});

// Provide ttyd port to frontend (no longer exposes internal paths)
app.get('/config', generalLimiter, (req, res) => {
    res.json({
        ttydPort: TTYD_PORT
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

// Mouse mode toggle - allows switching between scroll and select modes
// Uses tmux commands directly so the terminal session is not disrupted
app.get('/mouse-mode', generalLimiter, (req, res) => {
    execFile('tmux', ['show', '-gv', 'mouse'], (err, stdout) => {
        if (err) {
            return res.json({ enabled: false, error: 'tmux not available' });
        }
        res.json({ enabled: stdout.trim() === 'on' });
    });
});

app.post('/mouse-mode', generalLimiter, (req, res) => {
    // Get current state, then toggle
    execFile('tmux', ['show', '-gv', 'mouse'], (err, stdout) => {
        if (err) {
            return res.status(500).json({ error: 'tmux not available' });
        }
        const currentlyOn = stdout.trim() === 'on';
        const newState = currentlyOn ? 'off' : 'on';

        execFile('tmux', ['set', '-g', 'mouse', newState], (err2) => {
            if (err2) {
                return res.status(500).json({ error: 'Failed to toggle mouse mode' });
            }
            console.log(`Mouse mode toggled: ${newState}`);
            res.json({ enabled: newState === 'on' });
        });
    });
});

// Proxy endpoint for ttyd terminal
// This allows ttyd to work through Home Assistant ingress
// Handles both HTTP and WebSocket connections
const terminalProxy = createProxyMiddleware({
    target: `http://localhost:${TTYD_PORT}`,
    changeOrigin: true,
    ws: true, // Enable WebSocket proxying
    // Explicitly strip /terminal prefix for WebSocket upgrades
    // While v3 strips mount points for HTTP, WebSocket upgrades need explicit rewrite
    pathRewrite: {
        '^/terminal': '' // Remove /terminal prefix
    },
    on: {
        error: (err, req, res) => {
            console.error('Proxy error:', err.message);
            // WebSocket upgrade errors don't have standard res.status()
            // Check if res has status method before using it
            if (res && typeof res.status === 'function') {
                res.status(502).send('Failed to connect to terminal');
            } else if (res && typeof res.writeHead === 'function') {
                // WebSocket upgrade response
                res.writeHead(502);
                res.end('Failed to connect to terminal');
            }
        }
    },
    logger: console
});

app.use('/terminal', terminalProxy);

// Serve static files (HTML interface) - MUST be after API routes
app.use(express.static(path.join(__dirname, 'public')));

// Multer error handling middleware
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        console.error('Multer error:', err.message);
        return res.status(400).json({
            success: false,
            error: `Upload error: ${err.message}`
        });
    }

    if (err) {
        console.error('Error:', err.message);
        return res.status(500).json({
            success: false,
            error: err.message
        });
    }

    next();
});

// Create HTTP server and start listening
const server = http.createServer(app);

// Handle WebSocket upgrade for terminal proxy
// This is required in http-proxy-middleware v3
server.on('upgrade', terminalProxy.upgrade);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Claude Terminal Wrapper Service running on port ${PORT}`);
    console.log(`Upload directory: ${UPLOAD_DIR}`);
    console.log(`ttyd terminal on port: ${TTYD_PORT}`);
    console.log(`Terminal proxy available at /terminal/`);
    console.log(`WebSocket upgrade handler registered`);
});
