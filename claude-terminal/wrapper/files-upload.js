'use strict';

/**
 * Uploads for the Files sidebar: one file per request, into /config.
 *
 * A module of its own, like files-download.js: files-api.js is the read-only
 * browser and stays free of writes. What decides WHERE a path lands stays
 * there and is called from here - locate(), the root's realpath mapping, and
 * classifyRelative(), the tiers - so the two cannot drift apart.
 *
 * The request is the file's raw bytes (not multipart), with `name`, `dest`
 * (absent for the inbox) and `onConflict` in the query string, so every check
 * runs before a byte is written. The bytes go to `.ctp-upload-<hex>.part` in
 * the destination folder, which files-api's PARTIAL_FILE keeps out of every
 * listing and zip, and are renamed into place once complete. Every part is
 * listed in a record in /data while it exists, so a part left by a crash is
 * deleted on the next start (upload-parts.js).
 *
 * `check=1` asks the same questions with no body: the UI calls it first, so a
 * refusal (a name collision, the size cap, a protected folder) reaches it as
 * a JSON answer. An answer sent before a big body has been read is often lost
 * behind a proxy such as HA ingress; the browser reports a network error.
 *
 * No listener and no side effects at require time, so tests import it
 * directly (same reason as http-guards.js).
 */

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { classifyRelative, inside, sendError, FilesError } = require('./files-api');
const { createCrossSiteGuard } = require('./http-guards');

const MB = 1024 * 1024;
// upload_max_mb's default, and what an unusable UPLOAD_MAX_MB falls back to.
// Defence in depth: the schema allows only 1 to 1024, and run.sh stops at
// startup rather than read "" when the Supervisor is unreachable (bashio's
// inherit_errexit), but the wrapper can also be started without either.
const DEFAULT_MAX_MB = 25;
// The inbox, relative to the root. run.sh sweeps its top level at startup
// (upload_retention_days); a folder chosen with "Upload here" is never swept.
const INBOX = 'uploads';
// A client that stops sending must not hold a descriptor and a part forever:
// the server has no socket timeout of its own. Same value as downloads.
const IDLE_MS = 60 * 1000;
// Bytes of a sanitised name, extension included. Under the 255 of ext4 with
// room for a " (999)" suffix; a `.ctp-upload-<16 hex>.part` part is 33.
const MAX_NAME_BYTES = 200;
// An extension longer than this is not kept whole when a name is cut short.
const MAX_EXT_BYTES = 20;
// "name (1).ext" … "name (999).ext", then a 409.
const MAX_SUFFIX = 999;
// link() refusals that mean "no hard links on this filesystem", where a
// rename after a fresh lstat takes over (see placeNew).
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK']);
// Failures that are the file system's, not a bug: answered as what they are
// (the global answer would be "Internal error"), and still logged.
const DISK_FULL_TEXT = 'The disk is full, so the file was not saved. Free some space and try again.';
const FS_REFUSALS = new Map([
    ['ENOSPC', [507, DISK_FULL_TEXT]],
    ['EDQUOT', [507, DISK_FULL_TEXT]],
    ['EROFS', [403, 'The file system is read-only, so the file was not saved.']],
    ['EACCES', [403, 'The add-on is not allowed to write there, so the file was not saved.']],
    ['ENAMETOOLONG', [400, 'The name is too long for the file system there, so the file was not saved. Try a shorter name.']],
]);
// Control characters, and the invisible marks that reorder or hide text:
// the bidirectional marks, embeddings, overrides and isolates (U+200E-200F,
// U+202A-202E, U+2066-2069), with which `photo<U+202E>gpj.exe` reads as
// `photoexe.jpg`, and the byte-order mark U+FEFF.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * The upload cap in bytes, from UPLOAD_MAX_MB (whole megabytes). Anything but
 * a positive whole number - empty, "null", "1.5", "0" - is the default.
 */
function uploadMaxBytes(value) {
    const s = String(value ?? '').trim();
    return /^[1-9][0-9]{0,6}$/.test(s) ? Number(s) * MB : DEFAULT_MAX_MB * MB;
}

