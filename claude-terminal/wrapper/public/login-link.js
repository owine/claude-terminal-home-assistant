'use strict';

// Login Link Assistant — pure logic (no DOM, no xterm `term` access).
// Shipped to the browser (attaches to window.LoginLink) AND required by the
// Node test harness (module.exports). See docs/superpowers/specs/2026-07-07-*.
(function (root) {
    // Characters valid inside a URL (RFC 3986 unreserved + reserved + '%').
    const URLCHARS = "A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%";
    const LEAD_URL = new RegExp('^[' + URLCHARS + ']+');
    const HAS_NON_URL = new RegExp('[^' + URLCHARS + ']');
    // Strip surrounding whitespace and vertical box-drawing glyphs from a row.
    const BORDER = /^[\s│┃┆┇┊┋║|]+|[\s│┃┆┇┊┋║|]+$/g;
    // Authoritative auth-URL shape (hosts + path verified from the CLI binary).
    const AUTH_URL =
        /^https:\/\/(?:[a-z0-9-]+\.)*(?:claude\.ai|claude\.com|anthropic\.com)\/[^\s]*oauth\/authorize\b/i;
    // Query parameters Claude Code always puts on the authorize URL (it
    // appends them unconditionally; orgUUID, login_hint and login_method come
    // after state, and only sometimes). A capture missing one was cut short.
    const REQUIRED_PARAMS = ['client_id', 'response_type', 'redirect_uri', 'code_challenge', 'state'];
    // Endings no complete URL has: an ellipsis where the renderer elided the
    // rest, half a %-escape, or a separator with nothing after it.
    const CUT_SHORT = /(?:\.\.\.|…|%[0-9A-Fa-f]?|[?&=])$/;
    // A row of URL characters ending in an ellipsis: the URL it continues
    // was elided, not wrapped.
    const ELIDED = new RegExp('^[' + URLCHARS + ']*…$');

    // A complete OAuth authorize URL: the right host and path, and every
    // parameter the login needs present and non-empty. Truncated captures
    // (a row cut short, an elided "…" tail) are rejected rather than posted
    // as a link that cannot log anyone in. A truncation inside the last
    // parameter's value still passes; the notifier's isTruncationOf covers
    // that once the full URL has been seen.
    function isAuthUrl(url) {
        if (typeof url !== 'string' || !AUTH_URL.test(url) || CUT_SHORT.test(url)) return false;
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            return false;
        }
        if (!/\/oauth\/authorize$/.test(parsed.pathname)) return false;
        return REQUIRED_PARAMS.every((name) => Boolean(parsed.searchParams.get(name)));
    }

    // A trimmed row that is one unbroken run of URL characters (a wrapped middle
    // or final segment). Border padding has already been stripped.
    function isAllUrl(s) {
        return s.length > 0 && !HAS_NON_URL.test(s);
    }

    // A row Ink filled to the wrap boundary (so the URL continues on the next
    // row). Bare wraps fill to the terminal width (needs `cols`); boxed rows are
    // detectable because border-stripping changed the row and the inner content
    // is a solid URL-char run. Without `cols` and without borders we cannot tell
    // a wrap from a complete short line, so we do NOT join — returning a clean
    // single-row URL beats silently splicing in the next line.
    function filledToBoundary(raw, clean, idx, cols) {
        if (typeof cols === 'number' && cols > 0 && raw[idx].length >= cols - 2) return true;
        return raw[idx] !== clean[idx] && isAllUrl(clean[idx]);
    }

    // Reconstruct the first auth URL from an array of terminal row strings.
    // Ink hard-wraps with real newlines, so we join across rows by consuming
    // URL-charset runs — but only across genuine wrap boundaries. `cols` is the
    // terminal width (optional). Returns the URL string or null.
    function reconstructLoginUrl(rows, cols) {
        if (!Array.isArray(rows)) return null;
        const raw = rows.map((r) => String(r));
        const clean = raw.map((r) => r.replace(BORDER, ''));
        for (let i = 0; i < clean.length; i++) {
            let from = 0;
            for (;;) {
                const rel = clean[i].slice(from).search(/https:\/\//i);
                if (rel === -1) break;
                const at = from + rel;
                const startRun = (clean[i].slice(at).match(LEAD_URL) || [''])[0];
                let url = startRun;
                const ranToEnd = at + startRun.length === clean[i].length;
                // Whether the renderer elided the rest with "…", right after
                // the run or on the row the join stopped at.
                let elided = clean[i].startsWith('…', at + startRun.length);
                // Whether the URL may go on past the end of the capture: its
                // last row is filled to the wrap boundary and nothing after
                // it was captured (or only the empty string a trailing
                // newline leaves). Then the rest - part of `state`, say - is
                // below the pane, and what was read is only a prefix.
                let cut = false;
                let j = i + 1;
                for (; ranToEnd && filledToBoundary(raw, clean, j - 1, cols) && j < clean.length; j++) {
                    if (!isAllUrl(clean[j])) { // prose / blank / border → stop
                        elided = ELIDED.test(clean[j]);
                        cut = j === clean.length - 1 && clean[j] === '';
                        break;
                    }
                    url += clean[j];
                }
                if (j === clean.length && ranToEnd && filledToBoundary(raw, clean, j - 1, cols)) cut = true;
                if (!elided && !cut && isAuthUrl(url)) return url;
                from = at + Math.max(startRun.length, 1);
            }
        }
        return null;
    }

    // Detect Claude Code's leg-2 prompt. The primary flow asks for an
    // authentication code ("Paste code here if prompted > "); the URL patterns
    // are the fallback shown when the redirect page errors.
    function isPasteBackPrompt(text) {
        if (typeof text !== 'string') return false;
        return (
            /paste code here if prompted/i.test(text) ||
            /paste the url from your browser's address bar/i.test(text) ||
            /(^|\s)URL\s*>\s*$/m.test(text)
        );
    }

    const api = { reconstructLoginUrl, isAuthUrl, isPasteBackPrompt };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.LoginLink = api;
})(typeof self !== 'undefined' ? self : this);
