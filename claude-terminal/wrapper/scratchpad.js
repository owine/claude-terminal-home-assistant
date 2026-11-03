'use strict';

/**
 * The Files sidebar's Scratchpad tab: which Claude Code sessions are on this
 * box, which one is active, and where each one's scratchpad folder is; and
 * the /api/scratchpad router that serves those folders read-only.
 *
 * Built on Claude Code internals, none of them documented API (read from
 * Claude Code 2.1.3xx; re-check on every Claude Code bump, see CLAUDE.md):
 *
 * - A running session leaves `${CLAUDE_CONFIG_DIR:-~/.claude}/sessions/<pid>.json`
 *   (pid, sessionId, cwd, kind, status, name, updatedAt), removed on a clean
 *   exit. Beside it sits `<pid>.<hash>.key`, a peer token: only names
 *   matching RECORD_NAME are ever opened.
 * - A killed session (an app restart or update) leaves its record behind,
 *   and /data keeps it forever. Two checks drop such stale records: the PID
 *   in the file name must be a running claude before the record is even
 *   opened, and the record's procStart must equal that process's start time
 *   in /proc/<pid>/stat (field 22, clock ticks since boot). That rules out a
 *   reused PID even when the new process is also a claude. pidDomain is
 *   deliberately not used: PID namespace inode numbers are recycled across
 *   container starts, so a stale record and a live one were seen carrying
 *   the same value on a live install.
 * - Its scratchpad is `${CLAUDE_CODE_TMPDIR:-/tmp}/claude-<uid>/<cwd slug>/<sessionId>/scratchpad`,
 *   made on first use. /tmp is not persistent, so every folder is gone after
 *   an app restart.
 *
 * Should the records change shape, discovery degrades to the folders alone
 * (every session "ended"), so the tab stays useful. Everything filesystem-
 * and process-shaped is injectable; nothing runs at require time.
 */

const fsp = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const path = require('node:path');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECORD_NAME = /^(\d+)\.json$/;
// Names looked at, dead ones included: a folder of stale records is bounded
// work. MAX_RECORDS then caps the live ones read.
const MAX_RECORD_NAMES = 4096;
const MAX_RECORDS = 64;
const MAX_RECORD_BYTES = 64 * 1024;
// The tmp root also holds Claude Code's own non-session folders.
const MAX_TMP_ENTRIES = 1000;
// Ended sessions only. A live session's folder is looked up directly under
// its cwd's slug, which no cap limits; only a slug Claude Code builds
// differently from slugOf(), behind more than MAX_TMP_ENTRIES folders,
// could hide it.
const MAX_ENDED_PER_ENTRY = 64;
const MAX_ENDED_TOTAL = 200;
const MAX_SESSIONS = 50;

function defaultSessionsDir(env = process.env) {
    return path.join(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || '/root', '.claude'), 'sessions');
}

function defaultTmpRoot(env = process.env) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    return path.join(env.CLAUDE_CODE_TMPDIR || '/tmp', `claude-${uid}`);
}

/** Whether a NUL-separated /proc/<pid>/cmdline names the claude binary. */
function looksLikeClaude(cmdline) {
    return String(cmdline).split('\0').some((arg) => arg !== '' && path.basename(arg) === 'claude');
}

