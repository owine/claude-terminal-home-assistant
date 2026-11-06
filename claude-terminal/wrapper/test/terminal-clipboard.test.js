'use strict';

const assert = require('node:assert');
const { decodeOsc52, sanitizeForClipboard } = require('../public/terminal-clipboard.js');

// Helper: base64 of an arbitrary byte string, so a payload can carry control
// bytes a real OSC 52 write would.
const osc = (s) => `c;${Buffer.from(s, 'binary').toString('base64')}`;

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

// --- decodeOsc52 ---

test('decodes a base64 clipboard write', () => {
    const b64 = Buffer.from('hello world').toString('base64');
    assert.deepStrictEqual(decodeOsc52(`c;${b64}`), { kind: 'write', text: 'hello world' });
});

test('decodes UTF-8 correctly', () => {
    const b64 = Buffer.from('café — ünicode ✂').toString('base64');
    assert.deepStrictEqual(decodeOsc52(`c;${b64}`), { kind: 'write', text: 'café — ünicode ✂' });
});

test('handles an empty selection parameter', () => {
    const b64 = Buffer.from('x').toString('base64');
    assert.deepStrictEqual(decodeOsc52(`;${b64}`), { kind: 'write', text: 'x' });
});

// SECURITY: honoring a read request would let any process that can write to
// the terminal exfiltrate the user's system clipboard over the PTY.
test('refuses clipboard READ requests', () => {
    assert.deepStrictEqual(decodeOsc52('c;?'), { kind: 'read' });
});

test('rejects oversized payloads', () => {
    assert.deepStrictEqual(decodeOsc52('c;' + 'A'.repeat(1000001)), { kind: 'oversize' });
});

test('rejects a payload with no separator', () => {
    assert.deepStrictEqual(decodeOsc52('garbage'), { kind: 'invalid' });
});

test('rejects non-base64 payloads', () => {
    assert.deepStrictEqual(decodeOsc52('c;not!valid!base64'), { kind: 'invalid' });
});

test('rejects non-string input', () => {
    assert.deepStrictEqual(decodeOsc52(null), { kind: 'invalid' });
});

// Node's Buffer.from(s, 'base64') silently truncates malformed base64
// (wrong length mod 4, mismatched padding) instead of rejecting it, while
// the browser's atob() throws. The regex must be the single source of
// strictness so both environments agree on every accepted input — these
// would previously decode successfully under Node and diverge from the
// browser, which is exactly the bug being guarded against here.
test('rejects base64 whose length is not a multiple of 4', () => {
    assert.deepStrictEqual(decodeOsc52('c;A'), { kind: 'invalid' });
    assert.deepStrictEqual(decodeOsc52('c;AAAAA'), { kind: 'invalid' });
});

test('rejects base64 with padding that does not match the data length', () => {
    assert.deepStrictEqual(decodeOsc52('c;A='), { kind: 'invalid' });
    assert.deepStrictEqual(decodeOsc52('c;=='), { kind: 'invalid' });
});

// Boundary: exactly at the cap must still decode (only strictly-over is
// rejected). Length must itself be valid base64 (a multiple of 4).
test('accepts a payload exactly at the size cap', () => {
    const payload = 'A'.repeat(1000000);
    const result = decodeOsc52(`c;${payload}`);
    assert.strictEqual(result.kind, 'write');
});

// Empty selection payload: deliberately treated as a valid (empty)
// clipboard write, not 'invalid' — an empty string is valid base64 and an
// app clearing the clipboard via OSC 52 is a legitimate use case.
test('treats an empty payload as an empty clipboard write', () => {
    assert.deepStrictEqual(decodeOsc52('c;'), { kind: 'write', text: '' });
});

// --- sanitizeForClipboard, and decodeOsc52's use of it ---
//
// SECURITY: clipboard text is later pasted into the terminal, which interprets
// control bytes. An ESC that begins ESC ] 201 ~ can end bracketed-paste mode
// mid-paste, and a following CR submits, so the tail of the pasted text runs as
// a command. The payload can be an OSC 52 write from any process on the PTY (or
// across ssh), or a /config file name another app planted and the admin copied.
// Control bytes except TAB and LF are therefore stripped before the clipboard.

test('sanitizeForClipboard strips ESC and the bracketed-paste end marker', () => {
    // The injection shape: text, then an ESC-introduced control sequence, then
    // a CR. With ESC and CR gone, only inert printable characters remain.
    const result = sanitizeForClipboard('name\x1b[201~\rpayload');
    assert.strictEqual(result, 'name[201~payload');
    assert.ok(!result.includes('\x1b'), 'no ESC survives');
    assert.ok(!result.includes('\r'), 'no CR survives');
});

test('sanitizeForClipboard keeps TAB and LF, drops other C0, DEL and C1', () => {
    // 0x00-0x08, 0x0b-0x1f, 0x7f, 0x80-0x9f go; 0x09 (TAB) and 0x0a (LF) stay.
    let s = '';
    for (let c = 0; c <= 0x9f; c++) s += String.fromCharCode(c);
    s += 'Z';
    const out = sanitizeForClipboard(s);
    // Printable ASCII 0x20-0x7e, then the trailing Z.
    let expected = '\t\n';
    for (let c = 0x20; c <= 0x7e; c++) expected += String.fromCharCode(c);
    expected += 'Z';
    assert.strictEqual(out, expected);
});

test('sanitizeForClipboard drops a lone CR but leaves CRLF as LF', () => {
    assert.strictEqual(sanitizeForClipboard('a\r\nb'), 'a\nb');
    assert.strictEqual(sanitizeForClipboard('a\rb'), 'ab');
});

test('sanitizeForClipboard leaves ordinary and non-ASCII text untouched', () => {
    const s = 'café — ünicode ✂\ttabbed\nmultiline';
    assert.strictEqual(sanitizeForClipboard(s), s);
});

test('sanitizeForClipboard passes non-strings through unchanged', () => {
    assert.strictEqual(sanitizeForClipboard(null), null);
    assert.strictEqual(sanitizeForClipboard(undefined), undefined);
});

test('decodeOsc52 strips control bytes from the decoded write', () => {
    // The decoded text a caller receives must already be clipboard-safe.
    assert.deepStrictEqual(decodeOsc52(osc('name\x1b[201~\rtouch pwned')),
        { kind: 'write', text: 'name[201~touch pwned' });
});

test('decodeOsc52 keeps newlines in a legitimate multi-line copy', () => {
    assert.deepStrictEqual(decodeOsc52(osc('line one\nline two\n')),
        { kind: 'write', text: 'line one\nline two\n' });
});

console.log(`\n${passed} passed`);
