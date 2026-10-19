'use strict';

// Runs public/sw.js inside a node:vm context with a fake `self`, `caches`
// and `fetch`, then drives its install and fetch handlers the way a browser
// would. Nothing here needs a browser: the service worker is plain event
// handlers over the Cache API.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SW_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');

// Under Home Assistant ingress the app lives beneath a per-session path
// prefix, and the service worker is registered from there. Using such a URL
// here means any asset path that is not relative would resolve outside the
// prefix and simply not be found.
const SCOPE = 'https://ha.example/api/hassio_ingress/abc123/';
const SW_URL = `${SCOPE}sw.js`;

function body(tag) {
    return new Response(tag, { status: 200 });
}

// A Cache Storage double. Keys are absolute URLs; string arguments resolve
// against the service worker's URL, as the real Cache API does.
function makeCaches(network) {
    const stores = new Map();
    const keyOf = (req) => (typeof req === 'string' ? new URL(req, SW_URL).href : req.url);
    const open = async (name) => {
        if (!stores.has(name)) {
            const entries = new Map();
            stores.set(name, {
                entries,
                async addAll(reqs) {
                    for (const r of reqs) {
                        const key = keyOf(r);
                        entries.set(key, await network(key));
                    }
                },
                async put(req, res) { entries.set(keyOf(req), res); },
                async match(req) {
                    const hit = entries.get(keyOf(req));
                    return hit ? hit.clone() : undefined;
                },
            });
        }
        return stores.get(name);
    };
    return {
        stores,
        open,
        async keys() { return [...stores.keys()]; },
        async delete(name) { return stores.delete(name); },
        async match(req) {
            for (const store of stores.values()) {
                const hit = await store.match(req);
                if (hit) return hit;
            }
            return undefined;
        },
    };
}

// Loads sw.js, runs its install step against an online network that answers
// every URL with a body naming that URL, and returns a harness that can then
// take the network away and dispatch fetches.
async function installedWorker() {
    let online = true;
    const network = async (url) => {
        if (!online) throw new TypeError('Failed to fetch');
        return body(`network:${url}`);
    };
    const caches = makeCaches(network);
    const listeners = {};
    const self = {
        location: new URL(SW_URL),
        addEventListener(type, fn) { listeners[type] = fn; },
        skipWaiting: async () => {},
        clients: { claim: async () => {} },
    };
    const context = vm.createContext({
        self,
        caches,
        fetch: (req) => network(typeof req === 'string' ? new URL(req, SW_URL).href : req.url),
        Response,
        URL,
        Promise,
        console,
    });
    vm.runInContext(SW_SOURCE, context, { filename: 'sw.js' });

    let installing;
    listeners.install({ waitUntil(p) { installing = p; } });
    await installing;

    return {
        caches,
        cacheName: vm.runInContext('CACHE_NAME', context),
        // Dispatches the activate event and waits for its cleanup.
        async activate() {
            let activating;
            listeners.activate({ waitUntil(p) { activating = p; } });
            await activating;
        },
        goOffline() { online = false; },
        // Dispatches a fetch event. Resolves to the text of the response the
        // worker chose, or null when it declined to handle the request (the
        // browser then does its default network fetch).
        async request(url, { mode = 'no-cors', method = 'GET' } = {}) {
            let responded = null;
            listeners.fetch({
                request: { url: new URL(url, SW_URL).href, mode, method },
                respondWith(p) { responded = p; },
            });
            if (!responded) return null;
            const res = await responded;
            return { status: res.status, text: await res.text() };
        },
    };
}

let passed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- navigations ---
//
// Background: install precached './' - the app's start URL - and the fetch
// handler answered every failed request from the cache first. An offline
// navigation to the start URL therefore got the cached shell: a page whose
// terminal iframe can never connect, instead of the offline page that says
// the add-on is unreachable. offline.html was only ever shown for URLs that
// happened not to be cached.

// Under Home Assistant ingress the add-on shares HA's origin, so CacheStorage
// also holds caches this worker does not own (HA's own frontend, other
// add-ons). Activation may clear only this app's superseded caches.
test('activation deletes only this app\'s older caches, never other apps\' caches', async () => {
    const sw = await installedWorker();
    await sw.caches.open('claude-ha-v1');
    await sw.caches.open('workbox-precache-v2-https://ha.example/');
    await sw.caches.open('other-addon-cache');
    await sw.activate();
    const left = (await sw.caches.keys()).sort();
    assert.deepEqual(left, [sw.cacheName, 'other-addon-cache', 'workbox-precache-v2-https://ha.example/'].sort());
});

test('an offline navigation to the start URL shows the offline page', async () => {
    const sw = await installedWorker();
    sw.goOffline();
    const res = await sw.request(SCOPE, { mode: 'navigate' });
    assert.strictEqual(res.text, `network:${SCOPE}offline.html`);
});

