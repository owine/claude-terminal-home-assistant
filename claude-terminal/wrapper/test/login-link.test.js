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

// The shape Claude Code builds (2.1.332): code, client_id, response_type,
// redirect_uri, scope, code_challenge, code_challenge_method, state, in that
// order, all unconditional. Values here are placeholders.
const QUERY =
    'code=true&client_id=9d1c0000-test&response_type=code' +
    '&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback' +
    '&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference' +
    '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256' +
    '&state=q1w2e3r4t5y6';
const CLAUDE_AI = `https://claude.ai/oauth/authorize?${QUERY}`;
const PLATFORM = `https://platform.claude.com/oauth/authorize?${QUERY}`;
const CAI = `https://claude.com/cai/oauth/authorize?${QUERY}`;

// Split a URL into rows of `width` characters, as Ink hard-wraps it.
function wrap(url, width) {
    const rows = [];
    for (let i = 0; i < url.length; i += width) rows.push(url.slice(i, i + width));
    return rows;
}

// --- reconstructLoginUrl ---

test('bare single-line URL', () => {
    const rows = ['Browser did not open. Visit:', CLAUDE_AI, ''];
    assert.strictEqual(reconstructLoginUrl(rows), CLAUDE_AI);
});

test('Ink hard-wrapped multi-line URL (the real case)', () => {
    // No trailing spaces; Ink emits a hard newline mid-token.
    const rows = [...wrap(PLATFORM, 62), '', 'Paste code here if prompted:'];
    assert.ok(rows.length >= 4, 'fixture wraps over several rows');
    assert.strictEqual(reconstructLoginUrl(rows, 62), PLATFORM);
});

test('boxed-with-borders rendering', () => {
    const inner = wrap(CAI, 54);
    const rows = [
        '╭──────────╮',
        ...inner.map((r) => `│ ${r.padEnd(54)} │`),
        '╰──────────╯',
    ];
    assert.strictEqual(reconstructLoginUrl(rows), CAI);
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
    const rows = [CLAUDE_AI, 'Anthropic-PBC-2026', ''];
    assert.strictEqual(reconstructLoginUrl(rows), CLAUDE_AI);
});

test('finds the auth URL when a decoy https link precedes it on the same row', () => {
    const rows = [`docs at https://docs.claude.com/x see also ${CLAUDE_AI}`];
    assert.strictEqual(reconstructLoginUrl(rows), CLAUDE_AI);
});

// --- truncated captures are not a login link ---

test('a wrapped URL whose later rows are missing is rejected', () => {
    // The first row alone: the pane cut short, or no width to join by.
    const rows = wrap(PLATFORM, 62);
    assert.strictEqual(reconstructLoginUrl([rows[0], '', 'Paste code here if prompted:'], 62), null);
    assert.strictEqual(reconstructLoginUrl([...rows.slice(0, -1), ''], 62), null, 'all but the last row');
    assert.strictEqual(reconstructLoginUrl(rows), null, 'no width, no border: rows are not joined');
});

test('a URL elided with an ellipsis is rejected', () => {
    const rows = wrap(PLATFORM, 62);
    // On its own row...
    assert.strictEqual(reconstructLoginUrl([`${PLATFORM.slice(0, 70)}…`]), null);
    assert.strictEqual(reconstructLoginUrl([`${PLATFORM}…`]), null, 'even after a complete-looking URL');
    // ...or on the row the wrap continues to.
    assert.strictEqual(reconstructLoginUrl([...rows.slice(0, -1), `${rows.at(-1).slice(0, 3)}…`], 62), null);
    // ...or inside a box.
    assert.strictEqual(reconstructLoginUrl([`│ ${PLATFORM}… │`]), null);
});

test('a URL cut off by the end of the capture, part-way through state, is rejected', () => {
    // A width at which the last row holds only the tail of the state value,
    // so every row before it still parses with a non-empty state.
    const stateAt = PLATFORM.indexOf('state=') + 'state='.length;
    let width = 0;
    for (let w = 40; w <= 90 && !width; w++) {
        const tail = PLATFORM.length % w;
        if (tail > 0 && PLATFORM.length - tail > stateAt) width = w;
    }
    assert.ok(width, 'fixture: a width that splits the state value');
    const rows = wrap(PLATFORM, width);
    const prefix = rows.slice(0, -1).join('');
    assert.ok(isAuthUrl(prefix), 'the prefix alone passes the parameter check');
    // tmux capture-pane ends with a newline, leaving one empty string.
    assert.strictEqual(reconstructLoginUrl([...rows.slice(0, -1), ''], width), null, 'capture ends after it');
    assert.strictEqual(reconstructLoginUrl(rows.slice(0, -1), width), null, 'no row after it at all');
    // The whole URL, followed by what the login screen shows next, still passes.
    assert.strictEqual(reconstructLoginUrl([...rows, '', 'Paste code here if prompted >', ''], width), PLATFORM);
});

test('an incomplete URL on screen does not hide a complete one after it', () => {
    const rows = [wrap(CAI, 40)[0], '', CAI, '', 'Paste code here if prompted >'];
    assert.strictEqual(reconstructLoginUrl(rows), CAI);
});

// --- isAuthUrl ---

test('isAuthUrl accepts each known host', () => {
    assert.ok(isAuthUrl(CLAUDE_AI));
    assert.ok(isAuthUrl(PLATFORM));
    assert.ok(isAuthUrl(`https://console.anthropic.com/oauth/authorize?${QUERY}`));
    assert.ok(isAuthUrl(CAI));
});

test('isAuthUrl rejects non-auth', () => {
    assert.ok(!isAuthUrl('https://docs.claude.com/en/docs'));
    assert.ok(!isAuthUrl(`https://example.com/oauth/authorize?${QUERY}`));
    assert.ok(!isAuthUrl(`http://claude.ai/oauth/authorize?${QUERY}`)); // must be https
    assert.ok(!isAuthUrl(`https://claude.ai/oauth/authorize-other?${QUERY}`));
    assert.ok(!isAuthUrl(undefined));
});

test('isAuthUrl requires every parameter the login needs, non-empty', () => {
    for (const name of ['client_id', 'response_type', 'redirect_uri', 'code_challenge', 'state']) {
        const params = new URLSearchParams(QUERY);
        params.delete(name);
        assert.ok(!isAuthUrl(`${CLAUDE_AI.split('?')[0]}?${params}`), `without ${name}`);
        params.append(name, '');
        params.append('code_challenge_method', 'S256'); // keep the URL from ending in '='
        assert.ok(!isAuthUrl(`${CLAUDE_AI.split('?')[0]}?${params}`), `with an empty ${name}`);
    }
    assert.ok(!isAuthUrl('https://claude.ai/oauth/authorize?x=1'), 'no parameters at all');
});

test('isAuthUrl accepts the optional parameters after state', () => {
    assert.ok(isAuthUrl(`${CLAUDE_AI}&orgUUID=0000&login_hint=a%40b.c&login_method=sso`));
});

test('isAuthUrl rejects a URL cut short', () => {
    for (const suffix of ['...', '…', '%', '%2', '&', '=', '&login_hint=']) {
        assert.ok(!isAuthUrl(CLAUDE_AI + suffix), JSON.stringify(suffix));
    }
    assert.ok(!isAuthUrl(CLAUDE_AI.slice(0, CLAUDE_AI.indexOf('&state='))), 'cut before state');
    assert.ok(!isAuthUrl(`${CLAUDE_AI.slice(0, CLAUDE_AI.indexOf('&state='))}&state=`), 'cut after state=');
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
