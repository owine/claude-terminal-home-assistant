'use strict';

/**
 * The record of upload parts being written, kept in a file in /data so that a
 * part left by a crash or a restart mid-upload is deleted on the next start.
 * files-upload.js adds each part before its first byte and removes it once
 * the part is renamed into place or deleted.
 *
 * Only what the record names is ever deleted: /config is never searched.
 *
 * No listener and no side effects at require time, so tests import it
 * directly (same reason as http-guards.js).
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { inside, PARTIAL_FILE } = require('./files-api');

async function lstatOrNull(p) {
    try {
        return await fsp.lstat(p);
    } catch {
        return null;
    }
}

/**
 * The record of parts being written, in a file in /data. Parts are held in
 * memory and the whole record rewritten on every change (a temp file renamed
 * over it, so a crash leaves the old record or the new, never half of one),
 * one write at a time and in order, so uploads running together cannot race
 * on it. start() deletes the parts an earlier run left (a crash, a restart
 * mid-upload); every change queues behind it.
 *
 * add() rejects when the record cannot be written, and the upload is then
 * refused: a part nobody recorded could outlive a crash forever.
 *
 * `open` and `unlink` are test seams: the temp file's open, and the sweep's
 * delete.
 */
function createPartRecord({ file, root, log = console.error, open = fsp.open, unlink = fsp.unlink }) {
    const parts = new Set();
    // What start() could not sweep - the whole record, its root not there
    // yet, or the parts it could not judge (judge): carried into every
    // write, so the next start still finds them.
    let carried = [];
    let chain = Promise.resolve();
    const queue = (job) => {
        const run = chain.then(job);
        chain = run.catch(() => {});   // a failed job does not stop the next
        return run;
    };
    const write = async (list) => {
        const tmp = `${file}.tmp`;
        const handle = await open(tmp, 'w', 0o600);
        try {
            await handle.writeFile(JSON.stringify([...carried, ...list]) + '\n');
            // On disk before the rename: after a power cut the rename can
            // survive while unsynced data does not, which would leave an
            // empty record and the parts it named unswept.
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fsp.rename(tmp, file);
    };

    // What the sweep does with a recorded path: 'remove' it when it is still
    // a regular file named like a part, in a folder that is still a real
    // folder inside the root. Nothing else is searched: what the record does
    // not name is never touched. 'keep' it named, for a later start, when a
    // part may be there but cannot be judged now: /config resolving
    // somewhere else this time, a folder swapped for a link, a folder that
    // cannot be read. 'drop' it when it never could be removed (not a part's
    // path) or nothing is there.
    async function judge(p, rootReal) {
        if (typeof p !== 'string' || !path.isAbsolute(p) || path.resolve(p) !== p) return 'drop';
        if (!PARTIAL_FILE.test(path.basename(p))) return 'drop';
        const dir = path.dirname(p);
        let realDir;
        try {
            realDir = await fsp.realpath(dir);
        } catch (err) {
            return err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 'drop' : 'keep';
        }
        const st = await lstatOrNull(p);
        if (!st) return 'drop';
        if (realDir !== dir || !inside(rootReal, dir)) return 'keep';
        // A link or a folder in the part's place is not the part.
        return st.isFile() ? 'remove' : 'drop';
    }

    async function sweep() {
        let listed;
        try {
            listed = JSON.parse(await fsp.readFile(file, 'utf8'));
        } catch (err) {
            if (err.code === 'ENOENT') return 0;
            log(`Upload parts: unreadable record ${file} (${err.message}); starting a new one`);
            listed = [];
        }
        let rootReal;
        try {
            rootReal = await fsp.realpath(root);
        } catch {
            // /config not there yet: keep the record for the next start.
            log(`Upload parts: ${root} is not available; leaving the record for the next start`);
            carried = Array.isArray(listed) ? listed.filter((p) => typeof p === 'string') : [];
            return 0;
        }
        let removed = 0;
        const kept = [];
        for (const p of Array.isArray(listed) ? listed : []) {
            const verdict = await judge(p, rootReal);
            if (verdict === 'keep') kept.push(p);
            if (verdict !== 'remove') continue;
            try {
                await unlink(p);
                removed++;
            } catch (err) {
                if (err.code === 'ENOENT') continue;   // gone meanwhile
                log(`Upload parts: could not remove ${p}: ${err.message}`);
                kept.push(p);
            }
        }
        // Carried through every write, as for a root not there yet.
        carried = kept;
        await write([]);
        if (removed) log(`Upload parts: removed ${removed} left by an earlier run`);
        if (kept.length) {
            log(`Upload parts: ${kept.length} left in the record, not removable now (outside ${root}, or not in a real folder); tried again at the next start`);
        }
        return removed;
    }

    return {
        /** Resolves to the number of parts removed; never rejects. */
        start: () => queue(sweep).catch((err) => {
            log(`Upload parts: cleanup failed: ${err.message}`);
            return 0;
        }),
        async add(p) {
            parts.add(p);
            try {
                await queue(() => write([...parts]));
            } catch (err) {
                parts.delete(p);
                throw err;
            }
        },
        async remove(p) {
            if (!parts.delete(p)) return;
            await queue(() => write([...parts]));
        },
        list: () => [...parts],
    };
}

module.exports = { createPartRecord };
