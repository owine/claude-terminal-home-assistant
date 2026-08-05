'use strict';

// Cache-Control policy for the static shell — pure logic (no express, no fs),
// so it can be unit-tested without standing up the server. server.js wires it
// into express.static via setHeaders.
//
// Why this exists: express.static's default is `Cache-Control: public,
// max-age=0`, which invites revalidation but does not require it. Safari 26
// declined, and a user ran 2.7.0's terminal-mouse.js against 2.7.1's
// index.html for an entire release — behaviour matching neither version. A
// request with a `?cb=` query returned the new file immediately, proving the
// server was correct and the browser's HTTP cache was not.
//
// Bumping CACHE_NAME in sw.js does not cover this. That key governs the
// SERVICE WORKER cache; the service worker's own network-first fetch() is
// still answered from the browser's HTTP cache sitting underneath it. The two
// layers have to be addressed separately, and this is the lower one.
//
// 'no-cache' is not 'no-store': the response is still cached, it just has to
// be revalidated before each use. With express.static's ETags that makes the
// steady state a 304 with no body, so the cost of correctness here is one
// conditional request per asset per load.

const path = require('node:path');

const REVALIDATE = 'no-cache';

// Icons are the one thing worth caching: they are comparatively large, change
// almost never, and a stale icon is cosmetic rather than behavioural.
const ICON_CACHE = 'public, max-age=86400';

// Deliberately NOT `immutable`, and deliberately a day rather than a year:
// these filenames carry no content hash, so a long or immutable policy would
// leave an updated icon permanently unable to reach anyone already holding the
// old one.
const IMAGE_EXTENSIONS = new Set(['.png', '.svg', '.ico', '.webp']);

// Matching on extension alone is not enough. It would hand the same day-long
// cache to any image added later — a screenshot, a diagram, a logo — purely
// because of how it is named, which is the opposite of the fail-safe default
// this module is built around. Requiring the `icon` prefix as well means the
// cacheable set is the PWA icons specifically (icon.svg, icon-192.png,
// icon-maskable-512.png, ...), and every future asset falls through to
// revalidation until someone deliberately decides otherwise.
const ICON_PREFIX = 'icon';

// Everything else — HTML, JS, JSON, non-icon images, and anything
// unrecognized — revalidates. Defaulting to correctness rather than speed
// matters because shell assets get added over time, and the failure mode of
// guessing wrong is a user silently running stale code.
function cacheControlFor(filePath) {
    const name = path.basename(String(filePath)).toLowerCase();
    const ext = path.extname(name);
    const isIcon = IMAGE_EXTENSIONS.has(ext) && name.startsWith(ICON_PREFIX);
    return isIcon ? ICON_CACHE : REVALIDATE;
}

module.exports = { cacheControlFor };
