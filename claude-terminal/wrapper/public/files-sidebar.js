'use strict';

// Files sidebar helpers - pure logic (no DOM, no fetch). Shipped to the
// browser (attaches to window.FilesSidebar) AND required by the Node test
// harness (module.exports). The DOM wiring is files-sidebar-ui.js.
(function (root) {
    // Characters a POSIX shell gives no special meaning anywhere in a word that
    // starts with '/'. A path made only of these, '/' first, is typed as-is.
    // The leading '/' is required: zsh's EQUALS option expands a leading '='
    // (=ls is /bin/ls), and a leading '-' or '%' is an option or a job.
    const SAFE_WORD = /^\/[A-Za-z0-9_/.,:@%+=-]*$/;
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

    /**
     * URL of an upload, or of its check=1 preflight (`check`, with the file's
     * `size`, and no body). Relative, like downloadUrl. No `dest` means the
     * inbox. Every value is encoded: names come from the user's device.
     */
    function uploadUrl({ name, dest, onConflict, check = false, size } = {}) {
        let url = 'api/files/upload?name=' + encodeURIComponent(name);
        if (dest !== undefined && dest !== null) url += '&dest=' + encodeURIComponent(dest);
        if (onConflict) url += '&onConflict=' + encodeURIComponent(onConflict);
        if (check) url += '&check=1&size=' + encodeURIComponent(String(size));
        return url;
    }

    // The inbox, below the root. Its sweep is run.sh's (upload_retention_days),
    // and only for a folder the add-on made: one holding its .ctp-inbox marker.
    const INBOX = 'uploads';

    /**
     * What a folder row's "Upload here" looks like, from its listing entry:
     * null when it is not offered at all (a symlinked folder, which the
     * server refuses), else { disabled, hint, title }. The server makes the
     * same checks; this only keeps the UI from offering what it would refuse.
     */
    function uploadTarget(entry, rootPath) {
        if (!entry || entry.type !== 'dir' || entry.symlink) return null;
        if (entry.sensitive) {
            return {
                disabled: true,
                hint: 'Protected folders are never upload targets',
                title: 'This folder may hold secrets, so nothing is uploaded into it.',
            };
        }
        const rel = relativeTo(rootPath, entry.path);
        if (rel.split('/')[0].toLowerCase() === 'deps') {
            return {
                disabled: true,
                hint: 'Home Assistant manages this folder',
                title: 'deps holds the Python packages Home Assistant installs, so nothing is uploaded into it.',
            };
        }
        if (rel === INBOX) {
            return {
                disabled: false,
                hint: 'Cleared after upload_retention_days if the add-on made it',
                title: 'If the add-on made this folder (it holds .ctp-inbox), files here are deleted once they are older '
                    + 'than the upload_retention_days option (30 days unless changed). A folder you made is never cleared.',
            };
        }
        return { disabled: false, hint: '', title: 'Upload files into this folder' };
    }

    // Control characters, and the invisible marks that reorder or hide
    // text (bidirectional marks, embeddings, overrides and isolates, and
    // the byte-order mark): the same ranges files-upload.js strips from
    // upload names, so `photo<U+202E>gpj.exe` cannot read as `photoexe.jpg`
    // in the notice either.
    // eslint-disable-next-line no-control-regex
    const INVISIBLE = /[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

    /** A file name from the user's device, as the sidebar shows it. */
    function displayName(name) {
        return String(name).replace(INVISIBLE, '');
    }

    /**
     * The sidebar's line for a failed upload request: the server's own
     * message when it sent one (it names the limit, the folder, the reason),
     * prefixed with the file's name unless it names the file already, else
     * one for the status. Status 0 is a request that never got an answer.
     */
    function uploadErrorText(status, data, name) {
        const shown = displayName(name);
        if (status === 0) return 'Could not reach the add-on to upload ' + shown + '. Check the connection and try again.';
        const said = data && typeof data.error === 'string' ? data.error : '';
        if (said) return said.includes(shown) ? said : shown + ': ' + said;
        if (status === 413) return shown + ' is over the upload limit (the add-on\'s upload_max_mb option).';
        return shown + ': upload failed (HTTP ' + status + ').';
    }

    /**
     * The notice's lines after a batch, and its kind ('', 'busy', 'error'):
     * what was uploaded (`results`, the server's answers), what the user
     * cancelled (`skipped`), the folders a drop left out (`folders`), every
     * refusal (`problems`, uploadErrorText lines), and what a 429 left
     * untried (`busy`: a route stops at its first one, so they get one
     * line together rather than a refusal each).
     */
    function uploadSummary({ results = [], skipped = [], folders = [], problems = [], busy = [] } = {}) {
        const lines = [];
        const last = results[results.length - 1];
        if (results.length > 1) {
            lines.push('Uploaded ' + results.length + ' files to ' + last.dir + '.');
        } else if (last) {
            lines.push((last.replaced ? 'Replaced ' : 'Uploaded ') + displayName(last.name)
                + (last.replaced ? ' in ' : ' to ') + last.dir + '.');
        }
        if (skipped.length) lines.push('Not uploaded: ' + skipped.map(displayName).join(', ') + '.');
        if (folders.length) {
            lines.push('Folders are not uploaded: ' + folders.map(displayName).join(', ')
                + '. Drop the files inside them instead.');
        }
        lines.push(...problems.map((p) => '⚠️ ' + p));
        if (busy.length) {
            lines.push('⏳ ' + (busy.length === 1 ? displayName(busy[0]) : String(busy.length))
                + ' not uploaded: too many uploads, try again in a minute.');
        }
        const kind = problems.length ? 'error' : busy.length ? 'busy' : '';
        return { lines, kind };
    }

    /**
     * The tab a key moves focus to in a horizontal tablist of `count` tabs,
     * focus being on tab `index`: Right and Left wrap around, Home and End go
     * to the ends. -1 for any other key, or when focus is not on a tab. Only
     * focus moves: Enter or Space (the tab's own click) switches.
     */
    function tabKeyTarget(key, index, count) {
        if (count < 1 || index < 0 || index >= count) return -1;
        switch (key) {
            case 'ArrowRight': return (index + 1) % count;
            case 'ArrowLeft': return (index - 1 + count) % count;
            case 'Home': return 0;
            case 'End': return count - 1;
            default: return -1;
        }
    }

    /**
     * Whether a listing's answer (api/files/list or api/files/recent) is
     * one: an object with an entries array. getJson reads a 200 that is not
     * JSON (a proxy's page, say) as {}, which is not.
     */
    function isListing(data) {
        return !!data && typeof data === 'object' && Array.isArray(data.entries);
    }

    /**
     * What a view says about the names the server could not read (not
     * valid UTF-8) and so left out: its `unreadableNames` count. '' when
     * there are none, or no count (an older server). `kind`: 'zip' (a
     * sentence for the zip's notice), 'folder' (a note under a folder), or
     * 'recent' (a note under Recent changes, whose count covers every name
     * the walk passed, of whatever age, so it claims nothing about when
     * they changed).
     */
    function unreadableNote(n, kind) {
        if (!Number.isInteger(n) || n <= 0) return '';
        const names = n + (n === 1 ? ' name' : ' names');
        const verb = n === 1 ? 'is' : 'are';
        if (kind === 'zip') return names + ' could not be read (not valid UTF-8) and ' + verb + ' left out.';
        if (kind === 'folder') return names + ' here could not be read (not valid UTF-8) and ' + verb + ' not shown';
        return names + ' could not be read (not valid UTF-8)';
    }

    const api = {
        shellQuote, formatSize, formatAgo, clampWidth, relativeTo, downloadUrl,
        uploadUrl, uploadTarget, uploadErrorText, displayName, uploadSummary, tabKeyTarget,
        isListing, unreadableNote,
        INBOX, DEFAULT_WIDTH,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.FilesSidebar = api;
})(typeof self !== 'undefined' ? self : this);