// The longest prefix of `s` that fits in `max` UTF-8 bytes, cut between code
// points, never inside one.
function cutToBytes(s, max) {
    let out = '';
    for (const ch of s) {
        if (Buffer.byteLength(out + ch) > max) break;
        out += ch;
    }
    return out;
}

/**
 * The name an upload is saved under, from the client's file name: its last
 * path segment, without control characters or bidirectional marks (CONTROL),
 * without any run of dots and
 * spaces at its start (so `. .env` cannot come back as `.env`, nor anything
 * as the wrapper's own `.ctp-upload-*.part`) or spaces at its end, cut to
 * MAX_NAME_BYTES keeping a short extension. `upload-<epoch
 * ms>` when nothing usable is left. Secret-shaped names (`server.key`) are
 * allowed: putting a certificate into /config is a common Home Assistant
 * task, and the listing marks the file protected once it is there.
 */
function sanitizeUploadName(raw, { now = Date.now } = {}) {
    const segments = String(raw ?? '')
        .replace(CONTROL, '')
        .split(/[\\/]/)
        .map((s) => s.trim())
        .filter((s) => s !== '' && s !== '.' && s !== '..');
    let name = (segments.pop() || '').replace(/^[.\s]+/, '').trimEnd();
    if (Buffer.byteLength(name) > MAX_NAME_BYTES) {
        const dot = name.lastIndexOf('.');
        const ext = dot > 0 && Buffer.byteLength(name.slice(dot)) <= MAX_EXT_BYTES ? name.slice(dot) : '';
        const stem = cutToBytes(name.slice(0, name.length - ext.length), MAX_NAME_BYTES - Buffer.byteLength(ext));
        name = stem.trimEnd() + ext;
    }
    return name || `upload-${now()}`;
}

// The slowest link an upload at the cap must still fit through, in bytes per
// second (128 kbit/s), and the least time any upload gets.
const SLOWEST_LINK_BYTES_PER_S = 16000;
const MIN_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
// And the most: past about 660 MB a bigger cap no longer stretches it, so
// no request (an upload or anything else; the timeout is server-wide) can
// hold a connection open for days.
const MAX_REQUEST_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/**
 * How long a request may take to arrive whole, for server.requestTimeout:
 * 30 minutes, or longer when the cap is big enough that a file at the cap
 * would not fit through a 128 kbit/s link in that time (Node answers 408 to
 * a request still arriving at the timeout), but never over 12 hours.
 */
function uploadRequestTimeoutMs(maxBytes) {
    const atSlowestLink = Math.ceil(maxBytes / SLOWEST_LINK_BYTES_PER_S) * 1000;
    return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(MIN_REQUEST_TIMEOUT_MS, atSlowestLink));
}

/** `name (n).ext`: the suffix goes before the last extension. */
function withSuffix(name, n) {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

async function lstatOrNull(p, options) {
    try {
        return await fsp.lstat(p, options);
    } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
        throw err;
    }
}

// The client went away (or stalled, which is logged where it is seen): there
// is no one to answer, so the route sends nothing and logs nothing more.
class ClientGone extends Error {}
// A write to the part failed: the disk's fault, never the client's.
class DiskError extends Error {
    constructor(cause) {
        super(cause.message);
        this.code = cause.code;
    }
}

const sizeText = (bytes) => `${(bytes / MB).toFixed(1)} MB`;

/**
 * Uploads over a files-api instance (for locate() and its root). `record` is
 * upload-parts.js's createPartRecord. The rest are test seams: `fsOps` the
 * link and rename that put a finished part in place and the realpath of the
 * last check before them (each defaults on its own), `openPart` its open
 * (a FileHandle, or anything with its stat - which must honour
 * { bigint: true } - chmod, write, datasync, truncate and close),
 * `partName` its name, `onPlanned` a hook between the checks and
 * the part's open, and `beforeCommit` one between the last byte and the
 * rename.
 */
