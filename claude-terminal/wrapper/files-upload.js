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
const path = require('node:path');
const { classifyRelative, inside, FilesError } = require('./files-api');

const MB = 1024 * 1024;
// upload_max_mb's default, and what an unusable UPLOAD_MAX_MB falls back to:
// bashio returns "" for every option when the Supervisor is unreachable.
const DEFAULT_MAX_MB = 25;
// The inbox, relative to the root. run.sh sweeps its top level at startup
// (upload_retention_days); a folder chosen with "Upload here" is never swept.
const INBOX = 'uploads';
// Bytes of a sanitised name, extension included. Under the 255 of ext4 with
// room for a " (999)" suffix; a `.ctp-upload-<16 hex>.part` part is 33.
const MAX_NAME_BYTES = 200;
// An extension longer than this is not kept whole when a name is cut short.
const MAX_EXT_BYTES = 20;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;

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
 * path segment, without control characters, without any run of dots and
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

/**
 * How long a request may take to arrive whole, for server.requestTimeout:
 * 30 minutes, or longer when the cap is big enough that a file at the cap
 * would not fit through a 128 kbit/s link in that time (Node answers 408 to
 * a request still arriving at the timeout).
 */
function uploadRequestTimeoutMs(maxBytes) {
    return Math.max(MIN_REQUEST_TIMEOUT_MS, Math.ceil(maxBytes / SLOWEST_LINK_BYTES_PER_S) * 1000);
}

/** `name (n).ext`: the suffix goes before the last extension. */
function withSuffix(name, n) {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

async function lstatOrNull(p) {
    try {
        return await fsp.lstat(p);
    } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
        throw err;
    }
}

const sizeText = (bytes) => `${(bytes / MB).toFixed(1)} MB`;

/**
 * Uploads over a files-api instance (for locate() and its root): for now the
 * checks every upload gets before its first byte (plan). `now` is injectable
 * for the fallback name.
 */
function createUploads({
    api,
    maxBytes = DEFAULT_MAX_MB * MB,
    now = Date.now,
} = {}) {
    const maxMb = Math.round(maxBytes / MB);
    const limitText = `the ${maxMb} MB upload limit (the add-on's upload_max_mb option)`;
    const tooBig = (bytes) => new FilesError(413, bytes === undefined
        ? `This file is over ${limitText}.`
        : `This file is ${sizeText(bytes)}, over ${limitText}.`);
    const notPlainFolder = (display) => new FilesError(409,
        `${display} is not a plain folder (it is a symlink or a file), so nothing is uploaded into it.`,
        { reason: 'not-plain-folder' });
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

    return { plan, tooBig, maxBytes };
}

module.exports = {
    createUploads,
    sanitizeUploadName,
    withSuffix,
    uploadMaxBytes,
    uploadRequestTimeoutMs,
    DEFAULT_MAX_MB,
    INBOX,
};
