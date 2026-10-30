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

    const api = { createKeyHandler, NEWLINE_INPUT };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.TerminalKeys = api;
})(typeof self !== 'undefined' ? self : this);
