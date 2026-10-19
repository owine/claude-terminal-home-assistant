'use strict';

/**
 * Read-only file browser behind the Files sidebar: list a folder of /config,
 * preview a file, list recently changed files, and run Home Assistant's
 * configuration check.
 *
 * Ported from ESJavadex/claude-code-ha 2.2.0 (files-api.js) and the Files half
 * of its 2.3.1 hardening, reworked for this wrapper:
 *
 * - Async fs throughout. The wrapper is one process proxying every terminal
 *   byte; a synchronous walk of a big /config would freeze open sessions.
 * - Every read is bounded: entries per folder, bytes per preview, entries and
 *   wall-clock time per recent-changes walk.
 * - Confinement is by realpath against the realpath of the root, checked on
 *   both the requested and the resolved path, so `..`, absolute paths and
 *   symlinks all land on the same check.
 *
 * Nothing here writes to disk: uploads are files-upload.js, which asks this
 * module where a path lands (locate) and which names are partial files. The
 * module has no listener and no side effects at require time, so tests import
 * it directly (same reason as http-guards.js).
 */

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const express = require('express');

const DEFAULT_ROOT = '/config';

// A folder listing reads at most this many entries; the rest are reported as
// truncated. A directory of 100k files must not become a 100k-stat request.
const MAX_ENTRIES = 1000;
// Bytes of a file the preview returns. Larger files are cut, and say so.
const MAX_PREVIEW_BYTES = 256 * 1024;
// Bytes inspected for binary content (a NUL byte means binary).
const BINARY_SNIFF_BYTES = 8000;
// Recent changes: result size, folder depth, entries visited and wall clock.
// Whichever runs out first ends the walk; the response says it was cut short.
// The zip walk in files-download.js shares MAX_RECENT_DEPTH, MAX_RECENT_VISITS
// and RECENT_TIME_BUDGET_MS.
const MAX_RECENT = 100;
const MAX_RECENT_DEPTH = 8;
const MAX_RECENT_VISITS = 20000;
const RECENT_TIME_BUDGET_MS = 3000;
const MAX_RECENT_HOURS = 24 * 30;
// Longest path string accepted from a request.
const MAX_PATH_LENGTH = 4096;

// ha core check
const HA_CHECK_TIMEOUT_MS = 180000;
const HA_CHECK_MAX_BUFFER = 1024 * 1024;
const HA_CHECK_MAX_MESSAGE = 4000;

// Never listed, previewed, downloaded or zipped, never in recent changes,
// whatever protected=1 says: .git/config can hold access tokens in remote
// URLs (upstream 2.3.1).
//
// secrets.yaml is deliberately NOT here. This follows Studio Code Server
// (hassio-addons/addon-vscode), whose default files.exclude hides .git and
// leaves secrets.yaml an ordinary file: it is a file the user edits by hand,
// and the terminal next to this sidebar can read it anyway.
//
// A bare repository (`homeassistant.git/`) holds the same config, so any name
// ending in `.git` is hidden too. A plain file so named is hidden with it;
// that is rare enough not to be worth telling the two apart.
const HIDDEN_NAME = /\.git$/i;

// An upload being written (files-upload.js streams each one to
// `.ctp-upload-<hex>.part` beside its destination, then renames it): left out
// of listings, recent changes and zips (walkEntryType), since it is about to
// be renamed or deleted. Only the wrapper's own prefix: a user's `backup.part`
// is an ordinary file and stays visible.
const PARTIAL_FILE = /^\.ctp-upload-.*\.part$/i;

// Listed (so the tree is honest about what is there), but previewed or
// downloaded only with protected=1 ("Show protected files"), never zipped,
// and left out of recent changes. Any path segment matching one of these
// covers everything under it.
//   .storage: HA's auth store, refresh tokens and integration credentials.
//   .cloud: the Nabu Casa login.
//   .ssh, .gnupg: keys.
const SENSITIVE_DIRS = new Set(['.storage', '.cloud', '.ssh', '.gnupg']);

// Same, but only directly under the root.
//   claude-config: a legacy home of Claude Code's own login; run.sh migrates
//   from /config/claude-config/.credentials.json (migrate_legacy_auth_files).
const SENSITIVE_ROOT_DIRS = new Set(['claude-config']);

