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
const {
    walkEntryType,
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
} = {}) {
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

    return { planZip };
}

module.exports = {
    createDownloads,
    MAX_ZIP_BYTES,
};
