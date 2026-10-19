'use strict';

// Names that are not valid UTF-8, for the suites that check they are counted
// rather than dropped silently (files-api, files-download-plan). Linux allows
// any bytes in a name but '/' and NUL; macOS refuses such names (EILSEQ).

const fs = require('node:fs');
const path = require('node:path');

/**
 * Makes the name `bytes` (a Buffer) in `dir`: a file, or with `folder` a
 * folder holding inner.txt. False where the file system refuses the name.
 */
function makeBadName(dir, bytes, { folder = false } = {}) {
    const full = Buffer.concat([Buffer.from(dir + path.sep), bytes]);
    try {
        fs.mkdirSync(dir, { recursive: true });
        if (folder) {
            fs.mkdirSync(full);
            fs.writeFileSync(Buffer.concat([full, Buffer.from('/inner.txt')]), 'inner');
        } else {
            fs.writeFileSync(full, 'bad name');
        }
        return true;
    } catch {
        return false;
    }
}

// The test option that skips a test where such names cannot be made.
// `probeDir` is a scratch folder the suite removes with its tree.
const needsBadNames = (probeDir) => ({
    skip: !makeBadName(probeDir, Buffer.from([0x70, 0xff])) && 'the file system refuses names that are not UTF-8',
});

module.exports = { makeBadName, needsBadNames };
