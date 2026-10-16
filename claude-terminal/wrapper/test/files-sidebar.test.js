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
