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

    // Cap on a single clipboard write, in base64 characters. Bounds a runaway
    // or hostile program hammering the clipboard.
    const OSC52_MAX = 1000000;
    const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

    function b64ToBytes(b64) {
        if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(b64, 'base64'));
        return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    }

    // Decode an OSC 52 payload of the form `<selection>;<base64 | '?'>`.
    // Returns { kind: 'write', text } | { kind: 'read' } | { kind: 'oversize' }
    //       | { kind: 'invalid' }
    //
    // 'read' is reported separately so the caller can refuse it explicitly
    // rather than by omission — see the security note in the spec.
    function decodeOsc52(data) {
        if (typeof data !== 'string') return { kind: 'invalid' };
        const i = data.indexOf(';');
        if (i === -1) return { kind: 'invalid' };

        const payload = data.slice(i + 1);
        if (payload === '?') return { kind: 'read' };
        if (payload.length > OSC52_MAX) return { kind: 'oversize' };
        if (!BASE64.test(payload)) return { kind: 'invalid' };

        try {
            return { kind: 'write', text: new TextDecoder().decode(b64ToBytes(payload)) };
        } catch {
            return { kind: 'invalid' };
        }
    }

    const api = { planDecset, decodeOsc52, MOUSE_TRACKING };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.TerminalMouse = api;
})(typeof self !== 'undefined' ? self : this);
