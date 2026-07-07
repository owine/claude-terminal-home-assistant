'use strict';

const assert = require('node:assert');
const { reconstructLoginUrl, isAuthUrl, isPasteBackPrompt } = require('../public/login-link.js');

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`ok - ${name}`);
    } catch (err) {
        console.error(`FAIL - ${name}`);
        console.error(err.message);
        process.exitCode = 1;
    }
}

// --- reconstructLoginUrl ---

test('bare single-line URL', () => {
    const rows = [
        'Browser did not open. Visit:',
        'https://claude.ai/oauth/authorize?code=true&client_id=abc123&scope=read',
        '',
    ];
    assert.strictEqual(
        reconstructLoginUrl(rows),
        'https://claude.ai/oauth/authorize?code=true&client_id=abc123&scope=read'
    );
});

test('Ink hard-wrapped multi-line URL (the real case)', () => {
    // No trailing spaces; Ink emits a hard newline mid-token.
    const rows = [
        'https://platform.claude.com/oauth/authorize?code=true&client_i',
        'd=9d1c&scope=org%3Acreate_api_key&state=xyz789',
        '',
        'Paste code here if prompted:',
    ];
    assert.strictEqual(
        reconstructLoginUrl(rows, 62),
        'https://platform.claude.com/oauth/authorize?code=true&client_id=9d1c&scope=org%3Acreate_api_key&state=xyz789'
    );
});

test('boxed-with-borders rendering', () => {
    const rows = [
        '╭──────────╮',
        '│ https://claude.com/cai/oauth/authorize?code=true&clien │',
        '│ t_id=abcd&state=q1w2                                    │',
        '╰──────────╯',
    ];
    assert.strictEqual(
        reconstructLoginUrl(rows),
        'https://claude.com/cai/oauth/authorize?code=true&client_id=abcd&state=q1w2'
    );
});

test('decoy non-auth URL must NOT match', () => {
    const rows = [
        'See the docs at https://docs.claude.com/en/docs/claude-code for help.',
        'Also https://example.com/oauth/authorize?foo=bar is not ours.',
    ];
    assert.strictEqual(reconstructLoginUrl(rows), null);
});

test('no URL present returns null', () => {
    assert.strictEqual(reconstructLoginUrl(['just some output', 'no link here']), null);
});

test('does NOT splice a following space-free line into a complete URL', () => {
    // A complete URL alone on its row, followed by a short space-free banner
    // line. With no terminal width and no box borders, we must NOT join.
    const rows = [
        'https://claude.ai/oauth/authorize?code=1&client_id=2',
        'Anthropic-PBC-2026',
        '',
    ];
    assert.strictEqual(
        reconstructLoginUrl(rows),
        'https://claude.ai/oauth/authorize?code=1&client_id=2'
    );
});

test('finds the auth URL when a decoy https link precedes it on the same row', () => {
    const rows = [
        'docs at https://docs.claude.com/x see also https://claude.ai/oauth/authorize?code=1',
    ];
    assert.strictEqual(
        reconstructLoginUrl(rows),
        'https://claude.ai/oauth/authorize?code=1'
    );
});

// --- isAuthUrl ---

test('isAuthUrl accepts each known host', () => {
    assert.ok(isAuthUrl('https://claude.ai/oauth/authorize?x=1'));
    assert.ok(isAuthUrl('https://platform.claude.com/oauth/authorize?x=1'));
    assert.ok(isAuthUrl('https://console.anthropic.com/oauth/authorize?x=1'));
    assert.ok(isAuthUrl('https://claude.com/cai/oauth/authorize?x=1'));
});

test('isAuthUrl rejects non-auth', () => {
    assert.ok(!isAuthUrl('https://docs.claude.com/en/docs'));
    assert.ok(!isAuthUrl('https://example.com/oauth/authorize'));
    assert.ok(!isAuthUrl('http://claude.ai/oauth/authorize')); // must be https
});

// --- isPasteBackPrompt ---

test('isPasteBackPrompt detects the leg-2 prompt', () => {
    assert.ok(isPasteBackPrompt('Paste code here if prompted > ')); // primary: auth code
    assert.ok(isPasteBackPrompt("paste the URL from your browser's address bar:")); // fallback
    assert.ok(isPasteBackPrompt('URL > '));
});

test('isPasteBackPrompt ignores unrelated text', () => {
    assert.ok(!isPasteBackPrompt('Enter your name:'));
});

console.log(`\n${passed} passed`);
