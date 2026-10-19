'use strict';

// Pure helpers behind the Files sidebar UI (public/files-sidebar.js).
// shellQuote is checked against a real shell where one is available: what it
// produces is typed at a bash prompt, so the only meaningful assertion is
// what bash makes of it.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const {
    shellQuote,
    formatSize,
    formatAgo,
    clampWidth,
    relativeTo,
    downloadUrl,
    uploadUrl,
    uploadTarget,
    uploadErrorText,
    displayName,
    uploadSummary,
} = require('../public/files-sidebar.js');

test('plain paths are typed as-is', () => {
    for (const p of ['/config/configuration.yaml', '/config/packages/climate_v2.yaml', '/config/a-b/c.d,e:f@g%h+i=j']) {
        assert.strictEqual(shellQuote(p), p);
    }
});

test('spaces and shell metacharacters are single-quoted', () => {
    assert.strictEqual(shellQuote('/config/with space.yaml'), "'/config/with space.yaml'");
    assert.strictEqual(shellQuote('/config/$(rm -rf ~).yaml'), "'/config/$(rm -rf ~).yaml'");
    assert.strictEqual(shellQuote("/config/it's.yaml"), "'/config/it'\\''s.yaml'");
    assert.strictEqual(shellQuote('/config/é.yaml'), "'/config/é.yaml'");
});

test('control characters are escaped, never typed', () => {
    const quoted = shellQuote('/config/a\nb\x1b[31m\x7f\u0085.yaml');
    assert.strictEqual(quoted, "$'/config/a\\x0ab\\x1b[31m\\x7f\\u0085.yaml'");
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(quoted, /[\x00-\x1f\x7f-\x9f]/);
    assert.strictEqual(shellQuote("/c/\t'\\"), "$'/c/\\x09\\'\\\\'");
});

test('the empty string is an empty word', () => {
    assert.strictEqual(shellQuote(''), "''");
});

// bash -c 'printf %s "$1"' -- <quoted> would not test the quoting; the quoted
// text has to be parsed by the shell as source, as it is at a prompt.
let bash = null;
try { execFileSync('bash', ['-c', 'true']); bash = 'bash'; } catch { /* no bash */ }

test('bash reads every quoted path back as the original, as one word', { skip: !bash && 'bash not available' }, () => {
    const paths = [
        '/config/plain.yaml',
        '/config/with space.yaml',
        "/config/it's here.yaml",
        '/config/$(touch /tmp/pwned)`id`;|&<>*?[]{}!#~.yaml',
        '/config/new\nline.yaml',
        '/config/tab\tand\\backslash.yaml',
        '/config/esc\x1b[0m.yaml',
        '/config/ünïcödé ✂.yaml',
    ];
    for (const p of paths) {
        const out = execFileSync(bash, ['-c', `set -- ${shellQuote(p)}; printf '%s|%s' "$#" "$1"`]).toString();
        assert.strictEqual(out, `1|${p}`, JSON.stringify(p));
    }
});

test('formatSize', () => {
    assert.strictEqual(formatSize(0), '0 B');
    assert.strictEqual(formatSize(2048), '2.0 KB');
    assert.strictEqual(formatSize(5 * 1024 * 1024), '5.0 MB');
    assert.strictEqual(formatSize(null), '');
});

test('formatAgo', () => {
    const now = 1_000_000_000;
    assert.strictEqual(formatAgo(now - 5000, now), 'just now');
    assert.strictEqual(formatAgo(now - 5 * 60000, now), '5 min ago');
    assert.strictEqual(formatAgo(now - 3 * 3600000, now), '3 h ago');
    assert.strictEqual(formatAgo(now - 2 * 86400000, now), '2 d ago');
    assert.strictEqual(formatAgo(now + 5000, now), 'just now');
});

