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
const { pipeline, Readable, Transform } = require('node:stream');
const express = require('express');
const yazl = require('yazl');
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
// Zips running at once, from the request until the transfer settles.
const MAX_CONCURRENT_ZIPS = 2;
// How many of the largest files a refusal names.
const LARGEST_NAMED = 5;

// Formats that are compressed already: deflating them again costs a
// Raspberry Pi's CPU and saves next to nothing, so they are stored.
const STORED = /\.(jpe?g|png|webp|gif|mp3|mp4|mkv|gz|tgz|zip|7z|xz|bz2|zst)$/i;

// Zip names use '/' only, and yazl reads a backslash as one; a Linux name
// holding one keeps a '_' instead.
const zipSafe = (name) => name.replace(/\\/g, '_');

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
 * Send a planned zip ({ name, files }) on streamBody, its entries opened
 * through `openFile` (files-api's: O_NOFOLLOW, the tiers, the /proc
 * re-check), never by yazl's addFile, which opens by path and follows
 * symlinks. Lazily: yazl asks for an entry's stream only when it reaches it,
 * so one file is open at a time however many the zip holds.
 *
 * Every failure after the first byte aborts the response, so the browser
 * shows a failed download rather than a cut-off archive that looks whole;
 * streamBody logs it (a client that simply left excepted). Three sources of
 * failure, none of which may throw:
 * - yazl reports a refused open and a file that shrank since planning as an
 *   'error' on the ZipFile, a plain EventEmitter, NOT on outputStream;
 * - yazl pipes an entry's stream without listening for its errors (a read
 *   error);
 * - the client leaving or stalling, which streamBody turns into `release`.
 * The first two are forwarded into outputStream, which fails the pipeline.
 * Unheard, either would be an uncaught exception and restart the wrapper
 * and every terminal session with it. Keep both listeners, and the final
 * catch on the opener's promise.
 *
 * `release` cannot stop yazl by destroying outputStream: yazl would still
 * ask for the next entry. So it sets `aborted`, which the opener checks
 * before and after each open, and destroys the entry being read, which
 * closes its handle.
 */
