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

    const api = { ask, send, uploadOne, runBatch, droppedFiles };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.UploadClient = api;
})(typeof self !== 'undefined' ? self : this,
    typeof module !== 'undefined' && module.exports
        ? require('./files-sidebar.js')
        : (typeof self !== 'undefined' ? self.FilesSidebar : undefined));
