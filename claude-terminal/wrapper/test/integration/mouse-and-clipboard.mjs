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
    for (let i = 0; i < 50; i++) {
        if (/^(ba)?sh$/.test(tmux('#{pane_current_command}'))) break;
        await sleep(100);
    }
    typeLine('clear; seq 300');
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

async function run(engine, mode, url) {
    console.log(`\n=== ${engine.name()} / ${mode} ===`);
    await resetPane();
    await sleep(2000);
    check('fixture: pane has scrollback to scroll through',
        Number(tmux('#{history_size}')), (v) => v > 100);

    const browser = await engine.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load' });
    const wrapper = await wrapperFrame(page);
    await sleep(2500);

    // 1. Mouse reporting is on with NO interaction. The old design required a
    //    button press and lost a race doing it; there is nothing left to press,
    //    so tracking must simply be on once the page settles.
    check('mouse tracking is active on load, with no interaction',
        await wrapper.evaluate(`${TERM}.modes.mouseTrackingMode`), 'drag');

    // 2. A real wheel gesture must reach tmux. Asserting on tmux's own
    //    scroll_position rather than on the bytes xterm emitted: the bytes
    //    being correct was never the part that broke.
    await page.mouse.move(400, 300);
    for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, -120);
        await sleep(150);
    }
    await sleep(500);
    check('wheel scrolls tmux history', Number(tmux('#{scroll_position}')), (v) => v > 0);
    check('wheel puts the pane in copy-mode', tmux('#{pane_in_mode}'), '1');
    cancelCopyMode();
    await sleep(500);

    // 3. Selection must still be possible WHILE mouse reporting is on. This is
    //    the capability the deleted DECSET veto existed to provide, now handled
    //    by xterm's own force-selection modifier: Option on macOS (which needs
    //    macOptionClickForcesSelection set), Shift everywhere else.
    //    Dragging down the left edge, where `seq` puts the digits.
    const modifier = process.platform === 'darwin' ? 'Alt' : 'Shift';
    await page.keyboard.down(modifier);
    await page.mouse.move(12, 150);
    await page.mouse.down();
    await page.mouse.move(140, 320, { steps: 15 });
    await page.mouse.up();
    await page.keyboard.up(modifier);
    await sleep(500);
    check(`${modifier}+drag selects real text while tracking is on`,
        await wrapper.evaluate(`${TERM}.getSelection()`), (s) => /\d/.test(s || ''));

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

    // Poll rather than read once. The status bar clears itself on a timer, so a
    // single read at a fixed offset is a race — it reported a false failure
    // before this was a loop.
    let status = '';
    for (let i = 0; i < 25 && !/copied|clipboard/i.test(status); i++) {
        await sleep(200);
        status = await wrapper.evaluate('document.getElementById("status")?.textContent || ""');
    }
    check('OSC 52 write is acknowledged by the wrapper', status,
        (s) => /copied|clipboard/i.test(s));

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