// Whether `pid` is a running Claude Code. kill(pid, 0) sends nothing; it
// only asks whether the process exists (EPERM: it does, as someone else's).
// Where /proc exists its argv must name claude too, so a PID the kernel has
// since handed to another program is not taken for the session.
async function defaultIsAlive(pid) {
    try {
        process.kill(pid, 0);
    } catch (err) {
        if (err.code !== 'EPERM') return false;
    }
    try {
        return looksLikeClaude(await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8'));
    } catch {
        // No /proc at all (macOS, in development): kill() is all there is.
        // With /proc, a missing entry means the process just exited.
        try {
            await fsp.access('/proc/self');
            return false;
        } catch {
            return true;
        }
    }
}

/** Field 22 (starttime) of a /proc/<pid>/stat line, or null. comm (field 2)
 *  is parenthesised and may hold spaces or ')', so count from the last ')'. */
function startTimeFromStat(text) {
    const close = text.lastIndexOf(')');
    if (close < 0) return null;
    const start = text.slice(close + 1).trim().split(/\s+/)[22 - 3];
    return /^\d+$/.test(start || '') ? start : null;
}

// When `pid` started, in clock ticks since boot, as the string Claude Code
// writes into a record's procStart; null where there is no /proc (macOS, in
// development) or the process is gone.
async function defaultProcStartOf(pid) {
    try {
        return startTimeFromStat(await fsp.readFile(`/proc/${pid}/stat`, 'utf8'));
    } catch {
        return null;
    }
}

const str = (v) => (typeof v === 'string' ? v : null);
// The folder name Claude Code makes from a session's cwd ("/config" ->
// "-config", as seen on a live install).
const slugOf = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

function createScratchpads({
    sessionsDir = defaultSessionsDir(),
    tmpRoot = defaultTmpRoot(),
    isAlive = defaultIsAlive,
    procStartOf = defaultProcStartOf,
    fs = fsp,
    log = console.error,
} = {}) {
    // A changed format or a broken disk shows up in the log once, not on
    // every request. ENOENT is normal (no session yet) and never logged.
    const logged = new Set();
    function logOnce(where, err) {
        if (err && err.code === 'ENOENT') return;
        const key = `${where}:${(err && err.code) || 'format'}`;
        if (logged.has(key)) return;
        logged.add(key);
        log(`Scratchpad discovery: ${where}: ${(err && err.message) || err}`);
    }

    async function readRecord(file, pid) {
        // O_NOFOLLOW, then fstat: the file read is the file checked.
        // O_NONBLOCK: a FIFO by that name would otherwise block open()
        // forever, before fstat could refuse it. A regular file ignores it.
        const fh = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
        try {
            const st = await fh.stat();
            if (!st.isFile() || st.size > MAX_RECORD_BYTES) return null;
            // One bounded read: a file that grew since fstat is still
            // never read past the cap.
            const buf = Buffer.alloc(MAX_RECORD_BYTES + 1);
            const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
            if (bytesRead > MAX_RECORD_BYTES) return null;
            const r = JSON.parse(buf.subarray(0, bytesRead).toString('utf8'));
            if (!r || typeof r !== 'object' || r.pid !== pid) return null;
            if (typeof r.sessionId !== 'string' || !UUID.test(r.sessionId) || typeof r.cwd !== 'string') return null;
            return {
                id: r.sessionId,
                pid,
                cwd: r.cwd,
                name: str(r.name),
                kind: str(r.kind),
                status: str(r.status),
                updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : 0,
                procStart: str(r.procStart),
            };
        } finally {
            await fh.close();
        }
    }

    async function liveRecords() {
        let names;
        try {
            names = await fs.readdir(sessionsDir);
        } catch (err) {
            logOnce(sessionsDir, err);
            return new Map();
        }
        const byId = new Map();
        let read = 0;
        for (const name of names.filter((x) => RECORD_NAME.test(x)).slice(0, MAX_RECORD_NAMES)) {
            if (read >= MAX_RECORDS) break;
            // Liveness from the file name first: a stale record is never
            // opened, so no number of them can use up MAX_RECORDS.
            const pid = Number(RECORD_NAME.exec(name)[1]);
            // kill(0, 0) would ask about our own process group, not a PID.
            if (!Number.isSafeInteger(pid) || pid < 1) continue;
            if (!(await isAlive(pid))) continue;
            read++;
            let r;
            try {
                r = await readRecord(path.join(sessionsDir, name), pid);
            } catch (err) {
                if (err instanceof SyntaxError) continue;   // malformed: skipped quietly
                logOnce('a session record', err);
                continue;
            }
            if (!r) continue;
            // A PID reused since the record was written, by a claude or not.
            // Fail-open: a procStart that is not digits (macOS writes a
            // date) or no start time of our own reading checks nothing, so
            // a changed field cannot end every session.
            if (r.procStart !== null && /^\d+$/.test(r.procStart)) {
                const start = await procStartOf(pid);
                if (start !== null && start !== r.procStart) continue;
            }
            const prev = byId.get(r.id);
            if (!prev || r.updatedAt > prev.updatedAt) byId.set(r.id, r);
        }
        return byId;
    }

    // `live`: id -> cwd of each live session.
    async function folders(live) {
        const found = new Map();   // id -> { dir, slug, mtime }
        let rootReal;
        let entries;
        try {
            rootReal = await fs.realpath(tmpRoot);
            entries = (await fs.readdir(rootReal, { withFileTypes: true }))
                .filter((d) => d.isDirectory())   // a symlinked slug is not
                .slice(0, MAX_TMP_ENTRIES)
                .map((d) => d.name);
        } catch (err) {
            logOnce(tmpRoot, err);
            return found;
        }
        async function probe(slug, id) {
            const dir = path.join(rootReal, slug, id, 'scratchpad');
            try {
                const st = await fs.lstat(dir);
                if (!st.isDirectory()) return;
                const real = await fs.realpath(dir);
                if (!real.startsWith(rootReal + path.sep)) return;
                found.set(id, { dir: real, slug, mtime: st.mtimeMs });
            } catch {
                /* not there */
            }
        }
        // Live ids: first under their cwd's own slug, which no cap limits;
        // only if that misses, in every entry MAX_TMP_ENTRIES let through.
        for (const [id, cwd] of live) {
            await probe(slugOf(cwd), id);
            for (const slug of entries) {
                if (found.has(id)) break;
                await probe(slug, id);
            }
        }
        // Ended sessions: capped.
        let ended = 0;
        for (const slug of entries) {
            if (ended >= MAX_ENDED_TOTAL) break;
            let names;
            try {
                names = await fs.readdir(path.join(rootReal, slug));
            } catch {
                continue;
            }
            const ids = names.filter((x) => UUID.test(x) && !live.has(x) && !found.has(x)).slice(0, MAX_ENDED_PER_ENTRY);
            for (const id of ids) {
                if (ended >= MAX_ENDED_TOTAL) break;
                ended++;
                await probe(slug, id);
            }
        }
        return found;
    }

    /**
     * { active, sessions, dirs }: `sessions` (at most 50) live first by
     * updatedAt, then ended by folder mtime, newest first; `active` the id
     * the tab opens on; `dirs` id -> real scratchpad folder, for the router
     * only. Never rejects.
     */
    async function discover() {
        try {
            const live = await liveRecords();
            const found = await folders(new Map([...live].map(([id, r]) => [id, r.cwd])));
            const sessions = [];
            for (const r of live.values()) {
                const f = found.get(r.id);
                sessions.push({
                    id: r.id,
                    label: r.name || path.basename(r.cwd) || r.cwd,
                    cwd: r.cwd,
                    live: true,
                    kind: r.kind,
                    status: r.status,
                    updatedAt: r.updatedAt,
                    mtime: f ? f.mtime : null,
                    exists: Boolean(f),
                });
            }
            for (const [id, f] of found) {
                if (live.has(id)) continue;
                sessions.push({ id, label: f.slug, cwd: f.slug, live: false, kind: null, status: null, updatedAt: null, mtime: f.mtime, exists: true });
            }
            sessions.sort((a, b) => (Number(b.live) - Number(a.live))
                || (a.live ? b.updatedAt - a.updatedAt : b.mtime - a.mtime));
            const kept = sessions.slice(0, MAX_SESSIONS);
            const active = kept.find((s) => s.live && (s.kind === null || s.kind === 'interactive'))
                || kept.find((s) => s.live)
                || kept.find((s) => s.exists)
                || null;
            const dirs = new Map(kept.filter((s) => s.exists).map((s) => [s.id, found.get(s.id).dir]));
            return { active: active ? active.id : null, sessions: kept, dirs };
        } catch (err) {
            logOnce('discovery', err);
            return { active: null, sessions: [], dirs: new Map() };
        }
    }

    return { discover };
}

module.exports = { createScratchpads, looksLikeClaude, defaultIsAlive, defaultProcStartOf, startTimeFromStat, UUID };