// Secret-shaped file names, wherever they sit. Upstream's 2.3.1 list (keys,
// .env, .git-credentials) plus the credential files a read-only viewer could
// otherwise show: Claude Code's own login files, the git/npm/pip/netrc
// credential stores, and private keys that do not use a .key/.pem suffix.
const SENSITIVE_FILE = new RegExp([
    '^\\.env(\\..+)?$',
    '^\\.envrc$',
    '^service_account\\.json$',   // Google Assistant's private key
    '^\\.git-credentials$',
    '^\\.gitconfig$',
    '^\\.netrc$',
    '^\\.npmrc$',
    '^\\.pypirc$',
    '^\\.credentials\\.json$',
    '^\\.claude\\.json$',
    '^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$',
    '\\.(pem|key|p12|pfx)$',
].join('|'), 'i');

// Recent changes leaves out what HA (or a package manager) rewrites by itself,
// so the list shows what a person or Claude edited. Build and dependency trees
// are skipped too: the walk has an entry and time budget, and one ESPHome
// build folder or virtualenv could spend all of it before reaching a single
// real edit.
const RECENT_SKIP_DIRS = new Set([
    'deps', 'tts', 'backups', '.cache',
    'node_modules', '__pycache__', '.venv', 'venv', '.pio', '.pioenvs',
]);
// Skipped only under the named parent: `build` is an ordinary name elsewhere.
const RECENT_SKIP_NESTED = [['.esphome', 'build']];
const RECENT_SKIP_FILE = /\.(db|db-shm|db-wal|sqlite|sqlite3)$|\.log(\.\d+|\.fault|\.old)?$/i;

const lower = (name) => name.toLowerCase();

function isHiddenName(name) {
    return HIDDEN_NAME.test(name);
}

/**
 * Classify a path relative to the root: 'hidden' (never shown), 'sensitive'
 * (listed, but opened for preview or download only with protected=1, and
 * never zipped) or 'ok'. Case-insensitive, so a case-insensitive
 * filesystem cannot be used to sidestep it.
 */
function classifyRelative(relative) {
    if (relative === '') return 'ok';
    const segments = relative.split(path.sep);
    if (segments.some(isHiddenName)) return 'hidden';
    if (SENSITIVE_ROOT_DIRS.has(lower(segments[0]))) return 'sensitive';
    if (segments.slice(0, -1).some((s) => SENSITIVE_DIRS.has(lower(s)))) return 'sensitive';
    const last = segments[segments.length - 1];
    if (SENSITIVE_DIRS.has(lower(last)) || SENSITIVE_FILE.test(last)) return 'sensitive';
    return 'ok';
}

const inside = (root, p) => p === root || p.startsWith(root + path.sep);

// Linux: /proc/self/fd/N links to the file descriptor N refers to; a file
// deleted since the open reads as "<path> (deleted)", and is judged by its
// path. No /proc, or a non-absolute answer, is "unknown" (null), and
// preview() then relies on its path checks alone.
const DELETED_SUFFIX = ' (deleted)';
async function procFdPath(fd) {
    let target;
    try {
        target = await fsp.readlink(`/proc/self/fd/${fd}`);
    } catch {
        return null;
    }
    if (target.endsWith(DELETED_SUFFIX)) target = target.slice(0, -DELETED_SUFFIX.length);
    return path.isAbsolute(target) ? target : null;
}

// An error the routes turn into a status code and a message for the UI.
// `details` are extra fields for the JSON body beside `error`, for answers
// the UI acts on rather than only shows (an upload's name collision).
class FilesError extends Error {
    constructor(status, message, details = null) {
        super(message);
        this.status = status;
        this.details = details;
    }
}
const notAllowed = () => new FilesError(404, 'Not found or not allowed');
// The sensitive tier's refusal. The UI lifts it with "Show protected files",
// which adds protected=1 to preview and download requests.
const secretRefusal = (action = 'open') => new FilesError(403, `This file may hold secrets. Turn on "Show protected files" to ${action} it.`);

/**
 * Looks binary if the sample holds a NUL byte or is not valid UTF-8. A
 * truncated read may end mid-character, which `stream: true` tolerates.
 */