test('clampWidth keeps the sidebar sane and the terminal usable', () => {
    assert.strictEqual(clampWidth(null, 1400), 300);
    assert.strictEqual(clampWidth('garbage', 1400), 300);
    assert.strictEqual(clampWidth(50, 1400), 180);
    assert.strictEqual(clampWidth(5000, 1400), 800);
    assert.strictEqual(clampWidth(700, 800), 600);
    assert.strictEqual(clampWidth(400, 300), 180);
});

test('relativeTo', () => {
    assert.strictEqual(relativeTo('/config', '/config/packages/x.yaml'), 'packages/x.yaml');
    assert.strictEqual(relativeTo('/config', '/configuration/x'), '/configuration/x');
});

test('downloadUrl: relative and encoded; protected=1 for single files only', () => {
    assert.strictEqual(downloadUrl('/config/with space.yaml'),
        'api/files/download?path=%2Fconfig%2Fwith%20space.yaml');
    assert.strictEqual(downloadUrl('/config/.env', { protectedOn: true }),
        'api/files/download?path=%2Fconfig%2F.env&protected=1');
    assert.strictEqual(downloadUrl('/config/a&b=c#d?.yaml'),
        'api/files/download?path=%2Fconfig%2Fa%26b%3Dc%23d%3F.yaml');
    assert.strictEqual(downloadUrl('/config/blueprints', { zip: true }),
        'api/files/download-zip?path=%2Fconfig%2Fblueprints');
    assert.strictEqual(downloadUrl('/config/blueprints', { zip: true, check: true, protectedOn: true }),
        'api/files/download-zip?path=%2Fconfig%2Fblueprints&check=1');
    assert.strictEqual(downloadUrl('/config/x.yaml', { check: true }),
        'api/files/download?path=%2Fconfig%2Fx.yaml');
});

test('uploadUrl: relative and encoded; no dest is the inbox; check=1 carries the size', () => {
    assert.strictEqual(uploadUrl({ name: 'a b&c=d#.txt' }),
        'api/files/upload?name=a%20b%26c%3Dd%23.txt');
    assert.strictEqual(uploadUrl({ name: 'x.yaml', dest: '/config/with space', onConflict: 'keep-both' }),
        'api/files/upload?name=x.yaml&dest=%2Fconfig%2Fwith%20space&onConflict=keep-both');
    assert.strictEqual(uploadUrl({ name: 'x.yaml', dest: '/config/b', check: true, size: 42 }),
        'api/files/upload?name=x.yaml&dest=%2Fconfig%2Fb&check=1&size=42');
    assert.strictEqual(uploadUrl({ name: 'x', dest: null }), 'api/files/upload?name=x');
});

test('uploadTarget: offered on real folders; disabled with a reason on protected ones and deps', () => {
    const dir = (p, extra = {}) => ({ type: 'dir', path: p, ...extra });
    assert.deepStrictEqual(uploadTarget(dir('/config/blueprints'), '/config'),
        { disabled: false, hint: '', title: 'Upload files into this folder' });
    assert.strictEqual(uploadTarget(dir('/config/bp-link', { symlink: true }), '/config'), null);
    assert.strictEqual(uploadTarget({ type: 'file', path: '/config/a.yaml' }, '/config'), null);
    assert.strictEqual(uploadTarget(dir('/config/.storage', { sensitive: true }), '/config').disabled, true);
    assert.strictEqual(uploadTarget(dir('/config/deps'), '/config').disabled, true);
    assert.strictEqual(uploadTarget(dir('/config/deps/lib'), '/config').disabled, true);
    assert.strictEqual(uploadTarget(dir('/config/Deps'), '/config').disabled, true);
    assert.strictEqual(uploadTarget(dir('/config/www/deps'), '/config').disabled, false);
    const inbox = uploadTarget(dir('/config/uploads'), '/config');
    assert.strictEqual(inbox.disabled, false);
    assert.match(inbox.hint, /upload_retention_days/);
    assert.strictEqual(uploadTarget(dir('/config/www/uploads'), '/config').hint, '');
});

