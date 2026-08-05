'use strict';

// Terminal mouse ownership + clipboard decoding — pure logic (no DOM, no xterm,
// no clipboard access). Shipped to the browser (attaches to window.TerminalMouse)
// AND required by the Node test harness (module.exports).
//
// Why this exists: applications request mouse reporting via DECSET, and once
// xterm.js grants it, native browser text selection stops working. tmux passes
// an inner application's request straight through, so tmux's own `mouse` option
// cannot prevent it — the decision has to be made in the browser. Separately,
// ttyd 1.7.7 registers no OSC 52 handler, so clipboard sequences were silently
// discarded; decodeOsc52 gives the wrapper one to register.
(function (root) {
    // DEC private modes that make the terminal report mouse events to the
    // application. 9 = X10 compatibility, 1000 = normal (press/release),
    // 1001 = highlight, 1002 = button-drag, 1003 = any-motion. Encoding modes
    // (1005/1006/1015) are deliberately NOT here: they only change the report
    // format and are inert once tracking is off.
    const MOUSE_TRACKING = new Set([9, 1000, 1001, 1002, 1003]);

    // Decide what to do with a `CSI ? ... h` (DECSET) sequence.
    //
    // Returns { veto, replay, tracking } — all three fields are always present:
    //   veto     - true means this sequence needs handling; see below
    //   replay   - the NON-tracking modes batched alongside tracking ones, or
    //              null when the batch was purely tracking modes
    //   tracking - the tracking modes found, or null when nothing was vetoed
    //
    // The caller's two cases, and why they differ:
    //
    //   replay === null (pure tracking batch) — suppress the sequence outright.
    //   replay !== null (mixed batch)         — let the ORIGINAL sequence apply
    //     unchanged and queue a DECRST for `tracking` instead.
    //
    // The mixed case cannot be handled by suppress-and-re-emit. A parser
    // handler's term.write() ENQUEUES, it does not apply inline, so re-emitting
    // `1049` (alt screen) after suppressing `1000;1049h` applies the screen
    // switch AFTER the application's following output has already landed on the
    // primary buffer. Turning tracking off afterwards is not render-order
    // sensitive, so the DECRST can safely be queued.
    //
    // Filtering rather than gating all-or-nothing is load-bearing: apps batch
    // modes, e.g. `CSI ? 1000;1002;1006 h`. See the regression guard in
    // test/terminal-mouse.test.js.
    //
    // Fails OPEN on unparseable params: a single non-finite value abandons
    // the whole sequence and lets it through un-vetoed. This is the one place
    // the module's posture inverts (elsewhere it defaults to blocking) —
    // deliberate, on the principle of never vetoing a sequence we don't
    // confidently understand.
    function planDecset(params, selectMode) {
        const none = { veto: false, replay: null, tracking: null };
        if (!selectMode || !Array.isArray(params) || params.length === 0) return none;

        const flat = params
            .map((p) => (Array.isArray(p) ? p[0] : p))
            .map(Number);
        if (flat.some((p) => !Number.isFinite(p))) return none;

        const rest = flat.filter((p) => !MOUSE_TRACKING.has(p));
        if (rest.length === flat.length) return none;   // nothing to veto

        // Sub-parameters (the `p[0]` flattening above) are discarded on both
        // returned lists: none of the DEC private modes that can appear here
        // take sub-parameters, so `[[1049, 2], 1000]` reports `replay: [1049]`,
        // not `[[1049, 2]]`.
        return {
            veto: true,
            replay: rest.length > 0 ? rest : null,
            tracking: flat.filter((p) => MOUSE_TRACKING.has(p)),
        };
    }

    // Cap on the size of a single clipboard write, in base64 characters. This
    // bounds one payload only — it is not a rate limit, so a program issuing
    // many under-cap writes in quick succession is unbounded here; throttling
    // repeated writes, if wanted, is the caller's concern.
    const OSC52_MAX = 1000000;

    // Strict base64: length must be a multiple of 4, with padding present
    // only where the data length requires it. This must be the SOLE source
    // of validation strictness. `Buffer.from(s, 'base64')` (Node, used by the
    // tests) silently truncates malformed input instead of rejecting it,
    // while the browser's `atob` throws; a looser regex here would let Node
    // accept strings the shipped browser code refuses, so the tests would
    // pass while exercising a decode path users never hit.
    const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

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
    //
    // `data` must be the complete, already-reassembled OSC payload. This
    // function does no chunk buffering of its own: if a caller ever fed it
    // one piece of a payload split across multiple OSC chunks, a base64
    // string cut mid-run would decode as a truncated write rather than fail,
    // because there's nothing here to notice the string was incomplete.
    //
    // Invalid UTF-8 in the decoded bytes is intentionally NOT rejected — it
    // decodes lossily to U+FFFD per the platform TextDecoder, matching how
    // terminals generally treat clipboard data leniently. The try/catch below
    // exists for decode-time errors (e.g. from `atob`), not for bad UTF-8, so
    // don't read it as UTF-8 validation.
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

    const api = { planDecset, decodeOsc52 };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.TerminalMouse = api;
})(typeof self !== 'undefined' ? self : this);
