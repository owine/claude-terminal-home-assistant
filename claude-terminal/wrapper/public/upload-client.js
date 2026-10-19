'use strict';

// Uploads from the browser, shared by the Files sidebar (files-sidebar-ui.js)
// and the terminal's own ways in: the paperclip, a paste and a drop
// (index.html). What is the same for both lives here once: the check=1
// question and the upload itself, one file's way from the one to the other,
// the batch rule that stops at the first 429, and reading the files out of a
// drop. What each shows stays with it: the sidebar's notice, collision
// prompt and tree; the terminal's status line and the paths it types.
//
// Dual target, like files-sidebar.js: in the browser it attaches
// window.UploadClient and needs files-sidebar.js loaded before it (for
// uploadUrl, uploadErrorText, uploadSummary, displayName and shellQuote);
// under Node it is module.exports, for the tests. Without files-sidebar.js
// it attaches nothing, and both callers treat uploads as unavailable.
(function (root, helpers) {
    if (!helpers) {
        console.error('[wrapper] files-sidebar.js did not load; uploads are unavailable');
        return;
    }

    // The check=1 question (no body): { status, data }, status 0 when no
    // answer came. fetchImpl is a test seam.
    async function ask(url, { fetchImpl } = {}) {
        try {
            const res = await (fetchImpl || fetch)(url, { method: 'POST', cache: 'no-store' });
            return { status: res.status, data: await res.json().catch(() => ({})) };
        } catch (err) {
            return { status: 0, data: { error: err.message } };
        }
    }

    // The upload itself, by XHR: fetch reports no upload progress. The body
    // is the file's bytes as they are; onProgress gets 0 to 1. XHRImpl is a
    // test seam.
    function send(url, file, onProgress = () => {}, { XHRImpl } = {}) {
        return new Promise((resolve) => {
            const xhr = new (XHRImpl || XMLHttpRequest)();
            xhr.open('POST', url);
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable && e.total) onProgress(e.loaded / e.total);
            };
            xhr.onload = () => {
                let data = {};
                try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
                resolve({ status: xhr.status, data });
            };
            xhr.onerror = () => resolve({ status: 0, data: {} });
            xhr.onabort = () => resolve({ status: 0, data: {} });
            xhr.send(file);
        });
    }

    /**
     * One file into /config through api/files/upload: asked about first
     * (a refusal sent before a big body has been read is often lost behind
     * ingress), then sent. Resolves to { result } (the server's answer) once
     * it is in, { problem, status } when it was refused or failed, or
     * { skipped } when the user cancelled a collision. The name goes to the
     * server as it is; the server cleans it.
     *
     * The inbox numbers a taken name (up to a cap), so a caller that only
     * uploads there can leave askCollision out; without it a taken name is
     * a refusal. askCollision(text, replaceable) answers a chosen folder's
     * taken name with 'replace', 'keep-both' or null. onCheck() runs before
     * the question; onSend() runs before the body and returns the progress
     * callback.
     */
    async function uploadOne(file, { dest, askCollision, onCheck = () => {}, onSend = () => undefined, fetchImpl, XHRImpl } = {}) {
        const name = file.name;
        onCheck();
        const asked = await ask(helpers.uploadUrl({ name, dest, check: true, size: file.size }), { fetchImpl });
        let onConflict;
        if (asked.status === 409 && asked.data.reason === 'exists' && askCollision) {
            onConflict = await askCollision(asked.data.error || helpers.displayName(name) + ' already exists.',
                asked.data.replaceable === true);
            if (!onConflict) return { skipped: name };
        } else if (asked.status !== 200) {
            return { problem: helpers.uploadErrorText(asked.status, asked.data, name), status: asked.status };
        }
        const sent = await send(helpers.uploadUrl({ name, dest, onConflict }), file, onSend(), { XHRImpl });
        if (sent.status !== 200 || typeof sent.data.path !== 'string') {
            return { problem: helpers.uploadErrorText(sent.status, sent.data, name), status: sent.status };
        }
        return { result: sent.data };
    }

    /**
     * Files one after another through uploadFile(file, counter, index),
     * which resolves to what uploadOne does. `counter` is ' (2 of 3)' in a
     * batch of several, '' for one file. Stops at the first 429 (too many
     * uploads): the rest would only be refused too, each spending another
     * request, so that file and every one after it are `busy`.
     * onStart(index) runs as each file starts.
     */
    async function runBatch(files, uploadFile, { onStart = () => {} } = {}) {
        const outcome = { results: [], problems: [], skipped: [], busy: [] };
        for (let i = 0; i < files.length; i++) {
            onStart(i);
            const counter = files.length > 1 ? ' (' + (i + 1) + ' of ' + files.length + ')' : '';
            const done = await uploadFile(files[i], counter, i);
            if (done.status === 429) {
                outcome.busy = files.slice(i).map((f) => f.name);
                break;
            }
            if (done.result) outcome.results.push(done.result);
            else if (done.problem) outcome.problems.push(done.problem);
            else outcome.skipped.push(done.skipped);
        }
        return outcome;
    }

    /**
     * The files of a drop, read while its event lasts (its data is gone
     * after): { files, folders }. A dropped folder arrives as a File too; it
     * is left out, and named in `folders`.
     */
    function droppedFiles(dataTransfer) {
        const files = [];
        const folders = [];
        const items = Array.from((dataTransfer && dataTransfer.items) || []).filter((i) => i.kind === 'file');
        if (items.length) {
            for (const item of items) {
                const asEntry = item.webkitGetAsEntry?.();
                if (asEntry?.isDirectory) {
                    folders.push(asEntry.name);
                    continue;
                }
                const file = item.getAsFile();
                if (file) files.push(file);
            }
        } else {
            files.push(...Array.from((dataTransfer && dataTransfer.files) || []));
        }
        return { files, folders };
    }

    // --- The terminal's paperclip, paste and drop ---

    // The image upload's types and size limit, as server.js enforces them
    // (upload-naming.js's EXTENSION_FOR_MIME and IMAGE_MAX_BYTES). The unit
    // tests hold the two sides equal.
    const IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);
    const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

    /**
     * Where a file from the terminal's paperclip, a paste or a drop goes:
     * 'image' (the image upload, /data/images, exactly as before) for an
     * allowlisted image of at most IMAGE_MAX_BYTES; 'inbox' (api/files/upload
     * into /config/uploads) for everything else: HEIC photos, bigger images,
     * any other file.
     */
    function terminalRoute(file) {
        return IMAGE_TYPES.includes(file.type) && file.size <= IMAGE_MAX_BYTES ? 'image' : 'inbox';
    }

    // The image upload (POST upload, multipart, field `image`), as the
    // paperclip has always sent it: { status, data }, status 0 when no
    // answer came, data {} when the answer was not JSON.
    async function sendImage(file, { fetchImpl } = {}) {
        const form = new FormData();
        form.append('image', file);
        try {
            const res = await (fetchImpl || fetch)('upload', { method: 'POST', body: form });
            let data = {};
            try { data = JSON.parse(await res.text()) || {}; } catch { /* not JSON */ }
            return { status: res.status, data };
        } catch (err) {
            return { status: 0, data: { error: err.message } };
        }
    }

    /**
     * One file from the terminal, sent where terminalRoute says: resolves
     * to what uploadOne does. onLine(text, fraction) is the status line,
     * fraction null while there is no progress to show, else 0 to 1. Never
     * asks about a taken name: the inbox numbers it, and image names are
     * the server's own.
     */
    async function uploadForTerminal(file, { counter = '', onLine = () => {}, fetchImpl, XHRImpl } = {}) {
        const shown = helpers.displayName(file.name);
        const line = 'Uploading ' + shown + counter + '…';
        if (terminalRoute(file) === 'image') {
            onLine(line, null);
            const sent = await sendImage(file, { fetchImpl });
            if (sent.status === 200 && typeof sent.data.path === 'string') return { result: sent.data };
            return { problem: helpers.uploadErrorText(sent.status, sent.data, file.name), status: sent.status };
        }
        return uploadOne(file, {
            onCheck: () => onLine('Checking ' + shown + counter + '…', null),
            onSend: () => {
                onLine(line, 0);
                return (fraction) => onLine(line, fraction);
            },
            fetchImpl,
            XHRImpl,
        });
    }

    /**
     * What the terminal types for a batch: every path that came back, in
     * order, space-separated, each quoted only where the shell would read
     * something into it (inbox names are the user's; image names are safe
     * words and stay as they are).
     */
    function typedPaths(results) {
        return results.map((r) => helpers.shellQuote(r.path)).join(' ');
    }

    /**
     * The status line after a terminal batch, as { message, type,
     * persistent }, or null when the paths were typed and nothing went wrong
     * (injectIntoTerminal said so already). `delivered`: 'terminal' (typed),
     * 'clipboard' (copied instead) or 'none' (only shown here). Refusals use
     * the sidebar's words (uploadSummary) and stay until the next message.
     */
    function terminalStatus({ typed = '', count = 0, delivered = 'terminal', problems = [], busy = [], folders = [] } = {}) {
        const parts = [];
        if (typed && delivered === 'clipboard') {
            parts.push((count > 1 ? 'Copied paths: ' : 'Copied path: ') + typed + ' — paste in terminal');
        }
        if (typed && delivered === 'none') parts.push((count > 1 ? 'Paths: ' : 'Path: ') + typed);
        parts.push(...helpers.uploadSummary({ problems, busy, folders }).lines);
        if (!parts.length) return null;
        const refused = problems.length + busy.length + folders.length > 0;
        return { message: parts.join(' '), type: refused ? 'error' : 'success', persistent: refused || delivered === 'none' };
    }

    /**
     * The files in a paste, or none. A clipboard that also holds plain text
     * is a text paste and is left alone: spreadsheet cells come with a
     * picture of themselves, and pasting their text into the terminal must
     * not upload the picture instead. Screenshots and copied images carry no
     * plain text.
     */
    function clipboardFiles(clipboardData) {
        if (!clipboardData) return [];
        if (Array.from(clipboardData.types || []).includes('text/plain')) return [];
        const files = Array.from(clipboardData.items || [])
            .filter((i) => i.kind === 'file')
            .map((i) => i.getAsFile())
            .filter(Boolean);
        return files.length ? files : Array.from(clipboardData.files || []);
    }

    // Marks a frame window as already caught. A reloaded frame (a ttyd
    // reconnect) is a new window without it.
    const FRAME_CAUGHT = Symbol('uploadClientFrameFiles');
    const carriesFiles = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files');
    // During a drag the browser sends dragover every few tens of
    // milliseconds, even with the pointer still. This long without one, the
    // drag has ended somewhere the frame never heard of.
    const FRAME_DRAG_IDLE_MS = 350;

    /**
     * Take the pastes and drops that carry files inside the terminal's
     * frame. A paste while the terminal has focus, and a drop over it, land
     * in the frame's document, where the page's own listeners never see
     * them. Capture phase on the frame's window, so these run before
     * xterm's own listeners; only events carrying files are touched, so a
     * text paste, and a drag of a link or of text, still reach xterm and the
     * browser as before. Drag and paste events only, never a mouse,
     * pointer, wheel or key listener: mouse reporting is tmux's alone
     * (CLAUDE.md, "Mouse ownership"). Once per frame window; returns whether
     * it registered.
     *   onFiles({ files, folders })  files were dropped or pasted
     *   onDragging(on)               a file drag entered or left the frame
     *   timers                       setTimeout/clearTimeout for the watch
     *                                that takes a quiet drag's overlay down
     *                                (default: the frame window's)
     */
    function catchFrameFiles(win, { onFiles, onDragging = () => {}, timers = win }) {
        if (!win || win[FRAME_CAUGHT]) return false;
        let depth = 0;
        let quiet = null;
        const stopWatch = () => {
            if (quiet !== null) timers.clearTimeout(quiet);
            quiet = null;
        };
        const watch = () => {
            stopWatch();
            quiet = timers.setTimeout(() => {
                quiet = null;
                depth = 0;
                onDragging(false);
            }, FRAME_DRAG_IDLE_MS);
        };
        const take = (e) => {
            e.preventDefault();
            e.stopImmediatePropagation();
        };
        win.addEventListener('dragenter', (e) => {
            if (!carriesFiles(e)) return;
            take(e);
            watch();
            if (++depth === 1) onDragging(true);
        }, true);
        win.addEventListener('dragover', (e) => {
            if (!carriesFiles(e)) return;
            take(e);
            e.dataTransfer.dropEffect = 'copy';
            watch();
            // A drag that only paused past the watch: light it again.
            if (depth === 0) {
                depth = 1;
                onDragging(true);
            }
        }, true);
        win.addEventListener('dragleave', (e) => {
            if (!carriesFiles(e)) return;
            e.stopImmediatePropagation();
            if (depth > 0 && --depth === 0) {
                stopWatch();
                onDragging(false);
            }
        }, true);
        win.addEventListener('drop', (e) => {
            if (!carriesFiles(e)) return;
            take(e);
            stopWatch();
            depth = 0;
            onDragging(false);
            onFiles(droppedFiles(e.dataTransfer));
        }, true);
        win.addEventListener('paste', (e) => {
            const files = clipboardFiles(e.clipboardData);
            if (!files.length) return;
            take(e);
            onFiles({ files, folders: [] });
        }, true);
        win[FRAME_CAUGHT] = true;
        return true;
    }

    const api = {
        ask, send, uploadOne, runBatch, droppedFiles,
        IMAGE_TYPES, IMAGE_MAX_BYTES, terminalRoute, sendImage, uploadForTerminal,
        typedPaths, terminalStatus, clipboardFiles,
        catchFrameFiles,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.UploadClient = api;
})(typeof self !== 'undefined' ? self : this,
    typeof module !== 'undefined' && module.exports
        ? require('./files-sidebar.js')
        : (typeof self !== 'undefined' ? self.FilesSidebar : undefined));
