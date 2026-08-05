'use strict';

const assert = require('node:assert');
const { planDecset, decodeOsc52 } = require('../public/terminal-mouse.js');

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

// --- planDecset: Select mode vetoes mouse tracking ---

test('vetoes Claude Code\'s tracking request', () => {
    assert.deepStrictEqual(planDecset([1000], true), { veto: true, replay: null });
});

test('vetoes vim/htop drag tracking (1002)', () => {
    assert.deepStrictEqual(planDecset([1002], true), { veto: true, replay: null });
});

test('vetoes any-motion tracking (1003)', () => {
    assert.deepStrictEqual(planDecset([1003], true), { veto: true, replay: null });
});

test('vetoes X10 tracking (9)', () => {
    assert.deepStrictEqual(planDecset([9], true), { veto: true, replay: null });
});

// THE REGRESSION GUARD. An all-or-nothing `params.every(isTracking)` check
// leaks here, because 1006 (SGR encoding) is not itself a tracking mode.
// Claude Code sends its modes separately, so a Claude-only manual test passes
// while vim and htop stay broken. Do not remove this test.
test('vetoes batched tracking + encoding (1000;1002;1006)', () => {
    assert.deepStrictEqual(planDecset([1000, 1002, 1006], true),
        { veto: true, replay: [1006] });
});

test('strips tracking but replays alt-screen from a mixed sequence', () => {
    assert.deepStrictEqual(planDecset([1000, 1049], true),
        { veto: true, replay: [1049] });
});

// --- planDecset: negative controls (must NOT be touched) ---

test('leaves alt screen alone', () => {
    assert.deepStrictEqual(planDecset([1049], true), { veto: false, replay: null });
});

test('leaves bracketed paste alone', () => {
    assert.deepStrictEqual(planDecset([2004], true), { veto: false, replay: null });
});

test('leaves focus events alone', () => {
    assert.deepStrictEqual(planDecset([1004], true), { veto: false, replay: null });
});

test('leaves SGR encoding alone when sent on its own', () => {
    assert.deepStrictEqual(planDecset([1006], true), { veto: false, replay: null });
});

// --- planDecset: Scroll mode allows everything through ---

test('Scroll mode permits tracking', () => {
    assert.deepStrictEqual(planDecset([1000], false), { veto: false, replay: null });
});

test('Scroll mode permits batched tracking', () => {
    assert.deepStrictEqual(planDecset([1000, 1002, 1006], false),
        { veto: false, replay: null });
});

// --- planDecset: malformed input must never veto ---

test('sub-parameter arrays are flattened to their first value', () => {
    assert.deepStrictEqual(planDecset([[1000, 5]], true), { veto: true, replay: null });
});

test('non-array input does not veto', () => {
    assert.deepStrictEqual(planDecset(null, true), { veto: false, replay: null });
});

test('empty params do not veto', () => {
    assert.deepStrictEqual(planDecset([], true), { veto: false, replay: null });
});

test('non-numeric params do not veto', () => {
    assert.deepStrictEqual(planDecset(['x'], true), { veto: false, replay: null });
});

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
