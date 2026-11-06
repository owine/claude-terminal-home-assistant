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

    // Strip control bytes from text on its way to the system clipboard, keeping
    // only tab and newline. The threat: clipboard content is later PASTED into
    // the terminal, and a terminal interprets control bytes. An ESC (0x1b)
    // begins a control sequence, so clipboard text holding ESC ] 201 ~ can end
    // bracketed-paste mode mid-paste, and a following CR (0x0d) submits — the
    // tail of the pasted text then runs as a command the admin never typed.
    // The bytes come from wherever the clipboard was loaded: an OSC 52 write
    // issued by any process on the PTY (or a host at the far end of ssh), or a
    // /config file name a different app planted and the admin copied.
    //
    // Removed: C0 (0x00-0x1f) except TAB (0x09) and LF (0x0a), DEL (0x7f), and
    // C1 (0x80-0x9f). CR is dropped rather than kept, so a CRLF pair survives
    // as LF and multi-line text stays multi-line; LF itself is kept because a
    // multi-line copy is legitimate, and inside bracketed paste a newline is
    // delivered as data, not as a submit. This matches how tmux and xterm
    // sanitize clipboard data, and leaves all printable text, including every
    // non-ASCII character, untouched.
    // eslint-disable-next-line no-control-regex
    const CLIPBOARD_CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

    function sanitizeForClipboard(text) {
        if (typeof text !== 'string') return text;
        return text.replace(CLIPBOARD_CONTROL, '');
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
            // Control bytes are stripped here, at the decode source, so the
            // write a caller receives is already safe to place on the clipboard
            // without the caller having to remember to sanitize. The clipboard
            // write helpers in index.html sanitize again, as defence in depth.
            const text = sanitizeForClipboard(new TextDecoder().decode(b64ToBytes(payload)));
            return { kind: 'write', text };
        } catch {
            return { kind: 'invalid' };
        }
    }

    const api = { decodeOsc52, sanitizeForClipboard };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.TerminalClipboard = api;
})(typeof self !== 'undefined' ? self : this);
