'use strict';

/**
 * Downloads for the Files sidebar: one file as an attachment, or a folder as
 * a zip streamed with yazl.
 *
 * A module of its own rather than more of files-api.js, which is the
 * read-only browser (list, preview, recent changes, the config check) and
 * stays free of streaming and archive code. Everything that decides WHAT may
 * be shown stays there and is called from here - resolve() and its realpath
 * confinement, and walkEntryType(), the one visibility rule the listing, the
 * recent-changes walk and the zip walk share - so they cannot drift apart.
 *
 * No listener and no side effects at require time, so tests import it
 * directly (same reason as http-guards.js).
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline, Transform } = require('node:stream');
const express = require('express');
const {
    walkEntryType,
    allowsProtected,
    sendError,
    FilesError,
    MAX_RECENT_DEPTH,
    MAX_RECENT_VISITS,
    RECENT_TIME_BUDGET_MS,
} = require('./files-api');

// Uncompressed bytes one zip may hold. Fixed, not an option: it bounds how
// long one download keeps a Raspberry Pi's CPU and disk busy. The recorder
// database alone is often bigger, so zipping all of /config is usually
// refused, and the refusal names the biggest files so the user can see why.
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
// How many of the largest files a refusal names.
const LARGEST_NAMED = 5;

// Same steps as the sidebar's formatSize (public/files-sidebar.js), for
// messages the UI shows as they are.
function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Passes exactly `size` bytes and fails if the source ends short of them:
 * the file shrank after it was measured. The response then aborts instead
 * of ending cleanly at a length that would pass for the whole file.
 */
function exactSize(size) {
    let seen = 0;
    return new Transform({
        transform(chunk, encoding, callback) {
            seen += chunk.length;
            callback(null, chunk);
        },
        flush(callback) {
            callback(seen === size ? null : new Error(`file changed while it was read (${seen} of ${size} bytes)`));
        },
    });
}

// A client that stops reading must not hold a descriptor forever: the server
// has no socket timeout of its own.
const IDLE_MS = 60 * 1000;

// Headers a failed download may already have set. An error answer is JSON and
// must never be saved as an attachment.
function dropAttachmentHeaders(res) {
    for (const header of ['Content-Disposition', 'Content-Type', 'Content-Length', 'X-Content-Type-Options']) {
        res.removeHeader(header);
    }
}

/**
 * Pipe a source stream into a response, totally: it never throws, and
 * `release` (closing whatever the source reads from) runs on every path -
 * the response already gone, a setup that fails, a transfer that ends or
 * aborts, a client that stalls for idleMs. `release` must be idempotent.
 * Shared by single-file and zip downloads, so they cannot differ in cleanup.
 *
 * makeSource() builds the source; `through` are Transforms between it and the
 * response. A client that simply left (ERR_STREAM_PREMATURE_CLOSE) is not
 * logged, one cut off for stalling is logged once as such, and any other
 * failure as an abort, with `label` JSON-quoted so a name cannot forge a
 * line.
 */
function streamBody(res, { makeSource, through = [], release, label = 'download', log = console.error, idleMs = IDLE_MS }) {
    let source = null;
    let stalled = false;
    try {
        if (res.destroyed || res.writableEnded) {
            release();
            return;
        }
        res.setTimeout(idleMs, () => {
            stalled = true;
            res.destroy(new Error('client stalled'));
        });
        source = makeSource();
        pipeline(source, ...through, res, (err) => {
            release();
            if (stalled) {
                // One quiet line, so a proxy that stops reading (ingress)
                // can be told apart from a user who cancelled.
                log(`Download of ${JSON.stringify(label)} cut off: client stalled for ${idleMs} ms`);
            } else if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
                log(`Download of ${JSON.stringify(label)} aborted: ${err.message}`);
            }
        });
    } catch (err) {
        if (source) source.destroy();
        release();
        dropAttachmentHeaders(res);
        sendError(res, err, log);
    }
}

