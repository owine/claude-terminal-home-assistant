'use strict';

// OSC 52 clipboard decoding — pure logic (no DOM, no xterm, no clipboard
// access). Shipped to the browser (attaches to window.TerminalClipboard) AND
// required by the Node test harness (module.exports).
//
// Why this exists: ttyd 1.7.7 registers no OSC 52 handler, so clipboard
// sequences arriving from tmux or any process on the terminal were silently
// discarded. decodeOsc52 gives the wrapper one to register.
//
// This module used to also arbitrate mouse tracking, vetoing applications'
// DECSET requests so text selection kept working. That decision now belongs to
// tmux alone, with xterm's own force-selection modifier covering selection
// while reporting is on — see DOCS.md. The veto and its reconciliation loop
// were removed because they raced with tmux over unordered transports and
// could wedge mouse mode until a page reload.
(function (root) {
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

    const api = { decodeOsc52 };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.TerminalClipboard = api;
})(typeof self !== 'undefined' ? self : this);
