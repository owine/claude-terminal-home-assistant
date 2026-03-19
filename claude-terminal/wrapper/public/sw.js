const CACHE_NAME = 'claude-ha-v1';
const OFFLINE_URL = './offline.html';
const SHELL_ASSETS = [
    './',
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

// Fetch: network-first with offline fallback
self.addEventListener('fetch', (event) => {
    // Only handle GET requests
    if (event.request.method !== 'GET') return;

    // Skip WebSocket and non-http(s) requests
    if (!event.request.url.startsWith('http')) return;

    event.respondWith(
        fetch(event.request)
            .catch(() => {
                // Network failed — try cache, then offline page for navigations
                return caches.match(event.request)
                    .then((cached) => {
                        if (cached) return cached;

                        // For navigation requests, serve offline page
                        if (event.request.mode === 'navigate') {
                            return caches.match(OFFLINE_URL);
                        }

                        // Non-navigation, non-cached: fail naturally
                        return new Response('Network error', {
                            status: 503,
                            statusText: 'Service Unavailable'
                        });
                    });
            })
    );
});
