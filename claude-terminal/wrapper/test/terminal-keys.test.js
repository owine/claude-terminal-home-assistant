'use strict';

const assert = require('node:assert');
const { createKeyHandler, NEWLINE_INPUT } = require('../public/terminal-keys.js');

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

// A key event as xterm hands it to a custom key handler.
const key = (type, k, mods = {}) => ({
    type, key: k, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, ...mods,
});

function harness() {
    const sent = [];
    return { sent, handle: createKeyHandler((data) => sent.push(data)) };
}

// --- createKeyHandler ---

test('the newline input is backslash then carriage return', () => {
    assert.strictEqual(NEWLINE_INPUT, '\\\r');
});

test('Shift+Enter keydown sends the newline input and is claimed', () => {
    const { sent, handle } = harness();
    assert.strictEqual(handle(key('keydown', 'Enter', { shiftKey: true })), false);
    assert.deepStrictEqual(sent, [NEWLINE_INPUT]);
});

test('the keypress and keyup of the chord are claimed without sending', () => {
    // xterm consults the handler for keypress too; letting it through would
    // add xterm's own carriage return after ours and submit the prompt.
    const { sent, handle } = harness();
    assert.strictEqual(handle(key('keypress', 'Enter', { shiftKey: true })), false);
    assert.strictEqual(handle(key('keyup', 'Enter', { shiftKey: true })), false);
    assert.deepStrictEqual(sent, []);
});

test('plain Enter passes through', () => {
    const { sent, handle } = harness();
    for (const type of ['keydown', 'keypress', 'keyup']) {
        assert.strictEqual(handle(key(type, 'Enter')), true, type);
    }
    assert.deepStrictEqual(sent, []);
});

test('Shift+Enter with another modifier passes through', () => {
    const { sent, handle } = harness();
    for (const mod of ['ctrlKey', 'altKey', 'metaKey']) {
        assert.strictEqual(handle(key('keydown', 'Enter', { shiftKey: true, [mod]: true })), true, mod);
    }
    assert.deepStrictEqual(sent, []);
});

test('Shift+Enter while an IME is composing passes through', () => {
    // The IME owns Enter mid-composition (it commits the candidate).
    const { sent, handle } = harness();
    assert.strictEqual(handle(key('keydown', 'Enter', { shiftKey: true, isComposing: true })), true);
    assert.deepStrictEqual(sent, []);
});

test('other shifted keys pass through', () => {
    const { sent, handle } = harness();
    assert.strictEqual(handle(key('keydown', 'A', { shiftKey: true })), true);
    assert.strictEqual(handle(key('keydown', 'Tab', { shiftKey: true })), true);
    assert.deepStrictEqual(sent, []);
});

test('a held chord sends once per keydown', () => {
    const { sent, handle } = harness();
    handle(key('keydown', 'Enter', { shiftKey: true }));
    handle(key('keydown', 'Enter', { shiftKey: true }));
    assert.deepStrictEqual(sent, [NEWLINE_INPUT, NEWLINE_INPUT]);
});

console.log(`\n${passed} passed`);