test('uploadErrorText: the server\'s message, else one for the status', () => {
    assert.strictEqual(uploadErrorText(413, { error: 'This file is 30.0 MB, over the 25 MB upload limit.' }, 'big.bin'),
        'big.bin: This file is 30.0 MB, over the 25 MB upload limit.');
    assert.match(uploadErrorText(413, {}, 'big.bin'), /upload_max_mb/);
    assert.match(uploadErrorText(0, {}, 'a.txt'), /Could not reach the add-on to upload a\.txt/);
    assert.strictEqual(uploadErrorText(502, null, 'a.txt'), 'a.txt: upload failed (HTTP 502).');
    // A message that already names the file is not prefixed with it again.
    assert.strictEqual(uploadErrorText(400, { error: 'x.git ends in .git, a name the Files sidebar never shows, so it cannot be uploaded.' }, 'x.git'),
        'x.git ends in .git, a name the Files sidebar never shows, so it cannot be uploaded.');
    // A Replace that overwrote the old file and then lost the upload says
    // so as the server words it, never as "nothing was saved".
    const overwritten = 'old.txt in /config/dir was overwritten, but what is there now is not the upload: '
        + 'it was moved or replaced as it was put in place. The previous old.txt is gone.';
    assert.strictEqual(uploadErrorText(409, { reason: 'changed', replaced: true, error: overwritten }, 'old.txt'), overwritten);
    // Names from the device are shown without the marks that reorder text.
    assert.strictEqual(uploadErrorText(502, null, 'photo\u202Egpj.exe'), 'photogpj.exe: upload failed (HTTP 502).');
});

test('displayName: strips control characters and the bidi marks the server strips', () => {
    assert.strictEqual(displayName('photo\u202Egpj.exe'), 'photogpj.exe');
    assert.strictEqual(displayName('a\u200eb\u200fc\u202ad\u202be\u202cf\u202dg\u2066h\u2067i\u2068j\u2069k\ufeffl'), 'abcdefghijkl');
    assert.strictEqual(displayName('tab\there\nnew\u0085line\u007f'), 'tabherenewline');
    assert.strictEqual(displayName('café ünï 日本.txt'), 'café ünï 日本.txt');
});

test('uploadSummary: one line per kind of outcome, in order, and its kind', () => {
    const r = (name, extra = {}) => ({ name, dir: '/config/uploads', path: '/config/uploads/' + name, ...extra });
    assert.deepStrictEqual(uploadSummary({ results: [r('a.txt')] }),
        { lines: ['Uploaded a.txt to /config/uploads.'], kind: '' });
    assert.deepStrictEqual(uploadSummary({ results: [r('a.txt', { replaced: true, dir: '/config/x' })] }).lines,
        ['Replaced a.txt in /config/x.']);
    assert.deepStrictEqual(uploadSummary({ results: [r('a'), r('b')], skipped: ['c', 'd\u202E'] }),
        { lines: ['Uploaded 2 files to /config/uploads.', 'Not uploaded: c, d.'], kind: '' });
    // A drop of folders and files: the folders are named, not silently dropped.
    assert.deepStrictEqual(uploadSummary({ results: [r('a')], folders: ['photos', 'docs'] }).lines,
        ['Uploaded a to /config/uploads.', 'Folders are not uploaded: photos, docs. Drop the files inside them instead.']);
    // A 429 stops the batch: one line for everything it left, not one per file.
    assert.deepStrictEqual(uploadSummary({ results: [r('a')], busy: ['b', 'c', 'd'] }),
        { lines: ['Uploaded a to /config/uploads.', '⏳ 3 not uploaded: too many uploads, try again in a minute.'], kind: 'busy' });
    assert.deepStrictEqual(uploadSummary({ busy: ['only.txt'] }).lines,
        ['⏳ only.txt not uploaded: too many uploads, try again in a minute.']);
    assert.deepStrictEqual(uploadSummary({ problems: ['x: nope.'], busy: ['b'] }),
        { lines: ['⚠️ x: nope.', '⏳ b not uploaded: too many uploads, try again in a minute.'], kind: 'error' });
    assert.deepStrictEqual(uploadSummary({}), { lines: [], kind: '' });
});
