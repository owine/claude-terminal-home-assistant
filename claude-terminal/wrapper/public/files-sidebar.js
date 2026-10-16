'use strict';

// Files sidebar helpers - pure logic (no DOM, no fetch). Shipped to the
// browser (attaches to window.FilesSidebar) AND required by the Node test
// harness (module.exports). The DOM wiring is files-sidebar-ui.js.
(function (root) {
    // Characters a POSIX shell gives no special meaning anywhere in a word that
    // starts with '/'. A path made only of these is typed as-is.
    const SAFE_WORD = /^[A-Za-z0-9_/.,:@%+=-]+$/;
    // C0 and C1 controls and DEL. Typed raw, these would be keystrokes (a
    // newline is Enter) or escape sequences when echoed back.
    // eslint-disable-next-line no-control-regex
    const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

    /**
     * Quote a path for a shell prompt so it arrives as one word and nothing in
     * it is interpreted: single quotes normally, ANSI-C $'...' when the name
     * holds control characters, so those are typed as escapes and never as
     * keystrokes.
     */
    function shellQuote(p) {
        const s = String(p);
        if (s === '') return "''";
        if (SAFE_WORD.test(s)) return s;
        if (!CONTROL.test(s)) return "'" + s.replace(/'/g, "'\\''") + "'";
        let out = "$'";
        for (const ch of s) {
            const code = ch.codePointAt(0);
            if (ch === '\\') out += '\\\\';
            else if (ch === "'") out += "\\'";
            else if (code < 0x20 || code === 0x7f) out += '\\x' + code.toString(16).padStart(2, '0');
            else if (code >= 0x80 && code <= 0x9f) out += '\\u' + code.toString(16).padStart(4, '0');
            else out += ch;
        }
        return out + "'";
    }

    function formatSize(bytes) {
        if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    }

    function formatAgo(mtime, now) {
        const seconds = Math.max(0, ((now === undefined ? Date.now() : now) - mtime) / 1000);
        if (seconds < 60) return 'just now';
        if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
        if (seconds < 86400) return Math.floor(seconds / 3600) + ' h ago';
        return Math.floor(seconds / 86400) + ' d ago';
    }

    // Sidebar width bounds. The terminal always keeps MIN_TERMINAL px.
    const DEFAULT_WIDTH = 300;
    const MIN_WIDTH = 180;
    const MAX_WIDTH = 800;
    const MIN_TERMINAL = 200;

    /** Clamp a requested width (e.g. from localStorage) to what fits. */
    function clampWidth(width, viewportWidth) {
        const n = Number(width);
        const wanted = Number.isFinite(n) && n > 0 ? n : DEFAULT_WIDTH;
        const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, (Number(viewportWidth) || Infinity) - MIN_TERMINAL));
        return Math.round(Math.min(Math.max(wanted, MIN_WIDTH), max));
    }

    /** Path relative to the root for display, or the path itself if outside. */
    function relativeTo(rootPath, p) {
        if (rootPath && p.startsWith(rootPath + '/')) return p.slice(rootPath.length + 1);
        return p;
    }

    /**
     * URL of a file download, or of a folder's zip. Relative, so under
     * ingress it resolves below /api/hassio_ingress/<token>/; a leading slash
     * would leave the add-on. `check` asks for the zip's plan as JSON instead
     * of the zip. `protectedOn` adds protected=1 to single files only: a zip
     * never holds protected files, so the flag would mean nothing there.
     */
    function downloadUrl(p, { zip = false, check = false, protectedOn = false } = {}) {
        let url = (zip ? 'api/files/download-zip' : 'api/files/download') + '?path=' + encodeURIComponent(p);
        if (zip && check) url += '&check=1';
        if (!zip && protectedOn) url += '&protected=1';
        return url;
    }

    const api = { shellQuote, formatSize, formatAgo, clampWidth, relativeTo, downloadUrl, DEFAULT_WIDTH };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.FilesSidebar = api;
})(typeof self !== 'undefined' ? self : this);