function createUploads({
    api,
    record,
    maxBytes = DEFAULT_MAX_MB * MB,
    idleMs = IDLE_MS,
    now = Date.now,
    partName = () => `.ctp-upload-${crypto.randomBytes(8).toString('hex')}.part`,
    // O_EXCL: never a file that was there, and (with O_CREAT) never through
    // a link at the part's name. O_NOFOLLOW says the latter again.
    openPart = (p) => fsp.open(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0), 0o644),
    fsOps: ops = {},
    onPlanned = null,
    beforeCommit = null,
} = {}) {
    const fsOps = { link: fsp.link, rename: fsp.rename, realpath: fsp.realpath, ...ops };
    const maxMb = Math.round(maxBytes / MB);
    const limitText = `the ${maxMb} MB upload limit (the add-on's upload_max_mb option)`;
    // A size that rounds to the limit or under ("1.0 MB, over the 1 MB
    // limit") would read as no excess at all: then it is just "over".
    const tooBig = (bytes) => new FilesError(413, bytes === undefined || Number((bytes / MB).toFixed(1)) <= maxMb
        ? `This file is over ${limitText}.`
        : `This file is ${sizeText(bytes)}, over ${limitText}.`);
    const notPlainFolder = (display) => new FilesError(409,
        `${display} is not a plain folder (it is a symlink or a file), so nothing is uploaded into it.`,
        { reason: 'not-plain-folder' });
    const partChanged = (display) => new FilesError(409,
        `The upload's temporary file in ${display} was moved or replaced during the upload, so nothing was saved.`,
        { reason: 'changed' });
    const exists = (name, display, st) => (st && !st.isFile()
        ? new FilesError(409, `${name} already exists in ${display} and is not a regular file, so it cannot be replaced.`,
            { reason: 'exists', replaceable: false })
        : new FilesError(409, `${name} already exists in ${display}.`, { reason: 'exists', replaceable: true }));
    const display = (relative) => path.join(path.resolve(api.root), relative);

    // Where an upload goes: a real folder (not a symlink, nor below one)
    // inside the root, not protected and not under deps. The inbox is made
    // on first use (`create`; a check=1 only asks).
    async function destination(requested, { inbox, create }) {
        const at = await api.locate(requested);   // 400, 404 (outside, .git), 503
        const shown = display(at.relative);
        if (at.kind === 'sensitive') {
            throw new FilesError(403, `${shown} may hold secrets, so nothing is uploaded into it.`);
        }
        if (at.relative.split(path.sep)[0].toLowerCase() === 'deps') {
            throw new FilesError(403, `${shown} holds the Python packages Home Assistant installs, so nothing is uploaded into it.`);
        }
        let st = await lstatOrNull(at.asked);
        if (!st && inbox) {
            if (!create) return { dir: at.asked, relative: at.relative, display: shown };
            try {
                await fsp.mkdir(at.asked, { mode: 0o755 });
            } catch (err) {
                if (err.code !== 'EEXIST') throw err;
            }
            st = await lstatOrNull(at.asked);
        }
        if (!st) throw new FilesError(404, `${shown} does not exist.`);
        if (st.isSymbolicLink() || !st.isDirectory()) throw notPlainFolder(shown);
        let real;
        try {
            real = await fsp.realpath(at.asked);
        } catch {
            throw new FilesError(404, `${shown} does not exist.`);
        }
        if (!inside(at.root, real)) throw new FilesError(404, 'Not found or not allowed');
        // Below a symlinked folder: the lstat above saw a real folder, but
        // the path to it goes through a link.
        if (real !== at.asked) throw notPlainFolder(shown);
        return { dir: at.asked, relative: at.relative, display: shown };
    }

    /**
     * Every check an upload gets before its first byte, for a request's
     * { name, dest, onConflict }: the plan receive() follows, or a
     * FilesError. Shared by check=1 and the upload itself.
     */
    async function plan({ name, dest, onConflict }, { create = true } = {}) {
        if (typeof name !== 'string' || name === '') throw new FilesError(400, 'Missing or invalid file name');
        if (dest !== undefined && typeof dest !== 'string') throw new FilesError(400, 'Invalid path');
        if (onConflict !== undefined && onConflict !== 'replace' && onConflict !== 'keep-both') {
            throw new FilesError(400, 'onConflict must be replace or keep-both');
        }
        const inbox = dest === undefined;
        // The inbox only ever numbers a taken name (the spec, and what the
        // UI says). Refused rather than ignored, so a client that asked to
        // replace is never told it succeeded when it did not.
        if (inbox && onConflict === 'replace') {
            throw new FilesError(400, 'The inbox never replaces a file: a taken name gets a number. Choose a folder to replace a file in it.');
        }
        const folder = await destination(inbox ? INBOX : dest, { inbox, create });
        const safe = sanitizeUploadName(name, { now });
        if (classifyRelative(path.join(folder.relative, safe)) === 'hidden') {
            throw new FilesError(400, `${safe} ends in .git, a name the Files sidebar never shows, so it cannot be uploaded.`);
        }
        const existing = await lstatOrNull(path.join(folder.dir, safe));
        if (existing && !inbox && onConflict === undefined) throw exists(safe, folder.display, existing);
        if (existing && onConflict === 'replace' && !existing.isFile()) throw exists(safe, folder.display, existing);
        return { ...folder, inbox, name: safe, onConflict, exists: Boolean(existing) };
    }

    // The request body into the open part. Iterated with destroyOnReturn
    // false, so stopping early (over the cap, a failed write) leaves the
    // request alive for the 413 or 507 to go out on.
    async function writeBody(req, handle, label, log) {
        let stalled = false;
        req.setTimeout(idleMs, () => {
            stalled = true;
            req.destroy(new Error('client stalled'));
        });
        let size = 0;
        try {
            for await (const chunk of req.iterator({ destroyOnReturn: false })) {
                size += chunk.length;
                if (size > maxBytes) throw tooBig();
                try {
                    let at = 0;
                    while (at < chunk.length) {
                        const { bytesWritten } = await handle.write(chunk, at, chunk.length - at);
                        at += bytesWritten;
                    }
                } catch (err) {
                    throw new DiskError(err);
                }
            }
        } catch (err) {
            if (err instanceof FilesError || err instanceof DiskError) throw err;
            // Anything else came from reading the request: the client left.
            if (stalled) log(`Upload of ${JSON.stringify(label)} cut off: client stalled for ${idleMs} ms`);
            throw new ClientGone();
        } finally {
            req.setTimeout(0);
        }
        // A request whose client left before sending it all can end without
        // an error; its bytes are not the file.
        if (!req.complete) throw new ClientGone();
        return size;
    }

    // Put a finished part at `target` unless something is there already:
    // link() refuses an existing name atomically, which a check followed by
    // a rename cannot. Where hard links are not supported, a fresh lstat
    // and a rename are the fallback. False when the name is taken.
    async function placeNew(part, target) {
        try {
            await fsOps.link(part, target);
            return true;
        } catch (err) {
            if (err.code === 'EEXIST') return false;
            if (!NO_HARD_LINKS.has(err.code)) throw err;
        }
        if (await lstatOrNull(target)) return false;
        await fsOps.rename(part, target);
        return true;
    }

    // The folder may have gone, or been swapped for a link, while the body
    // came in.
    async function recheck(planned) {
        const removed = () => new FilesError(404, `${planned.display} was removed during the upload.`);
        const st = await lstatOrNull(planned.dir);
        if (!st) throw removed();
        if (st.isSymbolicLink() || !st.isDirectory()) throw notPlainFolder(planned.display);
        let real;
        try {
            real = await fsOps.realpath(planned.dir);
        } catch (err) {
            // gone between the lstat and here
            if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw removed();
            throw err;
        }
        if (real !== planned.dir) throw notPlainFolder(planned.display);
    }

    // Whether `part` still names the file this upload created (`id`: its
    // device and inode, from the open descriptor). Everything done to the
    // part by its path - the link or rename that puts it in place, the
    // unlink after - asks this first, and the name it was put at is asked
    // after. O_NOFOLLOW guards only the last component of a path: a folder
    // swapped for a link just before the open puts the part outside the
    // folder that was checked, and a part swapped for a link later would
    // make the path act on the link's target. Compared as BigInts on both
    // sides: an inode number can be over 2^53, where a Number rounds it.
    async function samePart(part, id) {
        const st = await lstatOrNull(part, { bigint: true });
        return Boolean(st && st.dev === id.dev && st.ino === id.ino);
    }
    async function mustBeOurs(part, id, planned) {
        if (!(await samePart(part, id))) throw partChanged(planned.display);
    }
    // After the link or rename: the part's name can be given to another
    // file between the last mustBeOurs and that call, which then puts the
    // other file in place. Nothing this upload wrote is there, so it is
    // not a success. What landed is not this upload's to remove: logged,
    // and left.
    async function mustHavePlaced(target, id, planned, log) {
        if (await samePart(target, id)) return;
        log(`Upload not saved: ${target} is not the uploaded file (its temporary file was replaced as it was put in place); left as it is`);
        throw partChanged(planned.display);
    }

    // `handle` is the part's open descriptor, still open: Replace sets the
    // mode through it, never through the path.
    async function commit(part, planned, handle, id, log) {
        await recheck(planned);
        const target = path.join(planned.dir, planned.name);
        if (planned.onConflict === 'replace') {
            const old = await lstatOrNull(target);
            if (old && !old.isFile()) throw exists(planned.name, planned.display, old);
            // The old file's permissions: a 0600 key stays private, an
            // executable script stays executable. Never setuid, setgid or
            // sticky: an upload must not inherit those.
            if (old) await handle.chmod(old.mode & 0o777);
            await mustBeOurs(part, id, planned);
            await fsOps.rename(part, target);   // swaps the whole file in at once
            await mustHavePlaced(target, id, planned, log);
            return { path: target, name: planned.name, replaced: Boolean(old) };
        }
        await mustBeOurs(part, id, planned);
        const suffix = planned.inbox || planned.onConflict === 'keep-both';
        for (let n = 0; n <= (suffix ? MAX_SUFFIX : 0); n++) {
            const name = n === 0 ? planned.name : withSuffix(planned.name, n);
            const candidate = path.join(planned.dir, name);
            if (await placeNew(part, candidate)) {
                await mustHavePlaced(candidate, id, planned, log);
                return { path: candidate, name, replaced: false };
            }
        }
        if (!suffix) throw exists(planned.name, planned.display, await lstatOrNull(target));
        throw new FilesError(409, `Too many files named like ${planned.name} in ${planned.display}.`,
            { reason: 'exists', replaceable: false });
    }

    /**
     * Stream the request into a part beside the destination, then put it in
     * place: { path, name, size, dir, replaced, inbox }. On every other way
     * out - the client gone or stalled, over the cap, a failed write or
     * rename, the folder gone, moved or swapped - the part is emptied and
     * deleted and dropped from the record, and nothing is left at the
     * destination.
     */
    async function receive(req, planned, { log = console.error } = {}) {
        if (onPlanned) await onPlanned(planned);
        const part = path.join(planned.dir, partName());
        await record.add(part);
        let handle = null;
        // The part this upload created (O_EXCL: never a file that was
        // there before), by device and inode. Null until then, and only
        // that file is ever emptied or deleted.
        let id = null;
        let placed = null;
        try {
            handle = await openPart(part);
            const opened = await handle.stat({ bigint: true });
            id = { dev: opened.dev, ino: opened.ino };
            // Made in the folder plan() checked, and still there? Before
            // the first byte, so none is ever written anywhere else.
            await recheck(planned);
            await mustBeOurs(part, id, planned);
            await handle.chmod(0o644);   // 0644 whatever the umask
            const size = await writeBody(req, handle, planned.name, log);
            await handle.datasync();     // on disk before it replaces anything
            if (beforeCommit) await beforeCommit(part, planned);
            try {
                placed = await commit(part, planned, handle, id, log);
            } catch (err) {
                // A link or rename that finds no part, or no folder, at
                // the path: the folder was moved or swapped for a link
                // since its last check. Changed, not a fault.
                if (err.code !== 'ENOENT') throw err;
                log(`Upload not saved: ${err.message}`);
                throw partChanged(planned.display);
            }
            return { ...placed, size, dir: planned.display, inbox: planned.inbox };
        } finally {
            if (handle) {
                // Not put in place: emptied through the descriptor, which
                // reaches the file wherever it is now. A folder moved
                // mid-upload takes the part along, out of the unlink's reach.
                if (!placed) await handle.truncate(0).catch(() => {});
                await handle.close().catch(() => {});
            }
            // After a link() the part is a second name for the file; after a
            // rename it is gone already; after a failure it is the emptied
            // file. Removed by its path only while that path still names it.
            if (id && await samePart(part, id).catch(() => false)) await fsp.unlink(part).catch(() => {});
            await record.remove(part).catch((err) => log(`Upload parts: record not updated: ${err.message}`));
        }
    }

    return { plan, receive, tooBig, maxBytes };
}

