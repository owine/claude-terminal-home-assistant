'use strict';

// Key handling for ttyd's xterm.js — pure logic (no DOM, no xterm). Shipped to
// the browser (attaches to window.TerminalKeys) AND required by the Node test
// harness (module.exports).
//
// Why this exists: xterm.js sends a plain carriage return for Shift+Enter, so
// Claude Code submitted the prompt instead of starting a new line. Claude's
// /terminal-setup cannot fix that here; it only writes keybindings for desktop
// terminal apps it knows. Backslash + return is Claude Code's own "insert a
// newline" escape, and it holds when both bytes arrive in one write through
// tmux (checked against Claude Code 2.1.314). At a bash prompt the same bytes
// are a line continuation, so the chord is harmless outside Claude too.
(function (root) {
    const NEWLINE_INPUT = '\\\r';

    // Shift+Enter alone. With Ctrl, Alt or Meta held it stays xterm's, and so
    // does Enter while an IME is composing (Enter commits the candidate there).
    function isShiftEnter(event) {
        return event.key === 'Enter' && event.shiftKey && !event.isComposing &&
            !event.ctrlKey && !event.altKey && !event.metaKey;
    }

    // Build a handler for term.attachCustomKeyEventHandler. xterm consults it
    // for keydown, keypress and keyup alike, and `false` means "not yours".
    // Every event of the chord is claimed, because a keypress let through would
    // add xterm's own carriage return and submit after all; only keydown sends.
    function createKeyHandler(send) {
        return (event) => {
            if (!isShiftEnter(event)) return true;
            if (event.type === 'keydown') send(NEWLINE_INPUT);
            return false;
        };
    }

    // Two Ctrl+C in a row quit Claude Code, and on a phone a double tap on the
    // header's ^C key is easy. The guard lets one through per window, counted
    // from the last one it let through; a tap inside the window is held, not
    // queued. Only the key is guarded: a real keyboard's Ctrl+C goes straight
    // to xterm.
    //
    // allow() decides on the clock, but the key's locked look is undone by a
    // timer, and a throttled page (iOS) can fire that timer late, after the
    // clock has already let the next tap in. So onLock runs only on the way
    // from unlocked to locked, and only the newest timer runs onUnlock: the
    // caller can save the key's label in onLock and trust onUnlock to put it
    // back once. Adapted from Claude Workbench (Eifel-Joe) by way of
    // ESJavadex/claude-code-ha's key bar.
    const CTRL_C_WINDOW_MS = 2000;

    function createCtrlCGuard(options = {}) {
        const now = options.now || Date.now;
        const windowMs = options.windowMs === undefined ? CTRL_C_WINDOW_MS : options.windowMs;
        const later = options.setTimeout || ((fn, ms) => setTimeout(fn, ms));
        const noop = () => {};
        const onLock = options.onLock || noop;
        const onUnlock = options.onUnlock || noop;
        const onHeld = options.onHeld || noop;
        let lastSent = null;
        let locked = false;
        let newest = 0;
        return function allow() {
            const t = now();
            if (lastSent !== null && t - lastSent < windowMs) {
                onHeld();
                return false;
            }
            lastSent = t;
            const mine = ++newest;
            if (!locked) {
                locked = true;
                onLock();
            }
            later(() => {
                if (mine !== newest) return;
                locked = false;
                onUnlock();
            }, windowMs);
            return true;
        };
    }

    const api = { createKeyHandler, createCtrlCGuard, NEWLINE_INPUT, CTRL_C_WINDOW_MS };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.TerminalKeys = api;
})(typeof self !== 'undefined' ? self : this);
