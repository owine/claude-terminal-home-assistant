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

    function isAuthUrl(url) {
        return typeof url === 'string' && AUTH_URL.test(url);
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
                for (let j = i + 1; ranToEnd && filledToBoundary(raw, clean, j - 1, cols) && j < clean.length; j++) {
                    if (!isAllUrl(clean[j])) break; // prose / blank / border → stop
                    url += clean[j];
                }
                if (isAuthUrl(url)) return url;
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