// A failure as the answer the UI shows: a full disk is a 507 that says so,
// and the other FS_REFUSALS likewise.
function asFilesError(err, log) {
    if (err instanceof FilesError) return err;
    const refusal = err && FS_REFUSALS.get(err.code);
    if (!refusal) return err;   // sendError logs it and answers a 500
    log(`Upload not saved: ${err.message}`);
    return new FilesError(refusal[0], refusal[1]);
}

/**
 * Express router for uploads. Mounted by server.js at /api/files beside the
 * other Files routers, before the terminal proxy and static files.
 *
 * POST, so the app-wide origin guard (createOriginGuard) has already run.
 * The cross-site guard runs too: the origin guard passes a request with no
 * Origin and no Referer, and an ingress one whatever its Origin, while
 * Sec-Fetch-Site still says whether the browser was on another site. Both
 * before the limiters, so a refused request costs no one's budget.
 *
 * check=1 (no body) goes to `checkLimiter`, the upload itself to
 * `uploadLimiter`, so asking first does not halve the uploads a minute.
 * Every failure is a JSON answer from here, never the global error handler
 * (which words everything as an image upload error). A refusal sent before
 * the body was read closes the connection rather than read the rest.
 */
function createUploadRouter({ uploads, uploadLimiter, checkLimiter, log = console.error }) {
    const router = express.Router();
    const sameSite = createCrossSiteGuard({
        log,
        message: 'Uploads cannot be started from another site. Use the Files sidebar.',
    });
    const limiter = (req, res, next) => (req.query.check === '1' ? checkLimiter : uploadLimiter)(req, res, next);

    router.post('/upload', sameSite, limiter, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const check = req.query.check === '1';
        try {
            const query = { name: req.query.name, dest: req.query.dest, onConflict: req.query.onConflict };
            if (check) {
                if (typeof req.query.size !== 'string' || !/^[0-9]{1,15}$/.test(req.query.size)) {
                    throw new FilesError(400, 'size must be the file size in bytes');
                }
                const size = Number(req.query.size);
                if (size > uploads.maxBytes) throw uploads.tooBig(size);
                const planned = await uploads.plan(query, { create: false });
                return res.json({ name: planned.name, dir: planned.display, inbox: planned.inbox, exists: planned.exists });
            }
            const declared = Number(req.get('content-length'));
            if (declared > uploads.maxBytes) throw uploads.tooBig(declared);
            const planned = await uploads.plan(query);
            res.json(await uploads.receive(req, planned, { log }));
        } catch (err) {
            // The client is gone (a ClientGone, or a stall cut off), or
            // the answer went out already: there is no one to tell.
            if (res.writableEnded || !res.socket || res.socket.destroyed) return;
            if (!check && !req.complete) res.set('Connection', 'close');
            sendError(res, asFilesError(err, log), log);
        }
    });

    return router;
}

module.exports = {
    createUploads,
    createUploadRouter,
    sanitizeUploadName,
    withSuffix,
    uploadMaxBytes,
    uploadRequestTimeoutMs,
    DEFAULT_MAX_MB,
    INBOX,
};
