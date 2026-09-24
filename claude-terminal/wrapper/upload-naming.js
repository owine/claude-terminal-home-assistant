'use strict';

/**
 * Naming for uploaded images - pure logic, split out of server.js so it can be
 * unit tested (server.js opens a listener at require time).
 *
 * Two defects shaped this:
 *
 * - Names were `pasted-${Date.now()}${ext}`. Two uploads in the same
 *   millisecond (two tabs) collided, and multer's disk storage silently
 *   overwrote the first file with the second. A random suffix makes that
 *   practically impossible.
 *
 * - The extension came from the client's `originalname`. index.html types the
 *   returned path into the terminal - a shell - so a direct API client could
 *   smuggle `;|$()` into it. The extension is now looked up from the mimetype
 *   the filter already checked, and the client's filename is never read.
 */

const crypto = require('crypto');

// The one table of accepted image types. The upload filter and the namer both
// read it, so "accepted" and "has a known-safe extension" cannot drift apart.
// A null-prototype object, so lookups like 'constructor' find nothing.
const EXTENSION_FOR_MIME = Object.freeze(Object.assign(Object.create(null), {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
}));

function isAllowedImageMime(mimetype) {
    return typeof mimetype === 'string' && mimetype in EXTENSION_FOR_MIME;
}

/**
 * `pasted-<epoch ms>-<8 hex chars><ext>`: every character is in [a-z0-9.-],
 * so the name is inert when typed into a shell. Throws for a mimetype with no
 * allowlisted extension rather than inventing one.
 *
 * `now` and `randomBytes` are injectable for tests.
 */
function uploadFilename(mimetype, { now = Date.now, randomBytes = crypto.randomBytes } = {}) {
    if (!isAllowedImageMime(mimetype)) {
        throw new Error(`No file extension for mimetype: ${mimetype}`);
    }
    const suffix = randomBytes(4).toString('hex');
    return `pasted-${now()}-${suffix}${EXTENSION_FOR_MIME[mimetype]}`;
}

module.exports = { uploadFilename, isAllowedImageMime, EXTENSION_FOR_MIME };
