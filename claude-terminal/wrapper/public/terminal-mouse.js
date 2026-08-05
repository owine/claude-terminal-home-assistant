'use strict';

// Terminal mouse ownership + clipboard decoding — pure logic (no DOM, no xterm,
// no clipboard access). Shipped to the browser (attaches to window.TerminalMouse)
// AND required by the Node test harness (module.exports).
// See docs/superpowers/specs/2026-08-05-terminal-mouse-clipboard-design.md
(function (root) {
    // DEC private modes that make the terminal report mouse events to the
    // application. 1000 = normal (press/release), 1001 = highlight,
    // 1002 = button-drag, 1003 = any-motion. Encoding modes (1005/1006/1015)
    // are deliberately NOT here: they only change the report format and are
    // inert once tracking is off.
    const MOUSE_TRACKING = new Set([1000, 1001, 1002, 1003]);

    // Decide what to do with a `CSI ? ... h` (DECSET) sequence.
    //
    // Returns { veto, replay }:
    //   veto   - true means suppress xterm.js's default handler
    //   replay - modes to re-emit because they were batched alongside tracking
    //            modes and are none of our business (null if there are none)
    //
    // Filtering rather than gating all-or-nothing is load-bearing: apps batch
    // modes, e.g. `CSI ? 1000;1002;1006 h`. See the regression guard in
    // test/terminal-mouse.test.js.
    function planDecset(params, selectMode) {
        const none = { veto: false, replay: null };
        if (!selectMode || !Array.isArray(params) || params.length === 0) return none;

        const flat = params
            .map((p) => (Array.isArray(p) ? p[0] : p))
            .map(Number);
        if (flat.some((p) => !Number.isFinite(p))) return none;

        const rest = flat.filter((p) => !MOUSE_TRACKING.has(p));
        if (rest.length === flat.length) return none;   // nothing to veto

        return { veto: true, replay: rest.length > 0 ? rest : null };
    }

    const api = { planDecset, MOUSE_TRACKING };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.TerminalMouse = api;
})(typeof self !== 'undefined' ? self : this);
