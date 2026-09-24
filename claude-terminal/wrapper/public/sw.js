const CACHE_NAME = 'claude-ha-v8';
const OFFLINE_URL = './offline.html';
// Every path is relative: under Home Assistant ingress the app is served
// beneath a per-session path prefix, and these resolve against sw.js's URL.
//
// The start URL ('./') is deliberately NOT precached. Navigations never read
// the cache (see below), so a cached shell could only ever be served offline -
// a page whose terminal iframe cannot connect.
const SHELL_ASSETS = [
    './login-link.js',
    './terminal-clipboard.js',
    OFFLINE_URL,
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    './icon-maskable-512.png'
];

// Install: cache the app shell
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(SHELL_ASSETS))
            .then(() => self.skipWaiting())
    );
});

// Activate: clean up old caches and claim clients
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys
                    .filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

// Fetch: network-first, with different fallbacks for pages and assets
self.addEventListener('fetch', (event) => {
    // Only handle GET requests
    if (event.request.method !== 'GET') return;

    // Skip WebSocket and non-http(s) requests
    if (!event.request.url.startsWith('http')) return;

    // Navigations: network, else the offline page - never a cached page.
    // The terminal needs a live connection to the add-on, so an offline copy
    // of the shell is worse than useless: it looks like the app and does
    // nothing. Previously a cache lookup came first, and because install had
    // cached './', the start URL got that dead shell instead of offline.html.
    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request).catch(() => caches.match(OFFLINE_URL))
        );
        return;
    }

    // Assets: network, else cache, else a plain 503
    event.respondWith(
        fetch(event.request)
            .catch(() => caches.match(event.request)
                .then((cached) => cached || new Response('Network error', {
                    status: 503,
                    statusText: 'Service Unavailable'
                })))
    );
});