function sendZipBody(plan, req, res, { openFile, log = console.error, idleMs = IDLE_MS, onSettled = () => {} }) {
    try {
        if (res.destroyed || res.writableEnded) {
            onSettled();
            return;
        }
        res.status(200);
        res.attachment(plan.name);   // also Content-Type: application/zip
        res.set('X-Content-Type-Options', 'nosniff');
    } catch (err) {
        onSettled();
        dropAttachmentHeaders(res);
        sendError(res, err, log);
        return;
    }
    // A zip's length is not known before it is built; a HEAD would build it
    // only to throw it away.
    if (req.method === 'HEAD') {
        onSettled();
        res.end();
        return;
    }

    let aborted = false;
    let reading = null;   // the entry stream being read, if any
    // streamBody runs this once the transfer has settled, on every path.
    const release = () => {
        aborted = true;
        if (reading) reading.destroy();
        onSettled();
    };

    // Resolves to the entry's stream, or null once the download is gone (the
    // handle closed). A grown file is cut at its planned size, so a live log
    // can still be zipped and the zip stays under the cap; a shrunk one
    // fails yazl's size check, and so the download. An empty file is opened
    // too, so one that has gone since planning still fails the zip.
    async function openEntry(file, fail) {
        const { handle } = await openFile(file.full);
        if (aborted || file.size === 0) {
            await handle.close().catch(() => {});
            return aborted ? null : Readable.from([], { objectMode: false });
        }
        let stream;
        try {
            stream = handle.createReadStream({ start: 0, end: file.size - 1 });
        } catch (err) {
            await handle.close().catch(() => {});
            throw err;
        }
        stream.on('error', fail);
        reading = stream;
        stream.once('close', () => {
            if (reading === stream) reading = null;
        });
        return stream;
    }

    streamBody(res, {
        makeSource: () => {
            const zip = new yazl.ZipFile();
            // The entry being added, named in the log: "the zip failed" alone
            // does not say which file changed or could not be read. Entries
            // go one at a time, and yazl stops at the first error, so the
            // last one asked for is the one that failed. JSON-quoted, so a
            // name cannot forge a log line.
            let current = null;
            const fail = (err) => {
                const message = (err && err.message) || String(err);
                zip.outputStream.destroy(new Error(current === null ? message : `${JSON.stringify(current)}: ${message}`));
            };
            zip.on('error', fail);
            for (const file of plan.files) {
                const options = { mtime: file.mtime, mode: file.mode, size: file.size, compress: !STORED.test(file.name) };
                zip.addReadStreamLazy(file.name, options, (callback) => {
                    // Only saves an open: the check after the open, which
                    // the tests cover, is what keeps a gone client's
                    // descriptor from leaking.
                    if (aborted) return;
                    current = file.name;
                    openEntry(file, fail)
                        .then((stream) => {
                            if (stream) callback(null, stream);
                        }, (err) => {
                            if (!aborted) callback(err);   // yazl emits it as 'error'
                        })
                        .catch(fail);
                });
            }
            zip.end();
            return zip.outputStream;
        },
        release,
        label: plan.name,
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
        // Every entry name starts with it, so it alone can trip the checks
        // yazl makes on a whole name (validateMetadataPath): a leading drive
        // letter ("C:backup") is refused as absolute, and would fail the
        // download after its preflight had passed. A leading '/', a '..'
        // component and an empty name cannot come out of the walk.
        const top = zipSafe(relative === '' ? path.basename(path.resolve(api.root)) : path.basename(real))
            .replace(/^([a-zA-Z]):/, '$1_');
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
                    const name = `${top}/${zipSafe(path.relative(real, full))}`;
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

    /**
     * Stream a planned zip. Never throws: a failure before the first byte is
     * a JSON error, one after it an aborted response. `onSettled` runs once
     * the zip is over, however it ended (it may run more than once; the
     * caller makes it idempotent).
     */
    async function sendZip(plan, req, res, log = console.error, onSettled = () => {}) {
        try {
            if (beforeStream) await beforeStream(plan);
        } catch (err) {
            onSettled();
            sendError(res, err, log);
            return;
        }
        sendZipBody(plan, req, res, { openFile: api.openFile, log, idleMs, onSettled });
    }

    return {
        openForDownload,
        sendFile: (opened, req, res, log) => sendAttachment(opened, req, res, { log, idleMs }),
        planZip,
        sendZip,
    };
}

/**
 * Express router for the downloads. Mounted by server.js at /api/files,
 * beside createFilesRouter, before the terminal proxy and static files.
 *
 * GET, read-only, no CORS headers: like the other Files GETs, another site
 * can start one but cannot read the answer. Every failure before the first
 * byte is a JSON error; after it, the response is aborted and logged.
 *
 * At most `maxZips` zips run at once, counted from the request until the
 * transfer settles: each walks a tree and deflates up to 200 MB, and on a
 * Raspberry Pi a few at once would starve the terminal. The rate limiter
 * bounds how often they start; this bounds how many run together.
 */
function createDownloadRouter({ downloads, fileLimiter, zipLimiter, maxZips = MAX_CONCURRENT_ZIPS, log = console.error }) {
    const router = express.Router();
    let zipsInFlight = 0;

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

    // protected=1 is not read here: zips never hold protected files.
    router.get('/download-zip', zipLimiter, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (zipsInFlight >= maxZips) {
            return res.status(429).json({
                error: `${maxZips} zips are already being prepared or sent. Try again when one has finished.`,
            });
        }
        zipsInFlight++;
        let settled = false;
        const settle = () => {
            if (settled) return;
            settled = true;
            zipsInFlight--;
        };
        let plan;
        try {
            plan = await downloads.planZip(req.query.path);
        } catch (err) {
            settle();
            return sendError(res, err, log);
        }
        // check=1 is the UI's preflight: the same plan, answered as JSON, so
        // a refusal reaches the sidebar as a message before the browser is
        // handed a download that could only fail silently.
        if (req.query.check === '1') {
            settle();
            return res.json({ name: plan.name, files: plan.files.length, bytes: plan.bytes });
        }
        try {
            await downloads.sendZip(plan, req, res, log, settle);
        } catch (err) {
            settle();
            sendError(res, err, log);   // destroys the response if it had begun
        }
    });

    return router;
}

module.exports = {
    createDownloads,
    createDownloadRouter,
    sendAttachment,
    streamBody,
    MAX_ZIP_BYTES,
    MAX_CONCURRENT_ZIPS,
};
