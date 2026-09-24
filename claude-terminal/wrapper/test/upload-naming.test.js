'use strict';

const assert = require('node:assert');
const {
    uploadFilename,
    isAllowedImageMime,
    EXTENSION_FOR_MIME,
} = require('../upload-naming.js');

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

// Deterministic doubles: a frozen clock and a byte source that returns
// whatever the test hands it.
const FROZEN = () => 1700000000000;
const bytes = (hex) => () => Buffer.from(hex, 'hex');

// --- uploadFilename ---
//
// Background: uploads were named `pasted-${Date.now()}${ext}`. Two uploads in
// the same millisecond - two tabs, or a drop of several files - got the same
// name, and multer's disk storage silently overwrote the first with the
// second. The path already typed into the first terminal then pointed at the
// wrong image.
//
// The extension came from the client-supplied originalname. A direct API
// client could put `;|$()` into it, and index.html types the returned path
// into the terminal - a shell - verbatim.

test('two uploads in the same millisecond get different names', () => {
    const a = uploadFilename('image/png', { now: FROZEN, randomBytes: bytes('00000001') });
    const b = uploadFilename('image/png', { now: FROZEN, randomBytes: bytes('00000002') });
    assert.notStrictEqual(a, b);
});

test('uses the real random source by default, so defaults do not collide', () => {
    const names = new Set();
    for (let i = 0; i < 50; i++) names.add(uploadFilename('image/png', { now: FROZEN }));
    assert.strictEqual(names.size, 50);
});

test('names are pasted-<ms>-<8 hex>.<ext>', () => {
    assert.strictEqual(
        uploadFilename('image/png', { now: FROZEN, randomBytes: bytes('deadbeef') }),
        'pasted-1700000000000-deadbeef.png'
    );
});

test('derives the extension from the mimetype', () => {
    const cases = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/svg+xml': '.svg',
    };
    for (const [mime, ext] of Object.entries(cases)) {
        const name = uploadFilename(mime, { now: FROZEN, randomBytes: bytes('00000000') });
        assert.ok(name.endsWith(ext), `${mime} -> ${name}, expected ${ext}`);
    }
});

test('every generated name is shell-inert', () => {
    // The path is typed into a shell. Nothing outside this set may appear.
    for (const mime of Object.keys(EXTENSION_FOR_MIME)) {
        const name = uploadFilename(mime);
        assert.match(name, /^pasted-\d+-[0-9a-f]{8}\.[a-z]+$/, name);
    }
});

test('takes no originalname at all, so a hostile one cannot reach the name', () => {
    // The old code read path.extname(file.originalname). A client-chosen
    // extension like `.png;rm -rf ~` must have nowhere to go. The function's
    // only input about the file is its (filter-checked) mimetype.
    assert.strictEqual(uploadFilename.length, 1);
    const name = uploadFilename('image/png', { now: FROZEN, randomBytes: bytes('00000000') });
    assert.ok(!/[;|$()`&<> ]/.test(name), name);
});

test('refuses a mimetype with no allowlisted extension', () => {
    // fileFilter rejects these first; this is the second lock, so a future
    // change to the filter cannot quietly fall back to a client-chosen name.
    assert.throws(() => uploadFilename('text/html'));
    assert.throws(() => uploadFilename('image/png;x=1'));
    assert.throws(() => uploadFilename(undefined));
    assert.throws(() => uploadFilename('constructor'));
});

// --- isAllowedImageMime ---
//
// The filter and the namer share one table, so "accepted" and "has a safe
// extension" cannot drift apart.

test('accepts exactly the mimetypes that have an extension', () => {
    for (const mime of Object.keys(EXTENSION_FOR_MIME)) {
        assert.strictEqual(isAllowedImageMime(mime), true, mime);
    }
    assert.strictEqual(isAllowedImageMime('image/tiff'), false);
    assert.strictEqual(isAllowedImageMime('text/html'), false);
    assert.strictEqual(isAllowedImageMime('toString'), false);
    assert.strictEqual(isAllowedImageMime(undefined), false);
});

console.log(`\n${passed} passed`);