/**
 * Send an opened file ({ handle, stat }) as an attachment, on streamBody. The
 * filename goes through Express's res.attachment(), which encodes it per
 * RFC 6266 (ASCII fallback plus filename* in UTF-8).
 */
function sendAttachment({ handle, stat, name }, req, res, { log = console.error, idleMs = IDLE_MS } = {}) {
    const release = () => { handle.close().catch(() => {}); };
    try {
        if (res.destroyed || res.writableEnded) {
            release();
            return;
        }
        res.status(200);
        res.attachment(name);
        res.set({
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(stat.size),
            'X-Content-Type-Options': 'nosniff',
        });
    } catch (err) {
        release();
        dropAttachmentHeaders(res);
        sendError(res, err, log);
        return;
    }
    if (stat.size === 0 || req.method === 'HEAD') {
        release();
        res.end();
        return;
    }
    // Exactly the bytes Content-Length announced: a file that grows meanwhile
    // is cut at it (end), one that shrinks fails (exactSize).
    streamBody(res, {
        makeSource: () => handle.createReadStream({ start: 0, end: stat.size - 1 }),
        through: [exactSize(stat.size)],
        release,
        label: name,
        log,
        idleMs,
    });
}

/**
 * Downloads over a files-api instance, whose `root` (as configured) names a
 * zip of the root itself. The walk bounds default to the recent-changes
 * walk's, and are injectable for tests, as is `onListed`, which runs between
 * a folder being listed and being opened.
 */