function looksBinary(buffer, truncated) {
    const sample = buffer.subarray(0, Math.min(buffer.length, BINARY_SNIFF_BYTES));
    if (sample.includes(0)) return true;
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(buffer, { stream: truncated });
        return false;
    } catch {
        return true;
    }
}

/**
 * Run `ha core check`, at most one at a time.
 *
 * Fixed argv through execFile, so no shell and no user input. The ha CLI reads
 * SUPERVISOR_TOKEN from the environment the add-on gives the wrapper.
 * `execFile` is injectable for tests. Never rejects: every outcome, including a
 * missing binary, comes back as `{ ok, message }`.
 */
function createHaCheck({
    execFile = childProcess.execFile,
    command = 'ha',
    timeoutMs = HA_CHECK_TIMEOUT_MS,
} = {}) {
    let running = null;

    function summarize(err, stdout, stderr) {
        let parsed = null;
        try { parsed = JSON.parse(stdout); } catch { /* not JSON */ }
        if (!err && parsed && parsed.result === 'ok') {
            return { ok: true, message: 'Configuration is valid' };
        }
        let message;
        if (err && err.code === 'ENOENT') {
            message = 'The ha command is not available';
        } else if (err && err.killed) {
            message = `The check did not finish within ${Math.round(timeoutMs / 1000)} seconds`;
        } else {
            message = (parsed && typeof parsed.message === 'string' && parsed.message)
                || String(stderr || '').trim()
                || String(stdout || '').trim()
                || (err && err.message)
                || 'Check failed';
        }
        // ha prints coloured text on some paths; the UI shows plain text.
        // eslint-disable-next-line no-control-regex
        message = String(message).replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (message.length > HA_CHECK_MAX_MESSAGE) message = `${message.slice(0, HA_CHECK_MAX_MESSAGE)}…`;
        return { ok: false, message };
    }

    function run() {
        if (running) return null;
        running = new Promise((resolve) => {
            try {
                execFile(command, ['core', 'check', '--raw-json'], {
                    timeout: timeoutMs,
                    maxBuffer: HA_CHECK_MAX_BUFFER,
                    killSignal: 'SIGKILL',
                }, (err, stdout, stderr) => resolve(summarize(err, stdout, stderr)));
            } catch (err) {
                resolve(summarize(err, '', ''));
            }
        }).finally(() => { running = null; });
        return running;
    }

    return {
        /** Resolves to { ok, message }; null when a check is already running. */
        run,
        isRunning: () => running !== null,
    };
}

/**
 * The one visibility rule for a directory entry, shared by the listing, the
 * recent-changes walk and the zip walk (files-download.js), so they cannot
 * disagree. `relative` is the entry's path below the real root.
 *
 * Returns null for an entry that is never shown: hidden, a partial file or
 * folder (PARTIAL_FILE) and, unless `allowSensitive`, a sensitive one.
 * Otherwise 'dir', 'file', 'symlink' or 'other' from the folder listing's own
 * type, which says what the entry itself is, never what a link points at.
 * Walks use only 'dir' and 'file', which is how they never follow a link.
 */
function walkEntryType(relative, dirent, { allowSensitive = false } = {}) {
    const kind = classifyRelative(relative);
    if (kind === 'hidden' || (kind === 'sensitive' && !allowSensitive)) return null;
    if (PARTIAL_FILE.test(dirent.name)) return null;
    if (dirent.isSymbolicLink()) return 'symlink';
    if (dirent.isDirectory()) return 'dir';
    if (dirent.isFile()) return 'file';
    return 'other';
}

/**
 * The read-only file API, confined to `root` (default FILES_ROOT, else
 * /config). `now` is injectable for the recent-changes window.
 */