test('an offline navigation to any other page shows the offline page', async () => {
    const sw = await installedWorker();
    sw.goOffline();
    const res = await sw.request(`${SCOPE}index.html`, { mode: 'navigate' });
    assert.strictEqual(res.text, `network:${SCOPE}offline.html`);
});

test('an offline navigation never serves a cached page, even if one is cached', async () => {
    // Pins the navigation branch itself, not just the precache list: an old
    // cache entry, or a later change that caches pages, must still not
    // resurrect the dead shell.
    const sw = await installedWorker();
    const store = await sw.caches.open(sw.cacheName);
    await store.put(SCOPE, body('stale shell'));
    sw.goOffline();
    const res = await sw.request(SCOPE, { mode: 'navigate' });
    assert.strictEqual(res.text, `network:${SCOPE}offline.html`);
});

test('an online navigation comes from the network, not the cache', async () => {
    const sw = await installedWorker();
    const res = await sw.request(SCOPE, { mode: 'navigate' });
    assert.strictEqual(res.text, `network:${SCOPE}`);
});

test('the offline page is precached under the ingress prefix', async () => {
    const sw = await installedWorker();
    const store = await sw.caches.open(sw.cacheName);
    assert.ok(await store.match(`${SCOPE}offline.html`), 'offline.html not in cache');
});

// --- precache ---
//
// Each script index.html loads is precached, so an asset request that fails
// while the page itself loaded (a flaky connection, a wrapper restart) can
// still be answered. A script added to index.html and forgotten here would
// silently miss that fallback.

test('the Files sidebar UI script is precached under the ingress prefix', async () => {
    const sw = await installedWorker();
    const store = await sw.caches.open(sw.cacheName);
    assert.ok(await store.match(`${SCOPE}files-sidebar-ui.js`), 'files-sidebar-ui.js not in cache');
});

test('the upload client script is precached under the ingress prefix', async () => {
    const sw = await installedWorker();
    const store = await sw.caches.open(sw.cacheName);
    assert.ok(await store.match(`${SCOPE}upload-client.js`), 'upload-client.js not in cache');
});

test('every script index.html loads is precached', async () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(scripts.length > 0, 'no <script src> found in index.html');
    const sw = await installedWorker();
    const store = await sw.caches.open(sw.cacheName);
    for (const src of scripts) {
        assert.ok(await store.match(`${SCOPE}${src}`), `${src} is loaded by index.html but not precached`);
    }
});

// --- assets: unchanged behaviour ---

test('an online asset request comes from the network', async () => {
    const sw = await installedWorker();
    const res = await sw.request(`${SCOPE}login-link.js`);
    assert.strictEqual(res.text, `network:${SCOPE}login-link.js`);
});

test('an offline request for a precached asset is served from cache', async () => {
    const sw = await installedWorker();
    sw.goOffline();
    const res = await sw.request(`${SCOPE}icon-192.png`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.text, `network:${SCOPE}icon-192.png`);
});

test('an offline request for an uncached asset fails with 503', async () => {
    const sw = await installedWorker();
    sw.goOffline();
    const res = await sw.request(`${SCOPE}nope.js`);
    assert.strictEqual(res.status, 503);
});

// --- downloads ---
//
// A file or zip download must not pass through the worker: a zip can stream
// for minutes, and an offline navigation would get offline.html saved under
// the download's name. Both the plain request and the navigation an
// <a download> click makes are left to the browser.

test('downloads bypass the worker, under the ingress prefix', async () => {
    const sw = await installedWorker();
    for (const p of ['api/files/download?path=%2Fconfig%2Fa.yaml', 'api/files/download-zip?path=%2Fconfig%2Fblueprints']) {
        assert.strictEqual(await sw.request(`${SCOPE}${p}`), null, p);
        assert.strictEqual(await sw.request(`${SCOPE}${p}`, { mode: 'navigate' }), null, `${p} (navigate)`);
    }
});

test('other API requests still go through the worker', async () => {
    const sw = await installedWorker();
    const res = await sw.request(`${SCOPE}api/files/list?path=x`);
    assert.strictEqual(res.text, `network:${SCOPE}api/files/list?path=x`);
});

test('only the download endpoints bypass, not look-alike paths', async () => {
    const sw = await installedWorker();
    for (const p of ['api/files/preview?path=download', 'api/files/downloads', 'api/files/download-zip-x', 'api/files/download/x', 'download']) {
        const res = await sw.request(`${SCOPE}${p}`);
        assert.strictEqual(res.text, `network:${SCOPE}${p}`, p);
    }
});

test('non-GET requests are left to the browser', async () => {
    const sw = await installedWorker();
    assert.strictEqual(await sw.request(`${SCOPE}upload`, { method: 'POST' }), null);
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
