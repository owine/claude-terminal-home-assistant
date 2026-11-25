'use strict';

const assert = require('node:assert');
const { createKeyHandler, createCtrlCGuard, NEWLINE_INPUT, CTRL_C_WINDOW_MS } = require('../public/terminal-keys.js');

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

// --- createCtrlCGuard ---

// A guard on a manual clock, with the timers it starts and what it reported.
function guardHarness(windowMs) {
    const clock = { t: 0 };
    const timers = [];
    const events = [];
    const allow = createCtrlCGuard({
        now: () => clock.t,
        windowMs,
        setTimeout: (fn, ms) => timers.push({ fn, ms }),
        onLock: () => events.push('lock'),
        onUnlock: () => events.push('unlock'),
        onHeld: () => events.push('held'),
    });
    return { clock, timers, events, allow };
}

test('the guard window is two seconds by default', () => {
    assert.strictEqual(CTRL_C_WINDOW_MS, 2000);
    const { timers, allow } = guardHarness();
    allow();
    assert.strictEqual(timers[0].ms, 2000);
});

test('the first Ctrl+C goes through and locks the key', () => {
    const { events, allow } = guardHarness();
    assert.strictEqual(allow(), true);
    assert.deepStrictEqual(events, ['lock']);
});

test('a second Ctrl+C inside the window is held, so a double tap cannot quit Claude', () => {
    const { clock, timers, events, allow } = guardHarness();
    allow();
    clock.t = 1999;
    assert.strictEqual(allow(), false);
    assert.deepStrictEqual(events, ['lock', 'held']);
    assert.strictEqual(timers.length, 1, 'a held tap starts no timer');
});

test('the key unlocks when the window ends, and the next Ctrl+C goes through', () => {
    const { clock, timers, events, allow } = guardHarness();
    allow();
    clock.t = 2000;
    timers[0].fn();
    assert.deepStrictEqual(events, ['lock', 'unlock']);
    assert.strictEqual(allow(), true);
    assert.deepStrictEqual(events, ['lock', 'unlock', 'lock']);
});

test('the window counts from the last Ctrl+C let through, not the last tap', () => {
    // Held taps must not extend the window, or tapping steadily would lock
    // the key for good.
    const { clock, allow } = guardHarness();
    allow();
    clock.t = 1500;
    allow();
    clock.t = 2000;
    assert.strictEqual(allow(), true);
});

test('a late timer does not unlock a key the clock already locked again', () => {
    // iOS throttles timers: the clock lets the next tap in before the first
    // timer fires. The key must stay locked until the newest timer, and
    // onLock must not run twice (it saves the label onUnlock restores).
    const { clock, timers, events, allow } = guardHarness();
    allow();
    clock.t = 2000;
    assert.strictEqual(allow(), true);
    assert.deepStrictEqual(events, ['lock'], 'still locked: no second onLock');
    timers[0].fn();
    assert.deepStrictEqual(events, ['lock'], 'the stale timer is ignored');
    timers[1].fn();
    assert.deepStrictEqual(events, ['lock', 'unlock']);
});

test('the guard works without callbacks', () => {
    const timers = [];
    const allow = createCtrlCGuard({ now: () => 0, setTimeout: (fn) => timers.push(fn) });
    assert.strictEqual(allow(), true);
    assert.strictEqual(allow(), false);
    timers[0]();
});

// --- the header's key buttons (index.html) ---

const page = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/index.html'), 'utf8');

test('the header has a new-line key that sends the Shift+Enter bytes', () => {
    assert.match(page, /<button class="ctrl-btn" data-input="newline"[^>]*aria-label="[^"]+"/);
    assert.ok(page.includes("'newline': window.TerminalKeys && window.TerminalKeys.NEWLINE_INPUT"));
});

test('the ^C key goes through the Ctrl+C guard', () => {
    assert.ok(page.includes('<button class="ctrl-btn" data-input="\\x03"'));
    assert.ok(page.includes("rawInput === '\\\\x03' ? ctrlCKeyGuard(btn)"));
    assert.ok(page.includes('window.TerminalKeys.createCtrlCGuard('));
});

console.log(`\n${passed} passed`);
