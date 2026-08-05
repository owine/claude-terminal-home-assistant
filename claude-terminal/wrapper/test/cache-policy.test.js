'use strict';

const assert = require('node:assert');
const { cacheControlFor } = require('../cache-policy.js');

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`ok - ${name}`);
    } catch (err) {
        console.error(`FAIL - ${name}`);
        console.error(err.message);
        process.exitCode = 1;
    }
}

// --- cacheControlFor ---
//
// Background: a Safari user stayed on 2.7.0's terminal-mouse.js for a whole
// release after the add-on had updated. express.static's default
// `Cache-Control: public, max-age=0` is only a hint to revalidate and Safari
// did not, while a `?cb=` request returned the new file immediately. Bumping
// CACHE_NAME in sw.js does not help: that key governs the SERVICE WORKER
// cache, and the service worker's own network-first fetch() is still answered
// from the browser's HTTP cache underneath it.
//
// 'no-cache' is the correction. It does not mean "do not store" — it means
// "revalidate before every use", so ETags turn the common case into a 304 with
// no body. That is what makes an add-on update take effect on the next load
// without anyone clearing anything.

test('forces revalidation of the HTML shell', () => {
    assert.strictEqual(cacheControlFor('/opt/wrapper/public/index.html'), 'no-cache');
});

test('forces revalidation of scripts', () => {
    // The exact file that went stale.
    assert.strictEqual(cacheControlFor('/opt/wrapper/public/terminal-mouse.js'), 'no-cache');
    assert.strictEqual(cacheControlFor('/opt/wrapper/public/login-link.js'), 'no-cache');
});

// A stale service worker is the worst case: it outlives reloads and keeps
// serving an old shell, so it must never be cached without revalidation.
test('forces revalidation of the service worker', () => {
    assert.strictEqual(cacheControlFor('/opt/wrapper/public/sw.js'), 'no-cache');
});

test('forces revalidation of the web app manifest', () => {
    assert.strictEqual(cacheControlFor('/opt/wrapper/public/manifest.json'), 'no-cache');
});

test('forces revalidation of the offline fallback page', () => {
    assert.strictEqual(cacheControlFor('/opt/wrapper/public/offline.html'), 'no-cache');
});

// Icons may be cached, but deliberately NOT with `immutable` or a one-year
// max-age: their filenames carry no content hash, so an icon change would
// otherwise be unable to reach anyone who had already loaded the old one.
test('lets icons be cached for a day, and never immutably', () => {
    for (const file of ['icon-192.png', 'icon-512.png', 'icon.svg', 'icon-maskable.svg']) {
        const value = cacheControlFor(`/opt/wrapper/public/${file}`);
        assert.strictEqual(value, 'public, max-age=86400', file);
        assert.ok(!value.includes('immutable'), file);
    }
});

// Matching by extension alone would hand a day-long cache to any image added
// later — a screenshot, a diagram, a logo — purely because it ends in .png.
// The cacheable set is the icons specifically, so anything else falls through
// to revalidation and a new asset cannot inherit a cacheable policy by
// accident. This is the fail-safe direction: unrecognized means correct but
// slower, never stale.
test('caches icons specifically, not every image', () => {
    assert.strictEqual(cacheControlFor('/opt/wrapper/public/screenshot.png'), 'no-cache');
    assert.strictEqual(cacheControlFor('/opt/wrapper/public/logo.svg'), 'no-cache');
    assert.strictEqual(cacheControlFor('/opt/wrapper/public/diagram.webp'), 'no-cache');
});

// A name that merely contains "icon" is not an icon.
test('requires the icon prefix rather than a substring match', () => {
    assert.strictEqual(cacheControlFor('/opt/wrapper/public/favicon-fallback.png'), 'no-cache');
});

// Anything unrecognized revalidates too. New shell assets get added over time
// and the safe default for an unknown file is correctness, not speed.
test('defaults unknown file types to revalidation', () => {
    assert.strictEqual(cacheControlFor('/opt/wrapper/public/whatever.txt'), 'no-cache');
    assert.strictEqual(cacheControlFor('/opt/wrapper/public/noextension'), 'no-cache');
});

// Extension matching must not be fooled by case or by a dot inside a
// directory name, both of which appear in real deployments.
test('matches extensions case-insensitively', () => {
    assert.strictEqual(cacheControlFor('/opt/wrapper/public/ICON-192.PNG'), 'public, max-age=86400');
});

test('is not fooled by a dot in a parent directory name', () => {
    assert.strictEqual(cacheControlFor('/opt/wrapper/v1.2/public/index.html'), 'no-cache');
});

console.log(`\n${passed} passed`);
