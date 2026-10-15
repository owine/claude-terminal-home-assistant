// Integration test: mouse ownership and clipboard delivery, in a real browser
// against a real tmux - plus the Files sidebar, which resizes the terminal
// iframe and so has to be proven not to disturb either.
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
//   python3 tests/stub-supervisor.py &   # no Supervisor outside HA
//   docker run -d --name ctp -p 7680:7680 \
//     -e SUPERVISOR_API=http://host.docker.internal:8099 \
//     --add-host=host.docker.internal:host-gateway local/ctp
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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// Two distinct "images" for the upload button to pick. The server trusts the
// declared type, which the browser derives from the .png extension, so the
// bytes only have to differ -- that difference is the whole point.
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const PNG_A = Buffer.concat([PNG_SIGNATURE, Buffer.from('first')]);
const PNG_B = Buffer.concat([PNG_SIGNATURE, Buffer.from('second')]);
const PICK_DIR = mkdtempSync(join(tmpdir(), 'ctp-upload-'));

// Files sidebar fixture, inside the container's /config. The file name has a
// space so Insert path has something to quote.
const SIDEBAR_DIR = '/config/ctp-sidebar-fixture';
const SIDEBAR_FILE = 'with space.yaml';

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

// A slow answer for a view the user already left must not land. Recent is
// held for 2.5 s while Files is clicked; before the fix the Recent rows then
// overwrote the tree with the Files tab still selected.
//
// Its own context with service workers blocked: a request the service worker
// fetches is invisible to page.route, so with it running the delay never
// applied and this check passed against the broken code.
async function checkStaleView(browser, url) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    try {
        await page.goto(url, { waitUntil: 'load' });
        const wrapper = await wrapperFrame(page);
        await wrapper.locator('#files-btn').click();
        const folderRow = wrapper.locator('#files-list .files-row', { hasText: SIDEBAR_DIR.split('/').pop() });
        await waitFor(async () => (await folderRow.count()) === 1);

        let held = 0;
        await page.route('**/api/files/recent*', async (route) => {
            held++;
            await sleep(2500);
            await route.continue().catch(() => {});
        });
        await wrapper.locator('.files-tab[data-tab="recent"]').click();
        await sleep(200);
        await wrapper.locator('.files-tab[data-tab="files"]').click();
        await sleep(3500);
        check('fixture: the Recent request was held back', held, (n) => n >= 1);
        check('a slow Recent answer does not overwrite the Files tree',
            await wrapper.evaluate(`JSON.stringify({
                filesSelected: document.querySelector('.files-tab[data-tab="files"]').getAttribute('aria-selected'),
                recentRows: [...document.querySelectorAll('#files-list .files-meta')]
                    .filter((m) => /ago|just now/.test(m.textContent)).length,
            })`), JSON.stringify({ filesSelected: 'true', recentRows: 0 }));
        check('the tree is still there after the stale answer', await folderRow.count(), 1);
    } finally {
        await context.close();
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

    await wrapper.evaluate('document.getElementById("clipboard-btn").click()');

    if (engine === chromium) {
        // Poll the clipboard rather than sleeping. The click handler clears the
        // indicator SYNCHRONOUSLY and then awaits the write, so a cleared
        // indicator is not evidence the write finished -- waiting on it would
        // just be a sleep with extra steps.
        //
        // Gated on `delivered`, and that gate is load-bearing. With tmux's mouse
        // off the same drag becomes an xterm selection, which ttyd auto-copies
        // to the clipboard -- so an ungated readback saw digits and passed while
        // tmux had delivered nothing. A negative control caught it. Reading the
        // clipboard only proves something copied, never who copied it.
        let dragged = '(never read)';
        if (delivered) {
            await waitFor(async () => {
                dragged = await wrapper.evaluate('navigator.clipboard.readText()');
                return dragged !== SEED_TEXT && /\d/.test(dragged);
            });
        } else {
            dragged = '(tmux delivered nothing; clipboard content proves nothing)';
        }
        check('the dragged text is what landed on the clipboard', dragged,
            (t) => delivered && typeof t === 'string' && /\d/.test(t) && t !== SEED_TEXT);
    } else {
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
    check('clicking the clipboard button clears the unread indicator',
        await waitFor(async () => !(await unread())), true);
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

    // 5. A second image picked through the upload button must upload too. The
    //    file input used to keep its last selection, and both engines compare a
    //    new pick against it by PATH: one at the same path fires `cancel`, not
    //    `change`, so the handler never ran and the button looked dead until a
    //    reload. Orion on macOS did this with two different images, so a picker
    //    can hand back one path for two files -- rewriting one path with new
    //    bytes between picks is that case exactly.
    //
    //    Two uploads per run, eight per suite, against the server's limit of
    //    ten a minute, which every run shares. Mind it before adding picks.
    let uploaded = 0;
    page.on('response', (r) => {
        if (r.request().method() === 'POST'
            && new URL(r.url()).pathname.endsWith('/upload') && r.ok()) uploaded++;
    });
    const pickPath = join(PICK_DIR, 'pick.png');
    for (const [i, image] of [PNG_A, PNG_B].entries()) {
        writeFileSync(pickPath, image);
        const [chooser] = await Promise.all([
            page.waitForEvent('filechooser'),
            wrapper.locator('#upload-btn').click(),
        ]);
        await chooser.setFiles(pickPath);
        await waitFor(() => uploaded > i);
    }
    check('a second image picked at the same path still uploads', uploaded, 2);

    // 6. The Files sidebar. It narrows the terminal iframe, so what matters
    //    most is that the terminal follows (xterm AND tmux resize) and that
    //    the wheel still reaches tmux with the sidebar open. The fixture is
    //    made through docker exec, like every other terminal-side state here.
    await resetPane();
    dexec(['rm', '-rf', SIDEBAR_DIR]);
    dexec(['mkdir', '-p', SIDEBAR_DIR]);
    dexec(['sh', '-c', 'printf "sidebar: ok\\n" > "$1"; printf "k: v\\n" > "$2"; '
        + 'mkdir "$3"; printf "ref: x\\n" > "$3/HEAD"; printf partial > "$4"', 'sh',
        `${SIDEBAR_DIR}/${SIDEBAR_FILE}`, `${SIDEBAR_DIR}/secrets.yaml`,
        `${SIDEBAR_DIR}/.git`, `${SIDEBAR_DIR}/download.part`]);

    const cols = () => wrapper.evaluate(`${TERM}.cols`);
    const windowWidth = () => Number(tmux('#{window_width}'));
    const sidebarOpen = () => wrapper.evaluate(
        '!document.getElementById("files-sidebar").classList.contains("collapsed")');
    const colsClosed = await cols();
    const tmuxClosed = windowWidth();

    await wrapper.locator('#files-btn').click();
    check('the Files button opens the sidebar', await waitFor(sidebarOpen), true);
    check('opening the sidebar refits xterm and tmux',
        await waitFor(async () => (await cols()) < colsClosed && windowWidth() < tmuxClosed), true);
    const colsOpen = await cols();

    // Hidden files on, so a missing .git is the server's doing, not the
    // client's dotfile filter.
    await wrapper.locator('#files-show-hidden').check();
    const list = wrapper.locator('#files-list');
    const folderRow = list.locator('.files-row', { hasText: SIDEBAR_DIR.split('/').pop() });
    check('the tree lists /config', await waitFor(async () => (await folderRow.count()) === 1), true);
    await folderRow.click();
    const fileRow = list.locator('.files-row', { hasText: SIDEBAR_FILE });
    check('a folder expands to its files', await waitFor(async () => (await fileRow.count()) === 1), true);
    const names = await list.locator('.files-name').allTextContents();
    check('the tree hides .git and *.part, and shows secrets.yaml',
        { git: names.includes('.git'), part: names.includes('download.part'), secrets: names.includes('secrets.yaml') },
        (v) => !v.git && !v.part && v.secrets);

    await fileRow.click();
    const previewBody = () => wrapper.evaluate(
        'document.getElementById("files-preview").classList.contains("active") '
        + '&& document.getElementById("files-preview-body").textContent');
    check('clicking a file previews it as text',
        await waitFor(async () => (await previewBody()) === 'sidebar: ok\n'), true);

    // Typed at the prompt, quoted, and NOT submitted: the line is still the
    // last thing on screen and bash has not tried to run it.
    await wrapper.locator('#files-insert-btn').click();
    const quoted = `'${SIDEBAR_DIR}/${SIDEBAR_FILE}'`;
    const promptLine = () => dexec(['tmux', 'capture-pane', '-p']).trimEnd().split('\n').pop();
    check('Insert path types the quoted path at the prompt',
        await waitFor(() => promptLine().endsWith(quoted)), true);
    await sleep(500);
    check('Insert path does not press Enter', promptLine().endsWith(quoted), true);
    sendKeys('C-u');

    const openBox = await wrapper.locator('#terminal-frame').boundingBox();
    await page.mouse.move(openBox.x + openBox.width / 2, openBox.y + openBox.height / 2);
    for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, -120);
        await sleep(150);
    }
    check('with the sidebar open, the wheel still scrolls tmux history',
        await waitFor(() => Number(tmux('#{scroll_position}')) > 0), true);
    cancelCopyMode();

    // Drag the left edge 120px to the left: wider sidebar, narrower terminal,
    // and nothing left behind that would keep the pointer from the iframe.
    const sidebarWidth = () => wrapper.evaluate(
        'document.getElementById("files-sidebar").getBoundingClientRect().width');
    const widthBefore = await sidebarWidth();
    const colsBeforeDrag = await cols();
    const handle = await wrapper.locator('#files-resizer').boundingBox();
    const grip = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(grip.x - 120, grip.y, { steps: 12 });
    await page.mouse.up();
    check('dragging the edge resizes the sidebar',
        Math.round((await sidebarWidth()) - widthBefore), (d) => d >= 100 && d <= 140);
    check('resizing refits the terminal',
        await waitFor(async () => (await cols()) < colsBeforeDrag), true);
    check('a finished drag gives the iframe the pointer back',
        await wrapper.evaluate(`JSON.stringify({
            resizing: document.body.classList.contains('files-resizing'),
            pointer: getComputedStyle(document.getElementById('terminal-frame')).pointerEvents,
        })`), JSON.stringify({ resizing: false, pointer: 'auto' }));
    // Guards on the drag itself, driven with synthetic pointer events: a
    // second pointerdown mid-drag must not orphan the first drag's move
    // listener, and the page going hidden must end a drag.
    check('a second pointerdown mid-drag leaves nothing following the pointer',
        await wrapper.evaluate(`(() => {
            const r = document.getElementById('files-resizer');
            const sb = document.getElementById('files-sidebar');
            const box = r.getBoundingClientRect();
            const ev = (type, id, dx) => new PointerEvent(type, { pointerId: id, button: 0, bubbles: true,
                clientX: box.left + dx, clientY: box.top + 50 });
            r.dispatchEvent(ev('pointerdown', 21, 0));
            r.dispatchEvent(ev('pointerdown', 22, 0));
            window.dispatchEvent(ev('pointermove', 21, -40));
            window.dispatchEvent(ev('pointerup', 21, -40));
            const after = sb.getBoundingClientRect().width;
            window.dispatchEvent(ev('pointermove', 21, -140));
            return JSON.stringify({ follows: sb.getBoundingClientRect().width !== after,
                resizing: document.body.classList.contains('files-resizing') });
        })()`), JSON.stringify({ follows: false, resizing: false }));
    check('the page going hidden ends a drag',
        await wrapper.evaluate(`(() => {
            const r = document.getElementById('files-resizer');
            const sb = document.getElementById('files-sidebar');
            const box = r.getBoundingClientRect();
            const ev = (type, dx) => new PointerEvent(type, { pointerId: 31, button: 0, bubbles: true,
                clientX: box.left + dx, clientY: box.top + 50 });
            r.dispatchEvent(ev('pointerdown', 0));
            Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));
            delete document.visibilityState;
            const after = sb.getBoundingClientRect().width;
            window.dispatchEvent(ev('pointermove', -100));
            return JSON.stringify({ follows: sb.getBoundingClientRect().width !== after,
                resizing: document.body.classList.contains('files-resizing') });
        })()`), JSON.stringify({ follows: false, resizing: false }));

    check('open state and width are remembered',
        await wrapper.evaluate(`JSON.stringify([localStorage.getItem('filesSidebar.open'),
            Number(localStorage.getItem('filesSidebar.width')) > 300])`), JSON.stringify(['1', true]));

    await wrapper.locator('#files-hide').click();
    // Not compared with the width at load: ttyd under-fits on first load (a
    // column count ~20 short of what fits) until its first resize event, on
    // main as well, so the closed width can legitimately be the larger one.
    const widthBack = async () => (await cols()) > colsOpen && windowWidth() === (await cols());
    await waitFor(widthBack);
    check('hiding the sidebar gives the terminal its width back, in xterm and tmux',
        { cols: await cols(), tmux: windowWidth(), colsOpen }, (v) => v.cols > v.colsOpen && v.tmux === v.cols);

    await checkStaleView(browser, url);
    dexec(['rm', '-rf', SIDEBAR_DIR]);

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
    rmSync(PICK_DIR, { recursive: true, force: true });
    try { dexec(['rm', '-rf', SIDEBAR_DIR]); } catch { /* container gone */ }
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
