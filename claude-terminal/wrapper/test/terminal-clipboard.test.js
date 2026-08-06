'use strict';

const assert = require('node:assert');
const { decodeOsc52 } = require('../public/terminal-clipboard.js');

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

console.log(`\n${passed} passed`);
