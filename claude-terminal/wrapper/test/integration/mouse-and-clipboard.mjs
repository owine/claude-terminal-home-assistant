// Integration test: mouse ownership and clipboard delivery, in a real browser
// against a real tmux.
//
// This exists because the unit tests cannot see any of it. Three consecutive
// releases shipped a broken mouse mode while every unit test passed: the bugs
// lived in the wiring between the browser, xterm.js, ttyd and tmux, which no
// pure-logic test touches. Everything asserted here was, at some point, broken
// in a way that looked fine in CI.
//
// Not part of `npm test` — it needs a running container and real browser
// engines, neither of which CI has. Run it locally:
//
//   docker build --build-arg BUILD_FROM=ghcr.io/home-assistant/base:3.24 \
//     -t local/ctp ./claude-terminal
//   docker run -d --name ctp -p 7680:7680 -p 7681:7681 local/ctp
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright && npx playwright install webkit chromium
//   CTP_PLAYWRIGHT=/tmp/pw/node_modules/playwright/index.mjs \
//     node claude-terminal/wrapper/test/integration/mouse-and-clipboard.mjs
//
// Every engine runs against BOTH access paths: the direct :7680 port, and an
// ingress-shaped harness that serves the wrapper under a path prefix inside a
// nested iframe (see ingress-harness.mjs). Ingress is how the add-on is
// actually used, and a direct-port test cannot see relative-URL or nested-frame
// problems at all. Both WebKit and Chromium run, because a Safari-only failure
// is what sent the last investigation down a blind alley.
//
// Terminal state is set up through tmux, never by typing into the browser.
// Driving the shell through the page couples every assertion to the input path,
// and an earlier version of this file reported five failures that were really
// one mistyped shell command.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { startIngress } from './ingress-harness.mjs';

// Playwright is deliberately NOT a devDependency: CI cannot run this test (it
// needs a live container), so adding it would cost every CI install a download
// for nothing. Resolve it from wherever it happens to be installed instead.
const { webkit, chromium } = await import(process.env.CTP_PLAYWRIGHT || 'playwright');

const DIRECT_URL = process.env.CTP_URL || 'http://localhost:7680/';
const CONTAINER = process.env.CTP_CONTAINER || 'ctp';

let failures = 0;
function check(name, actual, expected) {
    const ok = typeof expected === 'function' ? expected(actual) : actual === expected;
    console.log(`${ok ? 'ok  ' : 'FAIL'} - ${name}${ok ? '' : `\n       got: ${JSON.stringify(actual)}`}`);
    if (!ok) failures++;
}

// execFileSync returns null when stdio is ignored, so guard the toString.
const dexec = (args, opts = {}) => {
    const out = execFileSync('docker', ['exec', CONTAINER, ...args], opts);
    return out ? out.toString() : '';
};

// tmux is the source of truth for anything that happened on its side; asking
// the browser what it *sent* would prove nothing about what tmux received.
const tmux = (fmt) => dexec(['tmux', 'display', '-p', fmt]).trim();
const sendKeys = (...keys) => dexec(['tmux', 'send-keys', ...keys], { stdio: 'ignore' });

// `send-keys` parses its arguments as key NAMES, so a shell command with spaces
// arrives with the spaces eaten ("clear; seq 300" became "clear;seq300"). `-l`
// sends the string literally; Enter still has to go separately.
const typeLine = (text) => {
    dexec(['tmux', 'send-keys', '-l', text], { stdio: 'ignore' });
    sendKeys('Enter');
};