function createFilesApi({
    root = process.env.FILES_ROOT || DEFAULT_ROOT,
    now = Date.now,
    maxEntries = MAX_ENTRIES,
    maxPreviewBytes = MAX_PREVIEW_BYTES,
    recentTimeBudgetMs = RECENT_TIME_BUDGET_MS,
    // The path an open descriptor refers to, or null when that cannot be
    // known. Injectable for tests on platforms without /proc.
    fdPath = procFdPath,
    // Test seam: runs between resolve() and open() in preview(), so a test
    // can swap a folder for a symlink at exactly the moment that matters.
    onResolved = null,
} = {}) {
    // Resolved on every call rather than once: /config may not be mounted yet
    // when the wrapper starts, and a cached failure would stick until restart.
    async function realRoot() {
        try {
            return await fsp.realpath(root);
        } catch {
            throw new FilesError(503, `${root} is not available`);
        }
    }

    /**
     * Where a requested path (absolute, or relative to the root) lands,
     * without looking at what is there: { asked, relative, kind, root }, the
     * path mapped under the root's realpath, and its tier by that name. Throws
     * 400 for an unusable path, 404 for one outside the root or never shown,
     * and 503 when the root is not available. `asked` is absolute and
     * normalised, but nothing in it is followed: it may run through a
     * symlinked parent, out of the root. A caller that needs it confined
     * must realpath it and compare (`realpath(asked) === asked`).
     * resolve() goes on to follow it; uploads (files-upload.js) lstat it
     * instead, since a destination must not be a symlink at all.
     */
    async function locate(requested) {
        if (requested === undefined || requested === '') requested = '.';
        if (typeof requested !== 'string' || requested.includes('\0') || requested.length > MAX_PATH_LENGTH) {
            throw new FilesError(400, 'Invalid path');
        }
        const rootReal = await realRoot();
        let asked = path.resolve(rootReal, requested);
        // Also accept the root as configured when it is itself a symlink
        // (/config -> /homeassistant), so a path the UI got back still works.
        const rootAsConfigured = path.resolve(root);
        if (!inside(rootReal, asked) && inside(rootAsConfigured, asked)) {
            asked = path.join(rootReal, path.relative(rootAsConfigured, asked));
        }
        // Refused before touching the filesystem, so a path outside the root
        // (/data, /etc) cannot even be probed for existence.
        if (!inside(rootReal, asked)) throw notAllowed();
        const relative = path.relative(rootReal, asked);
        const kind = classifyRelative(relative);
        if (kind === 'hidden') throw notAllowed();
        return { asked, relative, kind, root: rootReal };
    }

    /**
     * Resolve a requested path (absolute, or relative to the root) to
     * { real, relative, kind }, or throw a 404. Both the requested path and
     * its realpath must stay inside the root and must not be hidden, so a
     * symlink named innocently cannot reach .git, a secret-shaped file or
     * /data.
     */
    async function resolve(requested) {
        const { asked, kind: askedKind, root: rootReal } = await locate(requested);

        let real;
        try {
            real = await fsp.realpath(asked);
        } catch {
            throw notAllowed();
        }
        if (!inside(rootReal, real)) throw notAllowed();
        const relative = path.relative(rootReal, real);
        const kind = classifyRelative(relative);
        if (kind === 'hidden') throw notAllowed();
        // A sensitive name on the requested side counts too: a symlink called
        // .env pointing at an ordinary file is still refused.
        return { real, relative, kind: askedKind === 'sensitive' ? 'sensitive' : kind, root: rootReal };
    }

    // One listing entry, or null to leave it out. Symlinks are followed only
    // when their target stays inside the root and is not hidden; otherwise the
    // entry is omitted rather than shown with the target's size and type.
    async function describe(dir, dirent, rootReal) {
        const full = path.join(dir, dirent.name);
        const relative = path.relative(rootReal, full);
        if (walkEntryType(relative, dirent, { allowSensitive: true }) === null) return null;
        try {
            let kind = classifyRelative(relative);
            if (dirent.isSymbolicLink()) {
                const target = await fsp.realpath(full);
                if (!inside(rootReal, target)) return null;
                const targetKind = classifyRelative(path.relative(rootReal, target));
                if (targetKind === 'hidden') return null;
                // Same rule as resolve(): sensitive if the link's name OR its
                // target is, so notes.txt -> .storage/auth shows the lock.
                if (targetKind === 'sensitive') kind = 'sensitive';
            }
            const stat = await fsp.stat(full);
            const isDir = stat.isDirectory();
            if (!isDir && !stat.isFile()) return null;   // sockets, FIFOs, devices
            return {
                name: dirent.name,
                path: full,
                type: isDir ? 'dir' : 'file',
                size: isDir ? null : stat.size,
                mtime: stat.mtimeMs,
                ...(kind === 'sensitive' ? { sensitive: true } : {}),
                // The UI offers "Upload here" on real folders only: an
                // upload into a symlinked one is refused (409).
                ...(dirent.isSymbolicLink() ? { symlink: true } : {}),
            };
        } catch {
            return null;   // vanished, dangling link, permission
        }
    }

    async function list(requested) {
        const { real, root: rootReal } = await resolve(requested);
        let dir;
        try {
            dir = await fsp.opendir(real);
        } catch (err) {
            if (err.code === 'ENOTDIR') throw new FilesError(400, 'Not a folder');
            throw new FilesError(400, `Cannot read folder (${err.code || 'error'})`);
        }
        const dirents = [];
        let truncated = false;
        try {
            for await (const dirent of dir) {
                if (dirents.length >= maxEntries) {
                    truncated = true;
                    break;
                }
                dirents.push(dirent);
            }
        } catch (err) {
            throw new FilesError(400, `Cannot read folder (${err.code || 'error'})`);
        } finally {
            // Breaking out of for-await closes the handle already; a second
            // close rejects with ERR_DIR_CLOSED, which is fine to ignore.
            await dir.close().catch(() => {});
        }
        const entries = (await Promise.all(dirents.map((d) => describe(real, d, rootReal))))
            .filter(Boolean)
            .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
        return { path: real, root: rootReal, entries, truncated };
    }

    /**
     * Open a file for reading. `requestedPath` must be absolute and come
     * from resolve() or from a walk that never follows symlinks. It is
     * normalised with path.resolve() and classified before the open, which
     * stops a "../" or a plain outside path, but NOT a symlinked parent
     * folder: that check is a string-prefix one. A raw request path is not
     * safe here, and where /proc is unavailable it can escape through a
     * symlinked parent folder.
     *
     * O_NONBLOCK so a FIFO cannot hang the open. O_NOFOLLOW refuses a
     * symlink in the FINAL component only: a parent folder swapped for a
     * symlink between resolve() and here is still followed. That case is
     * caught after the open, by asking the kernel which file the
     * descriptor actually is (/proc/self/fd, Linux) and checking that
     * path again. Where /proc is unavailable only that second check is
     * skipped. The type is checked on the open descriptor, not the path.
     *
     * Both checks apply the tiers: the path is classified BEFORE the open
     * (which refuses hidden and outside-the-root paths even without /proc),
     * and the descriptor's path again AFTER it, as the race guard. Only the
     * second one sees through a symlinked parent folder.
     *
     * Resolves to { handle, stat, sensitive }, `sensitive` being true when
     * either check found a protected file (only possible with
     * `allowSensitive`); the caller closes the handle. Hidden and
     * outside-the-root are always refused, sensitive unless
     * `allowSensitive`.
     */
    async function openFile(requestedPath, { allowSensitive = false, action = 'open' } = {}) {
        // Normalise first: inside() is a string-prefix check, and a "../" left
        // in the path would pass it and still open a file outside the root.
        const real = path.resolve(requestedPath);
        const rootBefore = await realRoot();
        if (!inside(rootBefore, real)) throw notAllowed();
        const kindBefore = classifyRelative(path.relative(rootBefore, real));
        if (kindBefore === 'hidden') throw notAllowed();
        if (kindBefore === 'sensitive' && !allowSensitive) throw secretRefusal(action);

        let handle;
        try {
            handle = await fsp.open(real, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
        } catch (err) {
            if (err.code === 'EISDIR') throw new FilesError(400, 'Not a file');
            throw new FilesError(400, `Cannot read file (${err.code || 'error'})`);
        }
        let sensitive = kindBefore === 'sensitive';
        try {
            const opened = await fdPath(handle.fd);
            if (opened !== null) {
                const rootReal = await realRoot();
                if (!inside(rootReal, opened)) throw notAllowed();
                const openedKind = classifyRelative(path.relative(rootReal, opened));
                if (openedKind === 'hidden') throw notAllowed();
                if (openedKind === 'sensitive' && !allowSensitive) throw secretRefusal(action);
                if (openedKind === 'sensitive') sensitive = true;
            }
            const stat = await handle.stat();
            if (!stat.isFile()) throw new FilesError(400, 'Not a file');
            return { handle, stat, sensitive };
        } catch (err) {
            await handle.close().catch(() => {});
            if (err instanceof FilesError) throw err;
            throw new FilesError(400, `Cannot read file (${err.code || 'error'})`);
        }
    }

    /**
     * Resolve a REQUESTED path and open it: { handle, stat, real, kind }.
     * The one place that checks the kind before opening. resolve() marks a
     * path sensitive by its requested name too (a symlink called .env to an
     * ordinary file), which openFile, seeing only the realpath, cannot know.
     * `kind` is 'sensitive' if either resolve() or openFile found a
     * protected file, so neither check alone can clear it.
     * `.git` and anything outside the root are a 404 whatever allowSensitive
     * says. `action` words the 403 ("open" or "download"). The caller owns
     * the handle.
     */
    async function openRequested(requested, { allowSensitive = false, action = 'open' } = {}) {
        const { real, kind } = await resolve(requested);
        if (kind === 'sensitive' && !allowSensitive) throw secretRefusal(action);
        if (onResolved) await onResolved(real);
        const { handle, stat, sensitive } = await openFile(real, { allowSensitive, action });
        return { handle, stat, real, kind: sensitive ? 'sensitive' : kind };
    }

    /**
     * Up to maxPreviewBytes of a file. `sensitive` says whether what was
     * opened is a protected file: the UI clears such a preview when "Show
     * protected files" goes off, and takes this answer over its listing,
     * which can be stale (a file replaced by a link to .env since).
     */
    async function preview(requested, { allowSensitive = false } = {}) {
        const { handle, stat, real, kind } = await openRequested(requested, { allowSensitive });
        try {
            const length = Math.min(stat.size, maxPreviewBytes);
            const buffer = Buffer.alloc(length);
            let read = 0;
            while (read < length) {
                const { bytesRead } = await handle.read(buffer, read, length - read, read);
                if (bytesRead === 0) break;
                read += bytesRead;
            }
            const data = buffer.subarray(0, read);
            const truncated = stat.size > read;
            const base = { path: real, size: stat.size, mtime: stat.mtimeMs, limit: maxPreviewBytes, sensitive: kind === 'sensitive' };
            if (looksBinary(data, truncated)) return { ...base, binary: true };
            return {
                ...base,
                binary: false,
                truncated,
                content: new TextDecoder('utf-8').decode(data, { stream: truncated }),
            };
        } catch (err) {
            if (err instanceof FilesError) throw err;
            throw new FilesError(400, `Cannot read file (${err.code || 'error'})`);
        } finally {
            await handle.close().catch(() => {});
        }
    }

    /**
     * Files changed in the last `hours`, newest first. Does not follow
     * symlinks (no loops, no escapes) and skips what HA rewrites itself.
     */
    async function recent(hoursRequested) {
        const hours = Math.min(Math.max(Number(hoursRequested) || 24, 1), MAX_RECENT_HOURS);
        const rootReal = await realRoot();
        const since = now() - hours * 3600 * 1000;
        const deadline = Date.now() + recentTimeBudgetMs;
        const found = [];
        let visits = 0;
        let incomplete = false;

        async function walk(dir, depth) {
            if (depth > MAX_RECENT_DEPTH) { incomplete = true; return; }
            let handle;
            try { handle = await fsp.opendir(dir); } catch { return; }
            const subdirs = [];
            try {
                for await (const dirent of handle) {
                    if (++visits > MAX_RECENT_VISITS || Date.now() > deadline) {
                        incomplete = true;
                        break;
                    }
                    const full = path.join(dir, dirent.name);
                    const relative = path.relative(rootReal, full);
                    const type = walkEntryType(relative, dirent);
                    if (type === 'dir') {
                        const name = lower(dirent.name);
                        const parent = lower(path.basename(dir));
                        const skip = RECENT_SKIP_DIRS.has(name)
                            || RECENT_SKIP_NESTED.some(([p, n]) => p === parent && n === name);
                        if (!skip) subdirs.push(full);
                    } else if (type === 'file' && !RECENT_SKIP_FILE.test(dirent.name)) {
                        let stat;
                        try { stat = await fsp.stat(full); } catch { continue; }
                        if (stat.mtimeMs >= since) {
                            found.push({ name: dirent.name, path: full, relative, type: 'file', size: stat.size, mtime: stat.mtimeMs });
                        }
                    }
                }
            } catch {
                // Folder changed under us; keep what was read.
            } finally {
                await handle.close().catch(() => {});
            }
            for (const sub of subdirs) {
                if (incomplete) return;
                await walk(sub, depth + 1);
            }
        }

        await walk(rootReal, 0);
        found.sort((a, b) => b.mtime - a.mtime);
        return {
            hours,
            root: rootReal,
            entries: found.slice(0, MAX_RECENT),
            truncated: found.length > MAX_RECENT,
            incomplete,
        };
    }

    return { root, locate, resolve, list, preview, recent, openFile, openRequested };
}

/**
 * protected=1, sent by the UI only while "Show protected files" is on, lifts
 * the sensitive tier's refusal for preview and download. Exactly '1': an
 * array (?protected=1&protected=1) or any other value is off. list never
 * reads it: a sensitive folder's names were always listable.
 */
const allowsProtected = (req) => req.query.protected === '1';

/**
 * Answer a failed request with JSON: a FilesError's own status and message,
 * anything else a logged 500. Shared with files-download.js, so every Files
 * route fails the same way.
 */
function sendError(res, err, log = console.error) {
    if (res.headersSent) {
        // Mid-stream: a JSON body can no longer be sent. Cut the connection
        // so the client sees a failed transfer, not a truncated "success".
        log(`Files API error after headers were sent: ${err && err.message}`);
        res.destroy();
        return;
    }
    if (err instanceof FilesError) {
        // Only an object's fields (null spreads to none): a string or an
        // array would spread into "0", "1", ... keys.
        const details = typeof err.details === 'object' && !Array.isArray(err.details) ? err.details : {};
        res.status(err.status).json({ ...details, error: err.message });
    } else {
        log(`Files API error: ${err && err.message}`);
        res.status(500).json({ error: 'Internal error' });
    }
}

/**
 * Express router for the sidebar. Mounted by server.js at /api/files - not at
 * the top level, where GET /config already exists - among the
 * API routes - before the terminal proxy and static files.
 *
 * `readLimiter` and `checkLimiter` are http-guards.js rate limiters. The POST
 * already passes the app-wide origin guard; the GETs are read-only and send no
 * CORS headers, so another site can trigger them but cannot read the answer.
 *
 * No handler can throw out: every failure becomes a JSON error.
 */
function createFilesRouter({ api, haCheck, readLimiter, checkLimiter, log = console.error }) {
    const router = express.Router();

    const reply = (handler) => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            res.json(await handler(req));
        } catch (err) {
            sendError(res, err, log);
        }
    };

    // Passed through as-is: ?path=a&path=b arrives as an array, which
    // resolve() refuses as an invalid path rather than guessing.
    const queryPath = (req) => req.query.path;

    router.get('/list', readLimiter, reply((req) => api.list(queryPath(req))));
    router.get('/preview', readLimiter, reply((req) => api.preview(queryPath(req), { allowSensitive: allowsProtected(req) })));
    router.get('/recent', readLimiter, reply((req) => api.recent(req.query.hours)));

    router.post('/ha-check', checkLimiter, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const pending = haCheck.run();
            if (!pending) return res.status(409).json({ ok: false, message: 'A check is already running' });
            res.json(await pending);
        } catch (err) {
            log(`HA check error: ${err && err.message}`);
            res.status(500).json({ ok: false, message: 'Internal error' });
        }
    });

    return router;
}

module.exports = {
    createFilesApi,
    createFilesRouter,
    createHaCheck,
    classifyRelative,
    walkEntryType,
    looksBinary,
    procFdPath,
    FilesError,
    allowsProtected,
    sendError,
    inside,
    PARTIAL_FILE,
    MAX_ENTRIES,
    MAX_PREVIEW_BYTES,
    MAX_RECENT_DEPTH,
    MAX_RECENT_VISITS,
    RECENT_TIME_BUDGET_MS,
};