function createDownloads({
    api,
    onListed = null,
    maxZipBytes = MAX_ZIP_BYTES,
    maxDepth = MAX_RECENT_DEPTH,
    maxVisits = MAX_RECENT_VISITS,
    timeBudgetMs = RECENT_TIME_BUDGET_MS,
    // Test seam: runs once the file is open or the zip is planned, before
    // the first byte goes out, so a test can change the disk at exactly the
    // moment that matters (the same idea as files-api's onResolved).
    beforeStream = null,
    idleMs = IDLE_MS,
} = {}) {
    /**
     * Resolve and open one file for download: { handle, stat, name }.
     * files-api's openRequested() makes the checks (kind by requested name
     * and realpath, the O_NOFOLLOW open, the /proc re-check). The name is
     * the one the user asked for, not a symlink target's. The caller owns
     * the handle.
     */
    async function openForDownload(requested, { allowSensitive = false } = {}) {
        const { handle, stat, real } = await api.openRequested(requested, { allowSensitive, action: 'download' });
        try {
            if (beforeStream) await beforeStream(real);
        } catch (err) {
            await handle.close().catch(() => {});
            throw err;
        }
        return { handle, stat, name: path.basename(String(requested)) || path.basename(real) };
    }

    /**
     * Walk a folder and decide what its zip holds, before a byte is sent:
     * { name, files: [{ full, name, size, mtime, mode }], bytes }.
     *
     * Left out, whatever protected=1 says: never-shown and sensitive entries
     * (a sensitive folder is not even entered), symlinks (never followed and
     * never archived), anything but regular files and folders, and partial
     * files (PARTIAL_FILE, which covers in-flight uploads). Refused with 413:
     * a walk that hits a bound, and a total over the cap.
     */
    async function planZip(requested) {
        const { real, relative, kind, root: rootReal } = await api.resolve(requested);
        if (kind === 'sensitive') throw new FilesError(403, 'This folder may hold secrets and is never zipped');
        let stat;
        try {
            stat = await fsp.stat(real);
        } catch {
            throw new FilesError(404, 'Not found or not allowed');
        }
        if (!stat.isDirectory()) throw new FilesError(400, 'Not a folder');

        // The archive's top folder. For the root, its name as configured
        // (config), not its realpath (/homeassistant on a real install).
        const top = relative === '' ? path.basename(path.resolve(api.root)) : path.basename(real);
        const files = [];
        let bytes = 0;
        let visits = 0;
        let cut = null;   // why the walk stopped early, for the refusal
        const deadline = Date.now() + timeBudgetMs;

        async function walk(dir, depth) {
            if (depth > maxDepth) {
                cut = `it is nested more than ${maxDepth} folders deep`;
                return;
            }
            if (onListed) await onListed(dir);
            let handle;
            try {
                handle = await fsp.opendir(dir);
            } catch (err) {
                if (depth === 0) throw new FilesError(400, `Cannot read folder (${err.code || 'error'})`);
                return;   // vanished or unreadable since its parent was listed
            }
            // Every dir is built from realpaths plus real folder names, so if
            // it is not its own realpath it was swapped for a link since the
            // listing. Skip it: its names and sizes must not reach the plan.
            try {
                if (await fsp.realpath(dir) !== dir) throw new Error('swapped');
            } catch {
                await handle.close().catch(() => {});
                return;
            }
            const subdirs = [];
            try {
                for await (const dirent of handle) {
                    if (++visits > maxVisits) {
                        cut = `it holds more than ${maxVisits} entries`;
                        break;
                    }
                    if (Date.now() > deadline) {
                        cut = 'listing it took too long';
                        break;
                    }
                    const full = path.join(dir, dirent.name);
                    const type = walkEntryType(path.relative(rootReal, full), dirent);
                    if (type === 'dir') {
                        subdirs.push(full);
                        continue;
                    }
                    if (type !== 'file') continue;
                    let st;
                    try {
                        st = await fsp.lstat(full);
                    } catch {
                        continue;
                    }
                    if (!st.isFile()) continue;   // swapped since the listing
                    // Zip names use '/' only, and yazl reads a backslash as
                    // one; a Linux name holding one keeps a '_' instead.
                    const name = `${top}/${path.relative(real, full)}`.replace(/\\/g, '_');
                    files.push({ full, name, size: st.size, mtime: st.mtime, mode: st.mode });
                    bytes += st.size;
                }
            } catch {
                // Folder changed under us; keep what was read.
            } finally {
                // Breaking out of for-await closes the handle already.
                await handle.close().catch(() => {});
            }
            for (const sub of subdirs) {
                if (cut) return;
                await walk(sub, depth + 1);
            }
        }

        // The biggest files seen, named in every 413 so the user can see why.
        const largest = (label) => {
            const top5 = [...files]
                .sort((a, b) => b.size - a.size)
                .slice(0, LARGEST_NAMED)
                .map((f) => `${f.name.slice(top.length + 1)} (${formatSize(f.size)})`);
            return top5.length ? ` ${label}: ${top5.join(', ')}` : '';
        };

        await walk(real, 0);
        if (cut) {
            throw new FilesError(413,
                `This folder is too big to zip: ${cut}. Zip a folder inside it instead.${largest('Largest so far')}`);
        }
        if (bytes > maxZipBytes) {
            throw new FilesError(413,
                `This folder holds ${formatSize(bytes)}, over the ${formatSize(maxZipBytes)} zip limit.${largest('Largest')}`);
        }
        return { name: `${top}.zip`, files, bytes };
    }

    return { openForDownload, sendFile: (opened, req, res, log) => sendAttachment(opened, req, res, { log, idleMs }), planZip };
}

/**
 * Express router for the downloads. Mounted by server.js at /api/files,
 * beside createFilesRouter, before the terminal proxy and static files.
 *
 * GET, read-only, no CORS headers: like the other Files GETs, another site
 * can start one but cannot read the answer. Every failure before the first
 * byte is a JSON error; after it, the response is aborted and logged.
 */
function createDownloadRouter({ downloads, fileLimiter, log = console.error }) {
    const router = express.Router();

    router.get('/download', fileLimiter, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        let opened;
        try {
            opened = await downloads.openForDownload(req.query.path, { allowSensitive: allowsProtected(req) });
        } catch (err) {
            return sendError(res, err, log);
        }
        downloads.sendFile(opened, req, res, log);
    });

    return router;
}

module.exports = {
    createDownloads,
    createDownloadRouter,
    sendAttachment,
    streamBody,
    MAX_ZIP_BYTES,
};