// `send-keys -X cancel` errors with "not in a mode" when the pane is not in
// copy-mode — the expected state whenever the wheel assertions failed. It must
// not abort the run: the checks after it are independent and worth reporting.
const cancelCopyMode = () => {
    try { dexec(['tmux', 'send-keys', '-X', 'cancel'], { stdio: 'ignore' }); }
    catch { /* not in a mode */ }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll for a condition instead of sleeping a guessed interval. Fixed delays
// here are not just slow, they are wrong in both directions: too short and the
// check reports a false failure (this file already did that once, reading the
// status bar at a fixed offset), too long and every run pays for the worst
// case. Returns whether the condition held before the deadline, so callers can
// assert on it rather than on a value read at an arbitrary moment.
async function waitFor(predicate, { timeout = 6000, interval = 150 } = {}) {
    for (let waited = 0; waited < timeout; waited += interval) {
        if (await predicate()) return true;
        await sleep(interval);
    }
    return predicate();
}

// The mouse-reporting requests an application makes, named so their intent is
// legible at the call site and so the enable/disable pair cannot drift apart.
// 1000 = press/release, 1006 = SGR encoding: exactly what Claude Code asks for.
const APP_TAKES_MOUSE = String.raw`printf '\033[?1000h\033[?1006h'`;
const APP_RELEASES_MOUSE = String.raw`printf '\033[?1000l\033[?1006l'`;

// Seeds a known value on the clipboard so a stale one cannot be mistaken for a
// fresh copy. Base64 of SEED_TEXT.
const SEED_TEXT = 'SEED-NOT-A-DRAG';
const SEED_CLIPBOARD = String.raw`printf '\033]52;c;U0VFRC1OT1QtQS1EUkFH\007'`;
const TERM = 'document.getElementById("terminal-frame").contentWindow.term';

// Leave the pane at a plain shell prompt with plenty of scrollback.
//
// respawn-pane rather than driving the add-on's session menu: the menu loops on
// invalid input ("Press Enter to continue...") and will happily eat the keys
// meant for the shell, which made this fixture non-deterministic. Replacing the
// pane outright is unambiguous, and nothing asserted below depends on how the
// pane was started. `seq 300` (one argument) is what busybox accepts.
async function resetPane() {
    cancelCopyMode();
    dexec(['tmux', 'respawn-pane', '-k', 'bash'], { stdio: 'ignore' });
    await waitFor(() => /^(ba)?sh$/.test(tmux('#{pane_current_command}')));
    typeLine('clear; seq 300');
    await waitFor(() => Number(tmux('#{history_size}')) > 100);
}

// Under ingress the wrapper is a child frame, so the document holding
// #terminal-frame is not the main frame. Locate it by capability rather than by
// URL, so the same code works for both access paths.
async function wrapperFrame(page) {
    for (let i = 0; i < 60; i++) {
        for (const frame of page.frames()) {
            try {
                if (await frame.evaluate(
                    '!!document.getElementById("terminal-frame")?.contentWindow?.term')) {
                    return frame;
                }
            } catch { /* frame is navigating */ }
        }
        await sleep(500);
    }
    throw new Error('wrapper frame with a live terminal never appeared');
}

// Written only when a combination actually fails. A red browser test is hard
// to reason about from log lines alone -- what the page looked like and what it
// logged are usually the whole answer -- but capturing them unconditionally
// would put megabytes of artifacts on every green run.
const ARTIFACTS = new URL('./artifacts/', import.meta.url).pathname;

async function saveArtifacts(page, consoleLog, name) {
    try {
        mkdirSync(ARTIFACTS, { recursive: true });
        await page.screenshot({ path: `${ARTIFACTS}${name}.png`, fullPage: true });
        writeFileSync(`${ARTIFACTS}${name}.log`, consoleLog.join('\n'));
        console.log(`       artifacts: ${name}.png, ${name}.log`);
    } catch (e) {
        console.log(`       could not save artifacts: ${e.message}`);
    }
}

async function run(engine, mode, url) {
    console.log(`\n=== ${engine.name()} / ${mode} ===`);
    const failuresBefore = failures;
    await resetPane();
    check('fixture: pane has scrollback to scroll through',
        Number(tmux('#{history_size}')), (v) => v > 100);

    const browser = await engine.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleLog = [];
    page.on('console', (m) => consoleLog.push(`${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => consoleLog.push(`pageerror: ${e.message}`));
    await page.goto(url, { waitUntil: 'load' });
    const wrapper = await wrapperFrame(page);
    await sleep(2500);

    // 0. The shell must be served with revalidation headers. cache-policy.js is
    //    unit-tested, but nothing there proves it is wired into express.static
    //    -- and an unwired policy is exactly the failure that shipped 2.7.0
    //    JavaScript against 2.7.1 HTML for a whole release. Assert on the
    //    response the browser actually receives, through whichever path it took.
    const base = wrapper.url().replace(/[^/]*$/, '');
    const cacheControl = async (path) =>
        (await fetch(base + path)).headers.get('cache-control');
    check('the HTML shell is served with revalidation',
        await cacheControl(''), 'no-cache');
    check('scripts are served with revalidation',
        await cacheControl('terminal-clipboard.js'), 'no-cache');
    check('the service worker is served with revalidation',
        await cacheControl('sw.js'), 'no-cache');
    check('icons stay cacheable, and never immutably',
        await cacheControl('icon-192.png'),
        (v) => v === 'public, max-age=86400');

    // Coordinates come from the terminal's own box, not fixed page positions:
    // under ingress the wrapper sits inside another iframe, so the same page
    // coordinates land somewhere different. `left` is deliberately a few pixels
    // in from the edge -- that column is where `seq` prints its digits, which is
    // a character-cell position and not a fraction of the viewport.
    // wrapper.locator, not page.locator: under ingress #terminal-frame lives in
    // the wrapper's frame and the main frame has no such element. boundingBox
    // still returns main-frame viewport coordinates, which is what page.mouse
    // wants, so the nesting is handled without adjusting anything by hand.
    const box = await wrapper.locator('#terminal-frame').boundingBox();
    const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const left = { x: box.x + 12, y: box.y + 60 };

    // 1. Mouse reporting is on with NO interaction. The old design required a
    //    button press and lost a race doing it; there is nothing left to press,
    //    so tracking must simply be on once the page settles.
    check('mouse tracking is active on load, with no interaction',
        await wrapper.evaluate(`${TERM}.modes.mouseTrackingMode`), 'drag');

    // 2. A real wheel gesture must reach tmux. Asserting on tmux's own
    //    scroll_position rather than on the bytes xterm emitted: the bytes
    //    being correct was never the part that broke.
    await page.mouse.move(mid.x, mid.y);
    for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, -120);
        await sleep(150);
    }
    check('wheel scrolls tmux history',
        await waitFor(() => Number(tmux('#{scroll_position}')) > 0), true);
    check('wheel puts the pane in copy-mode',
        await waitFor(() => tmux('#{pane_in_mode}') === '1'), true);
    cancelCopyMode();
    await sleep(500);

    // 2b. When an APPLICATION holds the mouse, tmux must hand the wheel to it
    //     rather than taking it for copy-mode. This is what makes the wheel
    //     scroll the Claude Code session instead of the shell output from
    //     before Claude Code started, and it is why no CLAUDE_CODE_DISABLE_MOUSE
    //     is set. Simulated with a bare DECSET rather than by running Claude
    //     Code, which would need credentials; what is being pinned here is
    //     tmux's routing, not any one application's behaviour.
    typeLine(APP_TAKES_MOUSE);
    check('an application can take the mouse from tmux',
        await waitFor(() => tmux('#{mouse_any_flag}') === '1'), true);
    const posBefore = Number(tmux('#{scroll_position}') || 0);
    await page.mouse.move(mid.x, mid.y);
    for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, -120);
        await sleep(150);
    }
    await sleep(500);
    check('tmux forwards the wheel to the application instead of scrolling itself',
        { inMode: tmux('#{pane_in_mode}'), moved: Number(tmux('#{scroll_position}') || 0) !== posBefore },
        (v) => v.inMode === '0' && v.moved === false);
    // The stand-in "application" is a bash prompt, so the wheel reports tmux
    // just forwarded arrived as keystrokes and are sitting in its input buffer.
    // Clear the line before typing, or the release command is appended to
    // escape-sequence garbage and never runs.
    sendKeys('C-c');
    await sleep(300);
    typeLine(APP_RELEASES_MOUSE);
    check('releasing the mouse gives tmux the wheel back',
        await waitFor(() => tmux('#{mouse_any_flag}') === '0'), true);

    // 3. Selection must still be possible WHILE mouse reporting is on. This is
    //    the capability the deleted DECSET veto existed to provide, now handled
    //    by xterm's own force-selection modifier: Option on macOS (which needs
    //    macOptionClickForcesSelection set), Shift everywhere else.
    //    Dragging down the left edge, where `seq` puts the digits.
    const modifier = process.platform === 'darwin' ? 'Alt' : 'Shift';
    await page.keyboard.down(modifier);
    await page.mouse.move(left.x, left.y);
    await page.mouse.down();
    await page.mouse.move(left.x + 128, left.y + 170, { steps: 15 });
    await page.mouse.up();
    await page.keyboard.up(modifier);
    await sleep(500);
    check(`${modifier}+drag selects real text while tracking is on`,
        await wrapper.evaluate(`${TERM}.getSelection()`), (s) => /\d/.test(s || ''));

    // 3b. The PRIMARY gesture, and the one this suite was missing: a plain drag
    //     with no modifier. tmux takes it, enters copy-mode, and its
    //     MouseDragEnd1Pane binding runs copy-selection-and-cancel, which emits
    //     OSC 52 to the browser. Every link in that chain was tested in
    //     isolation and none of it was ever tested as the thing a user does.
    //
    //     Seed the clipboard first so a stale value cannot be mistaken for a
    //     successful drag-copy.
    if (engine === chromium) {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    }
    const unreadNow = () => wrapper.evaluate(
        '!!document.getElementById("clipboard-btn")?.classList.contains("has-copy")');

    typeLine(SEED_CLIPBOARD);
    await waitFor(unreadNow);
    await wrapper.evaluate('document.getElementById("clipboard-btn").click()');
    // Wait for the indicator to actually clear, do not assume the click did it.
    // The seed's OSC 52 can land AFTER the click, leaving the indicator raised
    // and letting the drag check below pass without a drag -- observed as a
    // spurious pass in one of the four combinations under a negative control.
    check('fixture: the clipboard indicator starts clear before the drag',
        await waitFor(async () => !(await unreadNow())), true);

    await page.mouse.move(left.x, left.y);
    await page.mouse.down();
    await page.mouse.move(left.x + 128, left.y + 100, { steps: 15 });
    await page.mouse.up();

    const delivered = await waitFor(unreadNow);
    check('a plain drag copies through tmux and reaches the browser', delivered, true);

    if (engine === chromium) {
        await wrapper.evaluate('document.getElementById("clipboard-btn").click()');
        await sleep(400);
        // Gated on `delivered`, and that gate is load-bearing. With tmux's mouse
        // off the same drag becomes an xterm selection, which ttyd auto-copies
        // to the clipboard -- so an ungated readback saw digits and passed while
        // tmux had delivered nothing. A negative control caught it. Reading the
        // clipboard only proves something copied, never who copied it.
        const dragged = delivered
            ? await wrapper.evaluate('navigator.clipboard.readText()')
            : '(tmux delivered nothing; clipboard content proves nothing)';
        check('the dragged text is what landed on the clipboard', dragged,
            (t) => delivered && typeof t === 'string' && /\d/.test(t) && t !== SEED_TEXT);
    } else {
        await wrapper.evaluate('document.getElementById("clipboard-btn").click()');
        await sleep(400);
        console.log('skip  - drag-copy readback (no clipboard-read permission in WebKit)');
    }
    cancelCopyMode();

    // 4. OSC 52 still reaches the browser clipboard. The handler changed files
    //    in this refactor, so "unchanged" needs proving, not asserting.
    //    Base64 "Q0xJUEJPQVJELU9L" decodes to CLIPBOARD-OK.
    if (engine === chromium) {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    }
    await page.bringToFront();
    typeLine('clear');
    await sleep(800);
    typeLine(String.raw`printf '\033]52;c;Q0xJUEJPQVJELU9L\007'`);

    // The acknowledgement is the clipboard button's unread state, not status
    // text: the text auto-cleared after five seconds, so a copy you did not
    // happen to be looking at vanished silently. Poll rather than read once —
    // the write arrives asynchronously.
    const unread = () => wrapper.evaluate(
        '!!document.getElementById("clipboard-btn")?.classList.contains("has-copy")');
    let flagged = false;
    for (let i = 0; i < 25 && !flagged; i++) {
        await sleep(200);
        flagged = await unread();
    }
    check('OSC 52 write raises the clipboard button unread indicator', flagged, true);

    // The badge and the flash are visual only. Without an accessible name and
    // an announcement the arrival of a copy is undetectable without sight, and
    // the icon span is aria-hidden so the button would have no name at all.
    check('the unread state is exposed to assistive technology',
        await wrapper.evaluate(`JSON.stringify({
            label: document.getElementById('clipboard-btn').getAttribute('aria-label'),
            announced: document.getElementById('clipboard-announcer').textContent,
        })`),
        (v) => { const o = JSON.parse(v); return /copied/i.test(o.label) && /copied/i.test(o.announced); });

    // Clicking delivers the staged text and clears the indicator. On a secure
    // origin the automatic write has already succeeded, so this is a re-write
    // of the same text; the assertion is about the indicator being clearable,
    // which is the part a user can get stuck on.
    await wrapper.evaluate('document.getElementById("clipboard-btn").click()');
    await sleep(600);
    check('clicking the clipboard button clears the unread indicator',
        await unread(), false);
    check('acknowledging resets the accessible name and clears the announcement',
        await wrapper.evaluate(`JSON.stringify({
            label: document.getElementById('clipboard-btn').getAttribute('aria-label'),
            announced: document.getElementById('clipboard-announcer').textContent,
        })`),
        (v) => { const o = JSON.parse(v); return /nothing copied/i.test(o.label) && o.announced === ''; });

    // Read the clipboard back from the wrapper frame — the same context that
    // wrote it, which is the part that matters when that context is a nested
    // iframe. WebKit has no clipboard-read permission in Playwright, so this is
    // Chromium-only rather than a skipped assertion pretending to be a pass.
    if (engine === chromium) {
        check('OSC 52 text actually lands on the clipboard',
            await wrapper.evaluate('navigator.clipboard.readText()'), 'CLIPBOARD-OK');
    } else {
        console.log('skip  - clipboard readback (no clipboard-read permission in WebKit)');
    }

    if (failures > failuresBefore) {
        await saveArtifacts(page, consoleLog, `${engine.name()}-${mode}`);
    }
    await browser.close();
}

const ingress = await startIngress();
try {
    for (const engine of [webkit, chromium]) {
        for (const [mode, url] of [['direct', DIRECT_URL], ['ingress', ingress.url]]) {
            await run(engine, mode, url);
        }
    }
} finally {
    ingress.close();
    cancelCopyMode();
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
