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
//   # the zip checks read archives with the host's python3 (zipfile module)
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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// The server's zip limiter: 20 requests per sliding minute, keyed by client
// address. Every request here comes from this host, so all four runs (both
// engines, direct and ingress) share one bucket, and they follow each other
// within seconds. Without a budget, whether a late zip check met a real 429
// depended on how fast the runs before it went. So every REAL request the
// limiter counts (a check=1 preflight, a zip GET, a direct fetch) first
// takes its share here, waiting until the last 61 s (a second's slack for
// the server's later clock) leave room. Routed fakes never reach the
// server and take none. The limiter itself stays as shipped.
// Must match zipLimiter's max in server.js; if that changes, change this.
const ZIP_LIMIT = 20;
const ZIP_WINDOW_MS = 61000;
const zipHits = [];
const zipStats = { peak: 0, waitedMs: 0 };
async function zipBudget(n) {
    const start = Date.now();
    for (;;) {
        while (zipHits.length && zipHits[0] <= Date.now() - ZIP_WINDOW_MS) zipHits.shift();
        if (zipHits.length + n <= ZIP_LIMIT) break;
        await sleep(250);
    }
    for (let i = 0; i < n; i++) zipHits.push(Date.now());
    zipStats.peak = Math.max(zipStats.peak, zipHits.length);
    zipStats.waitedMs += Date.now() - start;
}

// The server's Files upload limiter, budgeted the same way: 60 uploads per
// sliding minute, one bucket for all four runs. Every REAL upload body takes
// its share first, and routed fakes never reach the server. A check=1
// preflight counts against the read limiter, but is also refused (429) while
// this bucket is full, which it asks without spending. So the budget keeps
// one upload's room free: a preflight never meets a full bucket, even one
// made for an upload that is then refused or cancelled and so took no share.
// Must match filesUploadLimiter's max in server.js; if that changes, change this.
const UPLOAD_LIMIT = 60;
const UPLOAD_BUDGET = UPLOAD_LIMIT - 1;   // one upload's room kept free for preflights
const uploadHits = [];
const uploadStats = { peak: 0, waitedMs: 0 };
async function uploadBudget(n) {
    const start = Date.now();
    for (;;) {
        while (uploadHits.length && uploadHits[0] <= Date.now() - ZIP_WINDOW_MS) uploadHits.shift();
        if (uploadHits.length + n <= UPLOAD_BUDGET) break;
        await sleep(250);
    }
    for (let i = 0; i < n; i++) uploadHits.push(Date.now());
    uploadStats.peak = Math.max(uploadStats.peak, uploadHits.length);
    uploadStats.waitedMs += Date.now() - start;
}

// Starts a download and returns it, or null when none began. A download that
// never starts must be a failed check, not a timeout that ends the run.
async function expectDownload(page, start, { timeout = 10000 } = {}) {
    try {
        const [download] = await Promise.all([
            page.waitForEvent('download', { timeout }),
            start(),
        ]);
        return download;
    } catch {
        return null;
    }
}

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
// Added for the download checks: a protected file, an in-flight upload part,
// and a folder over the zip cap. Its name must not contain SIDEBAR_DIR's, or
// the hasText row lookups below would match both folders.
const PROTECTED_FILE = '.env';
const UPLOAD_PART = '.ctp-upload-0a1b2c.part';
const ZIP_CAP_DIR = '/config/ctp-zip-cap-fixture';
// The Files sidebar's upload inbox. The suite runs against a throwaway
// container, so checkUploads empties it before and after.
const INBOX_DIR = '/config/uploads';

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

// 6b. The sidebar's two views are a tab set, and must be a whole one: a
//     tablist holding only its tabs (the » that hides the sidebar sits
//     beside it, not in it), tabs named without their icons, each naming
//     the panel it shows (#files-list, labelled by the selected tab), one
//     tab stop for the set, Left/Right (wrapping), Home and End between the
//     tabs, and Enter or Space to switch. Arrows only move focus: a switch
//     reloads the list, and Recent changes walks /config. Its own context,
//     so switching views here leaves the main run's tree and saved tab alone.
async function checkSidebarTabs(browser, url) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    try {
        await page.goto(url, { waitUntil: 'load' });
        const wrapper = await wrapperFrame(page);
        await wrapper.locator('#files-btn').click();
        await waitFor(() => wrapper.evaluate('!document.getElementById("files-sidebar").classList.contains("collapsed")'));
        const tabState = () => wrapper.evaluate(`(() => {
            const tablist = document.querySelector('#files-sidebar [role="tablist"]');
            const tabs = tablist ? [...tablist.children] : [];
            const panel = document.getElementById('files-list');
            const labelledBy = document.getElementById(panel.getAttribute('aria-labelledby') || '');
            const a = document.activeElement;
            return JSON.stringify({
                label: tablist && tablist.getAttribute('aria-label'),
                roles: tabs.map((t) => t.getAttribute('role')),
                hideInTablist: !!document.getElementById('files-hide').closest('[role="tablist"]'),
                controls: [...new Set(tabs.map((t) => t.getAttribute('aria-controls')))],
                selected: tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.dataset.tab),
                tabStops: tabs.filter((t) => t.tabIndex === 0).map((t) => t.dataset.tab),
                panelRole: panel.getAttribute('role'),
                panelLabel: labelledBy ? labelledBy.dataset.tab || null : null,
                focus: a && a.classList.contains('files-tab') ? a.dataset.tab : null,
                period: !document.getElementById('files-recent-hours').hidden,
            });
        })()`).then(JSON.parse);

        let v = await tabState();
        check('the sidebar\'s tablist holds only its two tabs, with » beside it',
            v, (s) => JSON.stringify(s.roles) === '["tab","tab"]' && !s.hideInTablist && s.label === 'Sidebar view');
        check('both tabs show #files-list, a tabpanel labelled by the selected tab',
            v, (s) => JSON.stringify(s.controls) === '["files-list"]' && s.panelRole === 'tabpanel'
                && JSON.stringify(s.selected) === '["files"]' && s.panelLabel === 'files');
        check('the tabs are named without their icons',
            { files: await wrapper.getByRole('tab', { name: 'Files', exact: true }).count(),
                recent: await wrapper.getByRole('tab', { name: 'Recent changes', exact: true }).count() },
            (n) => n.files === 1 && n.recent === 1);
        check('the tab set is one tab stop, the selected tab', JSON.stringify(v.tabStops), '["files"]');

        await wrapper.locator('.files-tab[data-tab="files"]').focus();
        await page.keyboard.press('ArrowRight');
        v = await tabState();
        check('ArrowRight moves focus to the next tab without switching to it',
            { focus: v.focus, selected: v.selected }, (s) => s.focus === 'recent' && JSON.stringify(s.selected) === '["files"]');
        const moves = [];
        for (const key of ['ArrowRight', 'End', 'Home', 'ArrowLeft']) {
            await page.keyboard.press(key);
            moves.push((await tabState()).focus);
        }
        check('Right and Left wrap around, Home and End go to the ends',
            JSON.stringify(moves), JSON.stringify(['files', 'recent', 'files', 'recent']));
        await page.keyboard.press('Enter');
        check('Enter switches to the focused tab; the tab stop and the panel\'s label follow',
            await waitFor(async () => {
                const s = await tabState();
                return JSON.stringify(s.selected) === '["recent"]' && JSON.stringify(s.tabStops) === '["recent"]'
                    && s.panelLabel === 'recent' && s.period;
            }), true);
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('Space');
        check('Space switches too',
            await waitFor(async () => JSON.stringify((await tabState()).selected) === '["files"]'), true);
    } finally {
        await context.close();
    }
}

// Opens the sidebar (it reopens by itself after a reload), lists dotfiles,
// and expands the fixture folder. Returns the tree.
async function openSidebarFixture(wrapper) {
    if (await wrapper.evaluate('document.getElementById("files-sidebar").classList.contains("collapsed")')) {
        await wrapper.locator('#files-btn').click();
    }
    await wrapper.locator('#files-show-hidden').check();
    const tree = wrapper.locator('#files-list');
    const folder = tree.locator('.files-row', { hasText: SIDEBAR_DIR.split('/').pop() });
    await waitFor(async () => (await folder.count()) === 1);
    await folder.click();
    await waitFor(async () => (await tree.locator('.files-row', { hasText: SIDEBAR_FILE }).count()) === 1);
    return tree;
}

// Preview and toggle probes shared by the protected-file checks.
const previewState = (wrapper) => wrapper.evaluate(`JSON.stringify({
    active: document.getElementById('files-preview').classList.contains('active'),
    body: document.getElementById('files-preview-body').textContent,
})`).then(JSON.parse);
const previewText = async (wrapper) => {
    const { active, body } = await previewState(wrapper);
    return active && body;
};
// The strip is a live region that is always in the DOM, so "showing" means
// it has text: an empty one takes no space and announces nothing.
const toggleState = (wrapper) => wrapper.evaluate(`JSON.stringify({
    checked: document.getElementById('files-show-protected').checked,
    strip: document.getElementById('files-protected-strip').textContent !== '',
})`);
const TOGGLE_OFF = JSON.stringify({ checked: false, strip: false });
const TOGGLE_ON = JSON.stringify({ checked: true, strip: true });
// Flips the toggle from the keyboard. The full-viewport preview does not
// trap focus, so this is how someone switches it off with a preview open.
// Not uncheck({ force: true }): with the preview up that click lands on the
// backdrop, which closes the preview and passes for the wrong reason.
async function pressToggle(wrapper, page) {
    await wrapper.locator('#files-show-protected').focus();
    await page.keyboard.press('Space');
}

// 7. Downloads and the "Show protected files" toggle. Its own context, so a
//    reload and the downloads here cannot disturb the main run, and so
//    acceptDownloads is explicit. Playwright reports a download started in
//    any frame of the page, so under ingress the nested wrapper frame is
//    covered by the same waitForEvent.
async function checkDownloads(browser, url) {
    dexec(['sh', '-c', 'printf "TOKEN=1\\n" > "$1"; printf partial > "$2"; mkdir -p "$3"; '
        + 'truncate -s 210M "$3/huge.bin"', 'sh',
        `${SIDEBAR_DIR}/${PROTECTED_FILE}`, `${SIDEBAR_DIR}/${UPLOAD_PART}`, ZIP_CAP_DIR]);
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    // Every protected=1 request, tagged with whether the toggle was on when
    // it went out. The context sees the nested ingress frame's requests too.
    let toggleOn = false;
    const flagged = [];
    context.on('request', (r) => {
        if (new URL(r.url()).searchParams.get('protected') === '1') flagged.push({ on: toggleOn, url: r.url() });
    });
    // A download is not a 'request' event (nor is it routable): the browser
    // fetches it outside the page. Every attempt, a refused one included,
    // is a 'download' event in both engines, so downloads are tracked here
    // and their protected=1 ones fed into `flagged` too.
    const downloads = [];
    page.on('download', (d) => {
        downloads.push(d.url());
        if (new URL(d.url()).searchParams.get('protected') === '1') flagged.push({ on: toggleOn, url: d.url() });
    });
    try {
        await page.goto(url, { waitUntil: 'load' });
        let wrapper = await wrapperFrame(page);
        const closePreview = () => wrapper.locator('#files-close-btn').click();
        const toggleShown = () => wrapper.locator('#files-protected-toggle').isVisible();
        const switchTab = (tab) => wrapper.locator(`.files-tab[data-tab="${tab}"]`).click();
        const turnOn = async () => {
            await wrapper.locator('#files-show-protected').check();
            toggleOn = true;
        };
        const turnOffByKeyboard = async () => {
            await pressToggle(wrapper, page);
            toggleOn = false;
        };
        const noToken = async () => !/TOKEN/.test((await previewState(wrapper)).body);

        check('Show protected files is off on load, with no strip', await toggleState(wrapper), TOGGLE_OFF);
        let list = await openSidebarFixture(wrapper);
        const protectedRow = () => list.locator('.files-row', { hasText: PROTECTED_FILE });
        await protectedRow().click();
        check('with the toggle off, a protected file is refused',
            await waitFor(async () => /Show protected files/.test((await previewText(wrapper)) || '')), true);
        await closePreview();

        await turnOn();
        check('turning it on shows the amber strip', await toggleState(wrapper), TOGGLE_ON);
        await protectedRow().click();
        check('with the toggle on, a protected file previews',
            await waitFor(async () => (await previewText(wrapper)) === 'TOKEN=1\n'), true);

        // Switched off from the keyboard with the protected preview still up.
        await turnOffByKeyboard();
        check('switching off closes an open protected preview and clears it',
            { state: await toggleState(wrapper), preview: await previewState(wrapper) },
            (v) => v.state === TOGGLE_OFF && !v.preview.active && !/TOKEN/.test(v.preview.body));
        // Only reached when the check above failed; the rest still runs.
        if ((await previewState(wrapper)).active) await closePreview();

        // Positive control: an ordinary file has nothing to hide.
        await turnOn();
        await list.locator('.files-row', { hasText: SIDEBAR_FILE }).click();
        await waitFor(async () => (await previewText(wrapper)) === 'sidebar: ok\n');
        await turnOffByKeyboard();
        check('switching off leaves an ordinary preview open',
            await previewText(wrapper), 'sidebar: ok\n');
        await closePreview();

        // A back/forward-cache restore goes through the same switch-off.
        await turnOn();
        await protectedRow().click();
        await waitFor(async () => (await previewText(wrapper)) === 'TOKEN=1\n');
        await wrapper.evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))");
        toggleOn = false;
        check('a back/forward-cache restore turns it off and clears a protected preview',
            { state: await toggleState(wrapper), preview: await previewState(wrapper) },
            (v) => v.state === TOGGLE_OFF && !v.preview.active && v.preview.body === '');
        // Only reached when the check above failed; the rest still runs.
        if ((await previewState(wrapper)).active) await closePreview();

        // Off, the toggle is a Files-tab control like Hidden files. On, it
        // stays wherever the amber strip shows, so it can always be switched
        // off from there.
        await turnOn();
        await switchTab('recent');
        check('while on, the toggle stays visible on the Recent tab', await waitFor(toggleShown), true);
        await turnOffByKeyboard();
        check('turning it off on the Recent tab hides it and the strip',
            { shown: await toggleShown(), state: await toggleState(wrapper) },
            (v) => !v.shown && v.state === TOGGLE_OFF);
        check('focus moves to the Recent tab, not the page body, when the toggle hides',
            await wrapper.evaluate('document.activeElement?.dataset?.tab || document.activeElement?.tagName'), 'recent');
        await switchTab('files');
        check('off, the toggle is back on the Files tab', await waitFor(toggleShown), true);
        check('the empty strip takes no space',
            await wrapper.evaluate("document.getElementById('files-protected-strip').getBoundingClientRect().height"), 0);
        list = await openSidebarFixture(wrapper);
        await protectedRow().click();
        check('switched off, a protected file is refused again',
            await waitFor(async () => /Show protected files/.test((await previewText(wrapper)) || '')), true);
        check('the refusal shows no secret', await noToken(), true);
        await closePreview();

        // On again, so the reload below has something to reset.
        await turnOn();
        await page.reload({ waitUntil: 'load' });
        toggleOn = false;
        wrapper = await wrapperFrame(page);
        check('the toggle is off again after a reload', await toggleState(wrapper), TOGGLE_OFF);
        check('fixture: protected=1 was sent while the toggle was on', flagged.some((f) => f.on), true);
        check('no protected=1 request goes out while the toggle is off',
            flagged.filter((f) => !f.on).map((f) => f.url), (v) => v.length === 0);
        list = await openSidebarFixture(wrapper);

        // Download from the preview: the file's own name, its exact bytes,
        // and the terminal page still in place afterwards.
        const downloadBtn = () => wrapper.locator('#files-download-btn');
        const downloadDisabled = () => wrapper.evaluate(
            '!!document.getElementById("files-download-btn")?.disabled');
        await list.locator('.files-row', { hasText: SIDEBAR_FILE }).click();
        await waitFor(async () => (await previewText(wrapper)) === 'sidebar: ok\n');
        const file = await expectDownload(page, () => downloadBtn().click());
        check('Download starts a download', file !== null, true);
        // Playwright's WebKit on Linux (the CI runner) sanitises spaces in a
        // download's suggested name to underscores; macOS WebKit and Chromium
        // keep them. The server's Content-Disposition is the same either way
        // (pinned in files-download-single.test.js), so accept exactly that one
        // substitution there and the exact name everywhere else.
        const linuxWebKit = process.platform === 'linux'
            && page.context().browser().browserType().name() === 'webkit';
        const expectedName = linuxWebKit ? SIDEBAR_FILE.replace(/ /g, '_') : SIDEBAR_FILE;
        check('the download keeps the file name', file && file.suggestedFilename(), expectedName);
        check('the download has the exact bytes',
            file && readFileSync(await file.path(), 'utf8'), 'sidebar: ok\n');
        check('the terminal page is still there after a download',
            await wrapper.evaluate('!!document.getElementById("terminal-frame")').catch(() => false), true);
        await closePreview();

        await protectedRow().click();
        await waitFor(async () => /Show protected files/.test((await previewText(wrapper)) || ''));
        check('Download is disabled when the preview was refused', await downloadDisabled(), true);
        await closePreview();

        // With the toggle on, a protected file downloads too, and its request
        // carries protected=1.
        await turnOn();
        await protectedRow().click();
        await waitFor(async () => (await previewText(wrapper)) === 'TOKEN=1\n');
        const secret = await expectDownload(page, () => downloadBtn().click());
        check('with the toggle on, a protected file downloads',
            secret && readFileSync(await secret.path(), 'utf8'), 'TOKEN=1\n');
        // Positive control for the "no protected=1 download while off"
        // check below: download requests do reach `flagged`.
        check('fixture: the protected download went out with protected=1',
            flagged.some((f) => f.on && /\/api\/files\/download\?/.test(f.url)), true);

        // The click handler's own guards, which the disabled button hides:
        // each probe forces the button on before clicking it.
        const forceClick = `(() => {
            const el = document.getElementById('files-download-btn');
            el.disabled = false;
            el.click();
        })()`;
        // The toggle reads off (unticked without its change event, so the
        // protected preview is still up): its file must not go out.
        let before = { flagged: flagged.length, downloads: downloads.length };
        const unticked = await expectDownload(page, () => wrapper.evaluate(
            `document.getElementById('files-show-protected').checked = false; ${forceClick}`), { timeout: 2000 });
        check('Download refuses a protected preview once the toggle reads off',
            { started: unticked !== null,
                flagged: flagged.length - before.flagged,
                downloads: downloads.length - before.downloads },
            (v) => !v.started && v.flagged === 0 && v.downloads === 0);
        await wrapper.evaluate("document.getElementById('files-show-protected').checked = true");

        // Switching off blanks the protected preview: nothing is left to
        // download, so even a click that reaches the button starts nothing.
        await turnOffByKeyboard();
        check('switching off disables Download for the blanked preview', await downloadDisabled(), true);
        before = { downloads: downloads.length };
        const stray = await expectDownload(page, () => wrapper.evaluate(forceClick), { timeout: 2000 });
        check('a forced click on Download after switch-off starts nothing',
            { started: stray !== null, downloads: downloads.length - before.downloads },
            (v) => !v.started && v.downloads === 0);
        check('no protected=1 download goes out while the toggle is off',
            flagged.filter((f) => !f.on).map((f) => f.url), (v) => v.length === 0);

        // Download as zip, from the folder row's always-visible ⋯ menu.
        // Each real zip costs two of the limiter's requests (see zipBudget),
        // so the refusal goes first and the good zip after it doubles as
        // its positive control.
        const fixtureName = SIDEBAR_DIR.split('/').pop();
        const menuButton = (name) => list.locator('.files-row-wrap', { hasText: name }).locator('.files-menu-btn');
        const zipItem = wrapper.locator('#files-menu .files-menu-item', { hasText: 'Download as zip' });
        const menuHidden = () => wrapper.evaluate('document.getElementById("files-menu").hidden');
        check('a folder row shows its ⋯ button without hovering', await menuButton(fixtureName).isVisible(), true);

        // Over the 200 MB cap (a sparse file, so no disk is used): refused in
        // the sidebar with the biggest file named, and no download at all.
        const noticeText = () => wrapper.evaluate(
            'document.getElementById("files-notice").hidden ? "" : document.getElementById("files-notice-text").textContent');
        before = { downloads: downloads.length };
        await menuButton(ZIP_CAP_DIR.split('/').pop()).click();
        await zipBudget(1);   // the preflight only: it is refused
        await zipItem.click();
        check('a folder over the zip cap is refused, naming its largest file',
            await waitFor(async () => /zip limit/.test(await noticeText()) && /huge\.bin/.test(await noticeText())), true);

        await menuButton(fixtureName).click();
        check('the ⋯ menu offers Download as zip', await zipItem.isVisible(), true);
        await zipBudget(2);
        const zip = await expectDownload(page, () => zipItem.click());
        check('Download as zip starts a download', zip !== null, true);
        check('the zip is named after the folder', zip && zip.suggestedFilename(), `${fixtureName}.zip`);
        if (zip) {
            // python3's zipfile, as a reader independent of the writer: -t
            // checks every CRC, -l lists the names.
            const zipPath = await zip.path();
            let listing = '';
            try {
                execFileSync('python3', ['-I', '-m', 'zipfile', '-t', zipPath]);
                listing = execFileSync('python3', ['-I', '-m', 'zipfile', '-l', zipPath]).toString();
            } catch (e) {
                listing = `(unreadable: ${e.message})`;
            }
            check('the zip holds the fixture files, a user\'s own *.part among them',
                [SIDEBAR_FILE, 'secrets.yaml', 'download.part'].every((n) => listing.includes(`${fixtureName}/${n}`)), true);
            check('the zip leaves out protected files, .git and upload parts',
                [PROTECTED_FILE, '.git/', UPLOAD_PART].filter((n) => listing.includes(`${fixtureName}/${n}`)), (v) => v.length === 0);
        }
        check('the menu closes after its action', await menuHidden(), true);
        // The good zip is the refusal's positive control, in place of a
        // guessed wait: downloads are reported in the order they start, so
        // had the refused one started, it would be listed ahead of this one.
        check('a refused zip starts no download',
            downloads.slice(before.downloads).map((u) => new URL(u).searchParams.get('path')),
            (v) => v.length === 1 && v[0] === SIDEBAR_DIR);

        await menuButton(fixtureName).click();
        check('fixture: the ⋯ menu is open before Escape', await menuHidden(), false);
        await page.keyboard.press('Escape');
        check('Escape closes the ⋯ menu', await menuHidden(), true);
    } finally {
        await context.close();
    }
}

// The ⋯ menu's other ways in and out, and the zip refusals the sidebar must
// explain. Its own context with service workers blocked, so context.route
// sees the check=1 preflights it fakes (see checkStaleView). A zip download
// itself is never a 'request' (nor routable), only a 'download' event, so the
// preflights are counted by request and the zips by download.
//
// Every "starts no download" here is backed by a positive control: a good
// zip at the end, which must be the only download since the refusals began.
// Real zip-limiter requests are few, and each takes its share of zipBudget.
async function checkZipMenu(browser, url) {
    const LOCKED = '.ssh';        // a protected folder (SENSITIVE_DIRS)
    const GONE = 'ctp-gone';      // listed, then deleted before its zip
    const OTHER = 'ctp-other';    // zipped while another zip is preparing
    dexec(['sh', '-c', 'mkdir -p "$1" "$2" "$3"; printf k > "$1/id_test"; printf x > "$2/x"; printf y > "$3/y"', 'sh',
        `${SIDEBAR_DIR}/${LOCKED}`, `${SIDEBAR_DIR}/${GONE}`, `${SIDEBAR_DIR}/${OTHER}`]);
    const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
    const page = await context.newPage();
    const downloads = [];
    page.on('download', (d) => downloads.push(d));
    const preflights = [];
    // Held preflights' gates, all opened in `finally` whatever happened.
    const releases = [];
    const gateOf = () => {
        let open;
        const gate = new Promise((r) => { open = r; });
        releases.push(open);
        return [gate, open];
    };
    context.on('request', (r) => {
        const u = new URL(r.url());
        if (u.pathname.endsWith('/api/files/download-zip') && u.searchParams.get('check') === '1') preflights.push(u);
    });
    try {
        await page.goto(url, { waitUntil: 'load' });
        const wrapper = await wrapperFrame(page);
        const list = await openSidebarFixture(wrapper);
        const fixtureName = SIDEBAR_DIR.split('/').pop();
        const menuButton = (name) => list.locator('.files-row-wrap', { hasText: name }).locator('.files-menu-btn');
        const zipItem = wrapper.locator('#files-menu .files-menu-item', { hasText: 'Download as zip' });
        const menuHidden = () => wrapper.evaluate('document.getElementById("files-menu").hidden');
        const focused = () => wrapper.evaluate(`(() => {
            const a = document.activeElement;
            if (!a) return '';
            if (a.classList.contains('files-menu-item')) return 'item:' + a.textContent;
            return a.getAttribute('aria-label') || a.id || a.tagName;
        })()`);
        const notice = () => wrapper.evaluate(`JSON.stringify({
            text: document.getElementById('files-notice').hidden ? '' : document.getElementById('files-notice-text').textContent,
            kind: document.getElementById('files-notice').className,
        })`).then(JSON.parse);
        const zipPaths = (since) => downloads.slice(since).map((d) => new URL(d.url()).searchParams.get('path'));
        // Waits for the preflight to have answered: the notice leaves its
        // "Preparing" state, one way or the other.
        const settled = () => waitFor(async () => {
            const { text } = await notice();
            return text !== '' && !/^Preparing/.test(text);
        });

        // Keyboard: the ⋯ is a button in the tab order. Enter opens the menu
        // with focus on its first item; Escape closes it and gives focus back
        // to the ⋯; so does Tab, instead of dropping focus on the page.
        await menuButton(fixtureName).focus();
        check('the ⋯ button takes keyboard focus', await focused(), `Actions for ${fixtureName}`);
        await page.keyboard.press('Enter');
        check('Enter on ⋯ opens the menu', await menuHidden(), false);
        check('the menu puts focus on its first item', await focused(), (v) => /^item:Download as zip/.test(v));
        check('the ⋯ button says its menu is open',
            await menuButton(fixtureName).getAttribute('aria-expanded'), 'true');
        await page.keyboard.press('ArrowDown');
        check('arrow keys keep focus inside the menu', await focused(), (v) => /^item:/.test(v));
        await page.keyboard.press('Escape');
        check('Escape closes the menu from the keyboard', await menuHidden(), true);
        check('and focus returns to the ⋯ button', await focused(), `Actions for ${fixtureName}`);
        check('the ⋯ button says its menu is closed',
            await menuButton(fixtureName).getAttribute('aria-expanded'), 'false');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Tab');
        check('Tab closes the menu and returns focus to the ⋯ button',
            { hidden: await menuHidden(), focus: await focused() },
            (v) => v.hidden && v.focus === `Actions for ${fixtureName}`);

        // Closed by something else with focus inside (a tree scroll here),
        // the menu hands focus back too, rather than dropping it on the page.
        await page.keyboard.press('Enter');
        check('fixture: focus is inside the open menu', await focused(), (v) => /^item:/.test(v));
        await wrapper.evaluate("document.getElementById('files-list').dispatchEvent(new Event('scroll'))");
        check('a menu closed by a scroll gives focus back to the ⋯ button',
            { hidden: await menuHidden(), focus: await focused() },
            (v) => v.hidden && v.focus === `Actions for ${fixtureName}`);

        // Only a change of width closes it: on a phone the URL bar and the
        // keyboard change the height alone.
        const size = page.viewportSize();
        const innerSize = () => wrapper.evaluate('JSON.stringify([innerWidth, innerHeight])').then(JSON.parse);
        const [width0, height0] = await innerSize();
        await page.keyboard.press('Enter');
        await page.setViewportSize({ width: size.width, height: size.height - 80 });
        check('fixture: the page got shorter', await waitFor(async () => (await innerSize())[1] < height0), true);
        // Two frames, so a resize event for the new height has been handled.
        await wrapper.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
        check('a height-only resize leaves the menu open', await menuHidden(), false);
        await page.setViewportSize({ width: size.width - 80, height: size.height - 80 });
        check('fixture: the page got narrower', await waitFor(async () => (await innerSize())[0] < width0), true);
        check('a change of width closes the menu', await waitFor(menuHidden), true);
        await page.setViewportSize(size);
        await waitFor(async () => (await innerSize())[0] === width0);

        // A click outside closes it; the menu sits inside the sidebar.
        await menuButton(fixtureName).click();
        check('the open menu stays inside the sidebar', await wrapper.evaluate(`(() => {
            const m = document.getElementById('files-menu').getBoundingClientRect();
            const s = document.getElementById('files-sidebar').getBoundingClientRect();
            return m.width > 0 && m.left >= s.left && m.right <= s.right && m.top >= s.top && m.bottom <= s.bottom;
        })()`), true);
        // The footer's top padding: clear of the resize handle on the left
        // edge and of the check button inside it.
        await wrapper.locator('#files-footer').click({ position: { x: 40, y: 3 } });
        check('a click outside closes the menu', await menuHidden(), true);

        // A click into the terminal, with focus in the open menu, must leave
        // focus in the terminal (CLAUDE.md, mouse ownership). The wrapper
        // never sees that click, only its window losing focus; closing the
        // menu then must not hand focus back to the ⋯. Proof is a key typed
        // next arriving in tmux, read from tmux itself.
        await menuButton(fixtureName).focus();
        await page.keyboard.press('Enter');
        check('fixture: focus is in the open menu before the terminal click', await focused(), (v) => /^item:/.test(v));
        const term = await wrapper.locator('#terminal-frame').boundingBox();
        await page.mouse.click(term.x + term.width / 2, term.y + term.height / 2);
        check('a click into the terminal closes the menu', await waitFor(menuHidden), true);
        check('and leaves focus in the terminal frame',
            await wrapper.evaluate('document.activeElement && document.activeElement.tagName'), 'IFRAME');
        const MARK = 'ctpmenufocus';
        const lastLine = () => dexec(['tmux', 'capture-pane', '-p']).trimEnd().split('\n').pop();
        await page.keyboard.type(MARK);
        check('a key typed after that click reaches tmux', await waitFor(() => lastLine().endsWith(MARK)), true);
        sendKeys('C-u');

        // A folder deleted after it was listed: the server's 404, in the
        // notice, and no download. Also the positive control for the
        // preflight counter that the protected folder's check relies on.
        const since = downloads.length;
        let preflightsBefore = preflights.length;
        dexec(['rm', '-rf', `${SIDEBAR_DIR}/${GONE}`]);
        await menuButton(GONE).click();
        await zipBudget(1);
        await zipItem.click();
        await settled();
        check('a vanished folder\'s zip is refused in the notice',
            await notice(), (v) => /Not found/.test(v.text) && v.kind === 'error');
        check('fixture: the preflight counter sees a preflight', preflights.length - preflightsBefore, 1);

        // A protected folder keeps its ⋯, but Download as zip is disabled
        // and says why, on screen as well as in a tooltip (touch has none).
        preflightsBefore = preflights.length;
        check('a protected folder still shows ⋯', await menuButton(LOCKED).isVisible(), true);
        await menuButton(LOCKED).click();
        check('its Download as zip is disabled, with the reason',
            await wrapper.evaluate(`JSON.stringify((() => {
                const item = [...document.querySelectorAll('#files-menu .files-menu-item')]
                    .find((i) => i.textContent.includes('Download as zip'));
                const hint = item && document.getElementById(item.getAttribute('aria-describedby') || '');
                return item && {
                    disabled: item.getAttribute('aria-disabled'), title: item.title, text: item.textContent,
                    described: hint && item.contains(hint) ? hint.textContent : null,
                    hintOutOfName: !!hint && hint.getAttribute('aria-hidden') === 'true',
                };
            })())`).then(JSON.parse),
            // On screen, in its tooltip, and as its description; not in its
            // name (the hint is aria-hidden, so the name stays the label).
            (v) => v && v.disabled === 'true' && /protected/i.test(v.title) && /protected/i.test(v.text)
                && /protected/i.test(v.described || '') && v.hintOutOfName);
        // force: Playwright will not click what aria-disabled marks disabled.
        await zipItem.click({ force: true });
        await page.keyboard.press('Enter');
        // Even with the disabled mark stripped, the action does not run: the
        // menu decided when it opened.
        await wrapper.evaluate(`(() => {
            const item = document.querySelector('#files-menu .files-menu-item');
            if (!item) return;
            item.removeAttribute('aria-disabled');
            item.click();
        })()`);
        check('a protected folder sends no zip preflight', preflights.length - preflightsBefore, 0);
        await zipBudget(1);
        check('the server refuses a protected folder\'s zip with 403',
            await wrapper.evaluate(`fetch(${JSON.stringify(`api/files/download-zip?path=${encodeURIComponent(`${SIDEBAR_DIR}/${LOCKED}`)}&check=1`)})
                .then((r) => r.status)`), 403);
        await wrapper.evaluate('document.getElementById("files-notice-close").click()');
        if (!(await menuHidden())) await page.keyboard.press('Escape');

        // Two zips already running (the server's 429, faked here so as not
        // to hold two real ones open): a friendly "try again", not an error.
        let held = 0;
        const isPreflight = (u) => u.pathname.endsWith('/api/files/download-zip') && u.searchParams.get('check') === '1';
        await context.route(isPreflight, (route) => {
            held++;
            return route.fulfill({ status: 429, contentType: 'application/json',
                body: JSON.stringify({ error: '2 zips are already being prepared or sent. Try again when one has finished.' }) });
        });
        await menuButton(fixtureName).click();
        await zipItem.click();
        await settled();
        check('fixture: the faked 429 was served', held, 1);
        check('a busy server (429) shows as try again, not as an error', await notice(),
            (v) => v.kind === 'busy' && /did not start/.test(v.text) && /Try again when one has finished/.test(v.text));
        // A 429 from something in between, with no message of its own.
        await context.unroute(isPreflight);
        await context.route(isPreflight, (route) => { held++; return route.fulfill({ status: 429, body: '' }); });
        await menuButton(fixtureName).click();
        await zipItem.click();
        await waitFor(async () => held === 2 && (await notice()).kind === 'busy');
        check('a 429 with no message still says to try again shortly', await notice(),
            (v) => v.kind === 'busy' && /Try again shortly/.test(v.text));

        // The network failing under the preflight.
        await context.unroute(isPreflight);
        await context.route(isPreflight, (route) => { held++; return route.abort('failed'); });
        await menuButton(fixtureName).click();
        await zipItem.click();
        await waitFor(async () => held === 3 && /reach/.test((await notice()).text));
        check('a network failure is shown in the notice', await notice(),
            (v) => v.kind === 'error' && /Could not reach the add-on/.test(v.text));

        // A 200 that is not a plan (a proxy's page, say) is no passed check.
        await context.unroute(isPreflight);
        await context.route(isPreflight, (route) => {
            held++;
            return route.fulfill({ status: 200, contentType: 'text/html', body: '<html>proxy</html>' });
        });
        await menuButton(fixtureName).click();
        await zipItem.click();
        await waitFor(async () => held === 4 && /unexpected/.test((await notice()).text));
        check('a preflight reply that is not a plan is shown as a failure', await notice(),
            (v) => v.kind === 'error' && /unexpected answer/.test(v.text));
        await context.unroute(isPreflight);

        // A late refusal is never lost: the fixture's preflight is held while
        // another folder's zip takes the notice; when the fixture's refusal
        // lands, it shows all the same, and so does the other's after it.
        // Both faked, so no zip is made.
        const isFixturePreflight = (u) => isPreflight(u) && u.searchParams.get('path') === SIDEBAR_DIR;
        const isOtherPreflight = (u) => isPreflight(u) && u.searchParams.get('path') === `${SIDEBAR_DIR}/${OTHER}`;
        const [lateGate, releaseLate] = gateOf();
        const [newerGate, releaseNewer] = gateOf();
        await context.route(isFixturePreflight, async (route) => {
            await lateGate;
            await route.fulfill({ status: 413, contentType: 'application/json',
                body: JSON.stringify({ error: 'This folder holds 300 MB, over the 200 MB zip limit. Largest: late.bin (300 MB)' }) });
        });
        await context.route(isOtherPreflight, async (route) => {
            await newerGate;
            await route.abort('failed');
        });
        await menuButton(fixtureName).click();
        await zipItem.click();
        await menuButton(OTHER).click();
        await zipItem.click();
        check('fixture: the newer zip has the notice', (await notice()).text, (v) => /^Preparing ctp-other\.zip/.test(v));
        releaseLate();
        check('an older zip\'s late refusal still shows',
            await waitFor(async () => /late\.bin/.test((await notice()).text)), true);
        releaseNewer();
        check('and the newer zip\'s refusal after it',
            await waitFor(async () => /Could not reach the add-on to prepare ctp-other\.zip/.test((await notice()).text)), true);
        await context.unroute(isFixturePreflight);
        await context.unroute(isOtherPreflight);

        // Nor may an older zip's late refusal hide a newer zip's good news.
        // Only progress lines ("Preparing …") move the notice on; a refusal
        // used to as well, so the newer zip's "Downloading …", arriving
        // after it, was dropped while its download started with no word.
        // The older one is faked; the newer one is real, held, then let go.
        const [refusalGate, releaseRefusal] = gateOf();
        const [planGate, releasePlan] = gateOf();
        await context.route(isFixturePreflight, async (route) => {
            await refusalGate;
            await route.fulfill({ status: 413, contentType: 'application/json',
                body: JSON.stringify({ error: 'This folder holds 300 MB, over the 200 MB zip limit. Largest: late.bin (300 MB)' }) });
        });
        await context.route(isOtherPreflight, async (route) => {
            await planGate;
            await route.continue().catch(() => {});
        });
        await menuButton(fixtureName).click();
        await zipItem.click();
        await menuButton(OTHER).click();
        await zipBudget(2);
        await zipItem.click();
        releaseRefusal();
        check('fixture: the older zip\'s late refusal shows',
            await waitFor(async () => /late\.bin/.test((await notice()).text)), true);
        const newer = await expectDownload(page, async () => { releasePlan(); });
        check('fixture: the newer zip downloads', newer && newer.suggestedFilename(), `${OTHER}.zip`);
        check('an older zip\'s late refusal does not hide a newer zip\'s Downloading line',
            await waitFor(async () => /^Downloading ctp-other\.zip/.test((await notice()).text)), true);
        await context.unroute(isFixturePreflight);
        await context.unroute(isOtherPreflight);

        // Positive control for every refusal above, driven by the keyboard
        // alone, with its preflight held back so that more can happen while
        // it is out:
        //   - Enter pressed again (zip, reopen, zip again) must not start
        //     the same zip twice;
        //   - another folder zips, with Enter held down: one press, one zip,
        //     even though that small folder's preflight answers well within
        //     the key repeat;
        //   - when the held answer lands, its zip still starts, but the
        //     notice keeps the newer folder's news.
        const [gate, release] = gateOf();
        let heldZip = 0;
        await context.route(isFixturePreflight, async (route) => {
            heldZip++;
            await gate;
            await route.continue().catch(() => {});
        });
        const preflightsOf = (p) => preflights.filter((u) => u.searchParams.get('path') === p).length;
        const fixturePreflights = preflightsOf(SIDEBAR_DIR);
        await menuButton(fixtureName).focus();
        await page.keyboard.press('Enter');   // opens the menu
        await page.keyboard.press('Enter');   // zips; its preflight is held
        check('fixture: the zip\'s preflight is held back', await waitFor(() => heldZip >= 1), true);
        check('after its action, focus is back on the ⋯ button',
            { hidden: await menuHidden(), focus: await focused() },
            (v) => v.hidden && v.focus === `Actions for ${fixtureName}`);
        await page.keyboard.press('Enter');   // reopens it
        await page.keyboard.press('Enter');   // and zips again: dropped
        await menuButton(OTHER).focus();
        await page.keyboard.press('Enter');   // opens its menu
        await zipBudget(2);
        const otherPreflights = preflightsOf(`${SIDEBAR_DIR}/${OTHER}`);
        const other = await expectDownload(page, () => page.keyboard.down('Enter'));
        check('fixture: another folder zips meanwhile', other && other.suggestedFilename(), `${OTHER}.zip`);
        check('fixture: the notice has the other folder\'s news',
            await waitFor(async () => /^Downloading ctp-other\.zip/.test((await notice()).text)), true);
        // Its preflight has answered: only the repeat guard is left.
        await page.keyboard.down('Enter');   // repeat, on the ⋯
        await page.keyboard.down('Enter');   // repeat, on whatever has focus now
        await page.keyboard.up('Enter');
        check('holding Enter zips a folder once', preflightsOf(`${SIDEBAR_DIR}/${OTHER}`) - otherPreflights, 1);
        check('and leaves its menu closed', await menuHidden(), true);
        // Counted now: the server counts the held preflight when it arrives.
        await zipBudget(2);
        const control = await expectDownload(page, async () => { release(); });
        check('Enter on Download as zip downloads the folder', control && control.suggestedFilename(), `${fixtureName}.zip`);
        check('a second activation while its zip is preparing sends no second preflight',
            preflightsOf(SIDEBAR_DIR) - fixturePreflights, 1);
        check('a late answer does not overwrite a newer zip\'s notice', (await notice()).text,
            (v) => /^Downloading ctp-other\.zip/.test(v));
        // ctp-other twice: once behind the late refusal, once by keyboard.
        check('no refusal (404, protected, 429, network, not a plan) started a download, nor a second zip',
            zipPaths(since).sort(), (v) => JSON.stringify(v) === JSON.stringify([SIDEBAR_DIR, `${SIDEBAR_DIR}/${OTHER}`, `${SIDEBAR_DIR}/${OTHER}`]));
        check('the notice can be dismissed', await (async () => {
            await wrapper.locator('#files-notice-close').click();
            return (await notice()).text;
        })(), '');
    } finally {
        releases.forEach((open) => open());
        await context.close();
    }
}

// Download must follow the preview REQUEST, not its path. Its own context
// with service workers blocked, so context.route sees the previews (see
// checkStaleView).
//   - While a preview loads, Download is disabled, even right after another
//     file's loaded preview had it enabled.
//   - A protected reply held past switch-off, with the same file reopened
//     (and refused) meanwhile, must not land: it carries the same path as
//     the open preview, so only a per-request check can tell them apart.
async function checkPreviewRequests(browser, url) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    const gates = [];
    const releaseAll = () => gates.forEach((g) => g.release());
    const hold = async (pred) => {
        const gate = { held: 0, answered: false };
        gate.done = new Promise((r) => { gate.release = r; });
        gates.push(gate);
        await context.route(pred, async (route) => {
            gate.held++;
            await gate.done;
            await route.continue().catch(() => {});
        });
        context.on('requestfinished', (r) => { if (pred(new URL(r.url()))) gate.answered = true; });
        return gate;
    };
    const isPreviewOf = (name, flaggedReq) => (u) => u.pathname.endsWith('/api/files/preview')
        && u.searchParams.get('path')?.endsWith('/' + name)
        && (u.searchParams.get('protected') === '1') === flaggedReq;
    try {
        await page.goto(url, { waitUntil: 'load' });
        const wrapper = await wrapperFrame(page);
        const list = await openSidebarFixture(wrapper);
        const downloadDisabled = () => wrapper.evaluate('document.getElementById("files-download-btn").disabled');
        const row = (name) => list.locator('.files-row', { hasText: name });

        // An ordinary file loads and enables Download; the next one is
        // held, and Download must be off until it lands.
        await row(SIDEBAR_FILE).click();
        await waitFor(async () => (await previewText(wrapper)) === 'sidebar: ok\n');
        check('fixture: a loaded preview enables Download', await downloadDisabled(), false);
        await wrapper.locator('#files-close-btn').click();
        const loading = await hold(isPreviewOf(SIDEBAR_FILE, false));
        await row(SIDEBAR_FILE).click();
        check('fixture: the ordinary preview is held back', await waitFor(() => loading.held >= 1), true);
        check('Download is disabled while a preview is loading', await downloadDisabled(), true);
        loading.release();
        check('and enabled once it loads',
            await waitFor(async () => (await previewText(wrapper)) === 'sidebar: ok\n' && !(await downloadDisabled())), true);
        await wrapper.locator('#files-close-btn').click();

        // Toggle on, open .env (held), switch off, open .env again
        // (refused), then let the first reply through.
        const late = await hold(isPreviewOf(PROTECTED_FILE, true));
        await wrapper.locator('#files-show-protected').check();
        await row(PROTECTED_FILE).click();
        check('fixture: the protected preview is held back', await waitFor(() => late.held >= 1), true);
        await pressToggle(wrapper, page);
        await row(PROTECTED_FILE).click();
        check('fixture: reopened with the toggle off, the file is refused',
            await waitFor(async () => /Show protected files/.test((await previewText(wrapper)) || '')), true);
        late.release();
        let leaked = false;
        await waitFor(async () => {
            if (/TOKEN/.test((await previewState(wrapper)).body)) leaked = true;
            return late.answered;
        }, { interval: 50 });
        await sleep(300);
        if (/TOKEN/.test((await previewState(wrapper)).body)) leaked = true;
        check('fixture: the held protected reply was released', late.answered, true);
        check('a stale protected reply never lands on the reopened preview', leaked, false);
        check('and Download stays disabled beside the refusal', await downloadDisabled(), true);
    } finally {
        releaseAll();
        await context.close();
    }
}

// A protected preview still in flight when the toggle goes off must not land.
// Its own context with service workers blocked: a request the service worker
// fetches is invisible to context.route (see checkStaleView).
async function checkLateProtectedPreview(browser, url) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    let release;
    const gate = new Promise((r) => { release = r; });
    let held = 0;
    let answered = false;
    const isProtectedPreview = (u) => u.pathname.endsWith('/api/files/preview') && u.searchParams.get('protected') === '1';
    try {
        await context.route(isProtectedPreview, async (route) => {
            held++;
            await gate;
            await route.continue().catch(() => {});
        });
        context.on('requestfinished', (r) => { if (isProtectedPreview(new URL(r.url()))) answered = true; });
        await page.goto(url, { waitUntil: 'load' });
        const wrapper = await wrapperFrame(page);
        const list = await openSidebarFixture(wrapper);
        await wrapper.locator('#files-show-protected').check();
        await list.locator('.files-row', { hasText: PROTECTED_FILE }).click();
        check('fixture: the protected preview is held back', await waitFor(() => held >= 1), true);
        await pressToggle(wrapper, page);
        release();
        let leaked = false;
        await waitFor(async () => {
            if (/TOKEN/.test((await previewState(wrapper)).body)) leaked = true;
            return answered;
        }, { interval: 50 });
        await sleep(300);
        const last = await previewState(wrapper);
        if (/TOKEN/.test(last.body)) leaked = true;
        check('fixture: the held response was released', answered, true);
        check('a protected answer arriving after switch-off never shows',
            { leaked, active: last.active }, (v) => !v.leaked && !v.active);
    } finally {
        release();
        await context.close();
    }
}

// The listing can be stale: a file listed as ordinary, then replaced by a
// symlink to .env before it is opened. Opened with the toggle on, it shows
// the secret, and the preview must still know it is protected (the server
// says so), so switching off clears it. Before the fix only the listing's
// flag counted, and the secret stayed on screen.
const STALE_FILE = 'stale-listing.txt';
async function checkStaleListingPreview(browser, url) {
    const stale = `${SIDEBAR_DIR}/${STALE_FILE}`;
    dexec(['sh', '-c', 'printf "TOKEN=1\\n" > "$1"; printf "plain\\n" > "$2"', 'sh',
        `${SIDEBAR_DIR}/${PROTECTED_FILE}`, stale]);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        await page.goto(url, { waitUntil: 'load' });
        const wrapper = await wrapperFrame(page);
        const list = await openSidebarFixture(wrapper);
        const row = list.locator('.files-row', { hasText: STALE_FILE });
        await waitFor(async () => (await row.count()) === 1);
        check('fixture: the file is listed as ordinary (no lock)',
            await row.evaluate((el) => el.classList.contains('sensitive')), false);
        dexec(['ln', '-sfn', PROTECTED_FILE, stale]);
        await wrapper.locator('#files-show-protected').check();
        await row.click();
        check('fixture: the stale row now opens the protected file',
            await waitFor(async () => (await previewText(wrapper)) === 'TOKEN=1\n'), true);
        await pressToggle(wrapper, page);
        const after = await previewState(wrapper);
        check('switching off clears a protected preview the listing did not mark',
            { active: after.active, token: /TOKEN/.test(after.body) }, (v) => !v.active && !v.token);
    } finally {
        await context.close();
        dexec(['rm', '-f', stale]);
    }
}

// If files-sidebar-ui.js does not load (a 404 while the add-on updates), the
// page carries on without the sidebar: the Files button goes, as it does for a
// missing files-sidebar.js. The button is hidden by the last statement of the
// page script, so a hidden button also proves nothing before it threw. Its own
// context with service workers blocked, so the worker's precached copy cannot
// answer the aborted request.
async function checkSidebarScriptMissing(browser, url) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    let aborted = 0;
    await page.route('**/files-sidebar-ui.js', (route) => { aborted++; return route.abort(); });
    try {
        await page.goto(url, { waitUntil: 'load' });
        const wrapper = await wrapperFrame(page);
        check('fixture: the sidebar UI script was blocked', aborted, (n) => n >= 1);
        check('without files-sidebar-ui.js the page hides the Files button',
            await wrapper.evaluate(`JSON.stringify({
                button: getComputedStyle(document.getElementById('files-btn')).display,
                ui: typeof window.FilesSidebarUI,
            })`), JSON.stringify({ button: 'none', ui: 'undefined' }));
    } finally {
        await context.close();
    }
}

// 7b. A browser without ResizeObserver (iOS WebViews before 13.4): the
//     sidebar is still wired, and a notice too long for its box is still a
//     tab stop, from the check made whenever its text changes. Removed in
//     every frame before any script runs.
async function checkNoResizeObserver(browser, url) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript('delete window.ResizeObserver;');
    const page = await context.newPage();
    const pickDir = mkdtempSync(join(tmpdir(), 'ctp-no-ro-'));
    const isAsk = (u) => u.pathname.endsWith('/api/files/upload') && u.searchParams.has('check');
    const LONG = 'This refusal is long enough to scroll. '.repeat(30).trim();
    await context.route(isAsk, (route) => route.fulfill({ status: 403, contentType: 'application/json',
        body: JSON.stringify({ error: LONG }) }));
    try {
        await page.goto(url, { waitUntil: 'load' });
        const wrapper = await wrapperFrame(page);
        check('fixture: the page has no ResizeObserver', await wrapper.evaluate('typeof window.ResizeObserver'), 'undefined');
        await wrapper.locator('#files-btn').click();
        check('without ResizeObserver the Files button still opens the sidebar',
            await waitFor(() => wrapper.evaluate('!document.getElementById("files-sidebar").classList.contains("collapsed")')), true);
        check('and lists the tree',
            await waitFor(async () => (await wrapper.locator('#files-list .files-row').count()) > 0), true);
        const file = join(pickDir, 'long.txt');
        writeFileSync(file, 'x');
        const chooser = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 5000 }),
            wrapper.locator('#files-upload-btn').click(),
        ]).then(([c]) => c, () => null);
        check('and Upload opens the file picker', chooser !== null, true);
        if (chooser) {
            await chooser.setFiles(file);
            check('and a notice too long for its box is still a tab stop',
                await waitFor(() => wrapper.evaluate('document.getElementById("files-notice-text").getAttribute("tabindex") === "0"')), true);
        }
    } finally {
        await context.close();
        rmSync(pickDir, { recursive: true, force: true });
    }
}

// 8. Uploads from the Files sidebar: the Upload button (the inbox, made on
//    first use, numbering a taken name), Upload here with the collision
//    prompt (Cancel, Escape, Keep both, Replace keeping the old mode), drops
//    on a folder row and elsewhere on the sidebar (never also the terminal's
//    drop), protected and symlinked folders, a secret-shaped name, the size
//    limit, the progress bar, and two files in one pick. What landed is read
//    from the container, never from the page. Its own context with service
//    workers blocked, so context.route sees the requests it holds or fakes.
//    Every real upload body takes its share of uploadBudget first.
async function checkUploads(browser, url) {
    const LOCKED = '.ssh';
    const LINK = 'ctp-up-link';
    const COLLIDE = 'collide.yaml';
    const TAKEN = 'taken.txt';   // a folder: its name is taken by something Replace cannot replace
    dexec(['sh', '-c', 'rm -rf "$1"; mkdir -p "$2/$3" "$2/ctp-up-link-target" "$2/$6"; ln -sfn "$2/ctp-up-link-target" "$2/$4"; '
        + 'printf "old: 1\\n" > "$2/$5"; chmod 600 "$2/$5"', 'sh', INBOX_DIR, SIDEBAR_DIR, LOCKED, LINK, COLLIDE, TAKEN]);
    const exists = (p) => dexec(['sh', '-c', '[ -e "$1" ] && echo yes || echo no', 'sh', p]).trim() === 'yes';
    const read = (p) => (exists(p) ? dexec(['cat', p]) : null);
    const mode = (p) => dexec(['stat', '-c', '%a', p]).trim();
    const pickDir = mkdtempSync(join(tmpdir(), 'ctp-sidebar-upload-'));
    const local = (name, body) => {
        const p = join(pickDir, name);
        writeFileSync(p, body);
        return p;
    };
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    const bodies = [];
    context.on('request', (r) => {
        const u = new URL(r.url());
        if (r.method() === 'POST' && u.pathname.endsWith('/api/files/upload') && !u.searchParams.has('check')) bodies.push(u);
    });
    // The terminal's image upload, faked: counted, never sent, so the image
    // limiter's 10 a minute stays section 5's.
    let imageUploads = 0;
    await context.route((u) => /\/upload$/.test(u.pathname) && !u.pathname.endsWith('/api/files/upload'), (route) => {
        imageUploads++;
        return route.fulfill({ status: 200, contentType: 'application/json',
            body: JSON.stringify({ success: true, path: '/data/images/pasted-0-00000000.png', filename: 'pasted-0-00000000.png', size: 3 }) });
    });
    let release = () => {};
    try {
        await page.goto(url, { waitUntil: 'load' });
        const wrapper = await wrapperFrame(page);
        const list = await openSidebarFixture(wrapper);
        const hasUpload = (await wrapper.locator('#files-upload-btn').count()) === 1;
        check('the sidebar has an Upload button', hasUpload, true);
        if (!hasUpload) return;   // everything below would only time out
        const fixtureName = SIDEBAR_DIR.split('/').pop();
        const notice = () => wrapper.evaluate(`JSON.stringify({
            text: document.getElementById('files-notice').hidden ? '' : document.getElementById('files-notice-text').textContent,
            kind: document.getElementById('files-notice').className,
            bar: !document.getElementById('files-notice-progress').hidden,
            close: !document.getElementById('files-notice-close').hidden,
        })`).then(JSON.parse);
        const selected = () => wrapper.evaluate('document.querySelector("#files-list .files-row.selected")?.dataset.path ?? null');
        const closePreview = async () => {
            if ((await previewState(wrapper)).active) await wrapper.locator('#files-close-btn').click();
        };
        const pick = async (open, files) => {
            const [chooser] = await Promise.all([page.waitForEvent('filechooser'), open()]);
            await chooser.setFiles(files);
        };
        const menuButton = (name) => list.locator('.files-row-wrap').filter({
            has: wrapper.locator('.files-name', { hasText: new RegExp(`^${name.replace(/\./g, '\\.')}$`) }),
        }).locator('.files-menu-btn');
        const uploadHere = wrapper.locator('#files-menu .files-menu-item', { hasText: 'Upload here' });
        const promptShown = () => wrapper.evaluate('!document.getElementById("files-prompt").hidden');
        const promptState = () => wrapper.evaluate(`JSON.stringify({
            text: document.getElementById('files-prompt-text').textContent,
            replace: !document.getElementById('files-prompt-replace').hidden,
            focus: document.activeElement && document.activeElement.id,
        })`).then(JSON.parse);
        const asking = (text) => `${text} Answer in the Files sidebar.`;
        const uploadButton = () => wrapper.locator('#files-upload-btn').click();
        // Drops are synthetic, with a real DataTransfer: dragenter and dragover,
        // then the overlay is read, then the drop. A target is a selector,
        // or { folder } for that folder's row.
        const dropOn = (target, name, body) => wrapper.evaluate(`(() => {
            const t = ${JSON.stringify(target)};
            const n = ${JSON.stringify(name)};
            const el = typeof t === 'string' ? document.querySelector(t)
                : [...document.querySelectorAll('#files-list .files-row-wrap')]
                    .find((w) => w.querySelector('.files-name')?.textContent === t.folder);
            const dt = new DataTransfer();
            dt.items.add(new File([${JSON.stringify(body)}], n, { type: n.endsWith('.png') ? 'image/png' : 'text/plain' }));
            const fire = (type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
            fire('dragenter');
            fire('dragover');
            const overlay = document.getElementById('drop-zone').classList.contains('active');
            fire('drop');
            return JSON.stringify({ overlay });
        })()`).then(JSON.parse);

        // The Upload button: the inbox, made on first use. Revealed and
        // previewed, never typed into the terminal.
        const inboxFile = 'ctp up $1.txt';
        const promptBefore = dexec(['tmux', 'capture-pane', '-p']).trimEnd().split('\n').pop();
        await uploadBudget(1);
        await pick(uploadButton, local(inboxFile, 'hello inbox\n'));
        check('Upload puts the file in the inbox, made on first use',
            await waitFor(() => read(`${INBOX_DIR}/${inboxFile}`) === 'hello inbox\n'), true);
        check('a new file is written 0644', mode(`${INBOX_DIR}/${inboxFile}`), '644');
        check('the notice says where it went',
            await waitFor(async () => (await notice()).text === `Uploaded ${inboxFile} to ${INBOX_DIR}.`), true);
        check('the new file is revealed in the tree',
            await waitFor(async () => (await selected()) === `${INBOX_DIR}/${inboxFile}`), true);
        check('and its preview opens',
            await waitFor(async () => (await previewText(wrapper)) === 'hello inbox\n'), true);
        check('a sidebar upload types nothing at the prompt',
            dexec(['tmux', 'capture-pane', '-p']).trimEnd().split('\n').pop(), promptBefore);
        await closePreview();
        await uploadBudget(1);
        await pick(uploadButton, local(inboxFile, 'second\n'));
        check('the inbox numbers a taken name instead of asking',
            await waitFor(() => read(`${INBOX_DIR}/ctp up $1 (1).txt`) === 'second\n'), true);
        check('and never shows the collision prompt', await promptShown(), false);
        await waitFor(async () => (await previewText(wrapper)) === 'second\n');
        await closePreview();

        // Upload here, onto a name that is taken: the inline prompt.
        await menuButton(fixtureName).click();
        check('a folder\'s ⋯ menu offers Upload here', await uploadHere.count(), 1);
        await pick(() => uploadHere.click(), local(COLLIDE, 'new: 2\n'));
        check('a taken name asks: Replace, Keep both or Cancel', await waitFor(promptShown), true);
        // Focus on Keep both, the answer that loses nothing: a key pressed
        // without reading the question must never replace a file.
        check('the prompt names the file and folder, and puts focus on Keep both',
            await promptState(),
            (v) => v.text === `${COLLIDE} already exists in ${SIDEBAR_DIR}.` && v.replace && v.focus === 'files-prompt-keep');
        check('while it waits, the notice asks for an answer instead of still saying Checking',
            (await notice()).text, asking(`${COLLIDE} already exists in ${SIDEBAR_DIR}.`));
        await wrapper.locator('#files-prompt-cancel').click();
        check('Cancel uploads nothing, and says so',
            await waitFor(async () => (await notice()).text === `Not uploaded: ${COLLIDE}.`), true);
        check('the file is untouched', read(`${SIDEBAR_DIR}/${COLLIDE}`), 'old: 1\n');
        await menuButton(fixtureName).click();
        await pick(() => uploadHere.click(), local(COLLIDE, 'new: 2\n'));
        await waitFor(promptShown);
        await page.keyboard.press('Escape');
        check('Escape answers Cancel', await waitFor(async () => !(await promptShown())), true);

        // Two taken names in one pick: one question at a time, the notice
        // counting the files behind it. TAKEN is a folder, which Replace
        // cannot replace.
        await menuButton(fixtureName).click();
        await pick(() => uploadHere.click(), [local(COLLIDE, 'new: 2\n'), local(TAKEN, 'never\n')]);
        check('while a question waits, the notice counts the files behind it',
            await waitFor(async () => (await notice()).text
                === `${asking(`${COLLIDE} already exists in ${SIDEBAR_DIR}.`)} 1 more waiting.`), true);
        await wrapper.locator('#files-prompt-cancel').click();
        check('a name taken by a folder offers only Keep both and Cancel, with focus on Keep both',
            await waitFor(async () => {
                const v = await promptState();
                return v.text.startsWith(`${TAKEN} already exists in ${SIDEBAR_DIR} and is not a regular file`)
                    && !v.replace && v.focus === 'files-prompt-keep';
            }), true);
        await wrapper.locator('#files-prompt-cancel').click();
        check('both are left out, under one line',
            await waitFor(async () => (await notice()).text === `Not uploaded: ${COLLIDE}, ${TAKEN}.`), true);
        check('and the folder is untouched', dexec(['sh', '-c', '[ -d "$1" ] && ls -A "$1" | wc -l', 'sh', `${SIDEBAR_DIR}/${TAKEN}`]).trim(), '0');
        await menuButton(fixtureName).click();
        await pick(() => uploadHere.click(), local(COLLIDE, 'kept: 3\n'));
        await waitFor(promptShown);
        await uploadBudget(1);
        await wrapper.locator('#files-prompt-keep').click();
        check('Keep both numbers the new file',
            await waitFor(() => read(`${SIDEBAR_DIR}/collide (1).yaml`) === 'kept: 3\n'), true);
        check('and reveals it in its folder',
            await waitFor(async () => (await selected()) === `${SIDEBAR_DIR}/collide (1).yaml`), true);
        await waitFor(async () => (await previewText(wrapper)) === 'kept: 3\n');
        await closePreview();
        await menuButton(fixtureName).click();
        await pick(() => uploadHere.click(), local(COLLIDE, 'replaced: 4\n'));
        await waitFor(promptShown);
        await uploadBudget(1);
        await wrapper.locator('#files-prompt-replace').click();
        check('Replace swaps in the new content',
            await waitFor(() => read(`${SIDEBAR_DIR}/${COLLIDE}`) === 'replaced: 4\n'), true);
        check('and keeps the old file\'s mode', mode(`${SIDEBAR_DIR}/${COLLIDE}`), '600');
        check('the notice says it replaced it',
            await waitFor(async () => (await notice()).text === `Replaced ${COLLIDE} in ${SIDEBAR_DIR}.`), true);
        await waitFor(async () => (await previewText(wrapper)) === 'replaced: 4\n');
        await closePreview();

        // A question that comes while the user is typing in the terminal
        // (a drop, or a batch that reached a taken name minutes later) must
        // not take focus: their next Enter would answer it unseen. It waits
        // in the sidebar, and the notice says so.
        await wrapper.evaluate(`${TERM}.focus()`);
        check('fixture: focus is in the terminal',
            await wrapper.evaluate('document.activeElement && document.activeElement.id'), 'terminal-frame');
        sendKeys('C-u');   // an empty command line, so the Enter below runs nothing
        await dropOn({ folder: fixtureName }, COLLIDE, 'dropped: 5\n');
        check('a taken name dropped while typing in the terminal still asks', await waitFor(promptShown), true);
        check('but focus stays in the terminal, and the notice asks for an answer',
            { focus: (await promptState()).focus, text: (await notice()).text },
            (v) => v.focus === 'terminal-frame' && v.text === asking(`${COLLIDE} already exists in ${SIDEBAR_DIR}.`));
        const paneBefore = tmux('#{history_size} #{cursor_y}');
        await page.keyboard.press('Enter');
        check('fixture: the Enter reached the terminal',
            await waitFor(() => tmux('#{history_size} #{cursor_y}') !== paneBefore), true);
        check('and did not answer the question',
            { shown: await promptShown(), content: read(`${SIDEBAR_DIR}/${COLLIDE}`) },
            (v) => v.shown && v.content === 'replaced: 4\n');
        if (await promptShown()) await wrapper.locator('#files-prompt-cancel').click();
        await waitFor(async () => (await notice()).text === `Not uploaded: ${COLLIDE}.`);
        await closePreview();   // only there if a key did answer, but then in the way
        // Nor with the preview open, even with focus on the page itself:
        // Escape there closes the preview, and must not answer instead.
        await list.locator('.files-row', { hasText: SIDEBAR_FILE }).click();
        await waitFor(async () => (await previewText(wrapper)) === 'sidebar: ok\n');
        await wrapper.evaluate('document.activeElement && document.activeElement.blur()');
        await dropOn({ folder: fixtureName }, COLLIDE, 'dropped: 6\n');
        await waitFor(promptShown);
        check('with the preview open, a question takes no focus', (await promptState()).focus, (v) => v !== 'files-prompt-keep');
        await page.keyboard.press('Escape');
        check('and Escape closes the preview, leaving the question',
            await waitFor(async () => !(await previewState(wrapper)).active && await promptShown()), true);
        if (await promptShown()) await wrapper.locator('#files-prompt-cancel').click();
        check('the file is still the replaced one', read(`${SIDEBAR_DIR}/${COLLIDE}`), 'replaced: 4\n');

        // Answered, the question gives focus back where it took it from.
        // From nowhere (the page body), or from something gone meanwhile
        // (a row the tree drew again), that is Upload: never the page,
        // where the next Tab would start from the top.
        const focusedId = () => wrapper.evaluate('document.activeElement ? document.activeElement.id || document.activeElement.tagName : null');
        await wrapper.evaluate('document.activeElement && document.activeElement.blur()');
        await dropOn({ folder: fixtureName }, COLLIDE, 'dropped: 7\n');
        await waitFor(promptShown);
        check('fixture: a question asked from nowhere takes focus', (await promptState()).focus, 'files-prompt-keep');
        await page.keyboard.press('Escape');
        check('answered, a question asked from nowhere gives focus to Upload, not the page',
            await waitFor(async () => !(await promptShown()) && (await focusedId()) === 'files-upload-btn'), true);
        await menuButton(fixtureName).focus();
        await wrapper.evaluate('document.activeElement.dataset.ctpOld = "1"');
        await dropOn({ folder: fixtureName }, COLLIDE, 'dropped: 8\n');
        await waitFor(promptShown);
        check('fixture: a question asked from a row\'s ⋯ takes focus', (await promptState()).focus, 'files-prompt-keep');
        // A refresh draws every row again: the ⋯ focus came from is gone.
        // Clicked from script, so focus stays on the question.
        await wrapper.evaluate('document.getElementById("files-refresh").click()');
        check('fixture: the ⋯ focus came from is gone, and the row is back',
            await waitFor(async () => await wrapper.evaluate('!document.querySelector("[data-ctp-old]")')
                && await menuButton(fixtureName).count() === 1), true);
        await page.keyboard.press('Escape');
        check('answered after the tree was drawn again, it gives focus to Upload, not the page',
            await waitFor(async () => !(await promptShown()) && (await focusedId()) === 'files-upload-btn'), true);
        // From something still there but hidden meanwhile, where focus()
        // does not take: Upload too.
        await menuButton(fixtureName).focus();
        await wrapper.evaluate('document.activeElement.dataset.ctpHide = "1"');
        await dropOn({ folder: fixtureName }, COLLIDE, 'dropped: 9\n');
        await waitFor(promptShown);
        check('fixture: the question took focus from the ⋯ about to be hidden', (await promptState()).focus, 'files-prompt-keep');
        await wrapper.evaluate('document.querySelector("[data-ctp-hide]").style.display = "none"');
        await page.keyboard.press('Escape');
        check('answered after the ⋯ it came from was hidden, it gives focus to Upload, not the page',
            await waitFor(async () => !(await promptShown()) && (await focusedId()) === 'files-upload-btn'), true);
        await wrapper.evaluate(`(() => {
            const b = document.querySelector('[data-ctp-hide]');
            if (b) { b.style.display = ''; delete b.dataset.ctpHide; }
        })()`);
        check('and the file is still the replaced one', read(`${SIDEBAR_DIR}/${COLLIDE}`), 'replaced: 4\n');

        // Drops (synthetic, see dropOn above).
        // Positive control: an image dropped on the terminal shows its
        // overlay and goes to the terminal's image upload, which is what a
        // sidebar drop must not do.
        const onTerminal = await dropOn('#terminal-container', 'control.png', 'png');
        check('fixture: the terminal\'s drop overlay shows over the terminal', onTerminal.overlay, true);
        check('fixture: an image dropped on the terminal reaches its image upload',
            await waitFor(() => imageUploads === 1), true);
        await uploadBudget(1);
        const overFolder = await dropOn({ folder: fixtureName }, 'pic.png', 'png');
        check('an image dropped on a folder row uploads into that folder',
            await waitFor(() => read(`${SIDEBAR_DIR}/pic.png`) === 'png'), true);
        check('and never also goes to the terminal', imageUploads, 1);
        check('the terminal\'s drop overlay stays off over the sidebar', overFolder.overlay, false);
        await closePreview();
        await uploadBudget(1);
        await dropOn('#files-footer', 'loose.txt', 'loose\n');
        check('a drop elsewhere on the sidebar goes to the inbox',
            await waitFor(() => read(`${INBOX_DIR}/loose.txt`) === 'loose\n'), true);
        // The preview covers the whole page, sidebar and terminal alike. A
        // drop on it has no target the user can see, so it is refused: it
        // must not fall through to the terminal's drop, which sends an
        // image to /data/images and types its path.
        check('fixture: the uploaded file\'s preview is open',
            await waitFor(async () => (await previewText(wrapper)) === 'loose\n'), true);
        const paneBeforeDrop = dexec(['tmux', 'capture-pane', '-p']).trimEnd().split('\n').pop();
        const overPreview = await dropOn('#files-preview', 'onpreview.png', 'png');
        check('a drop on the preview is refused in the notice',
            await waitFor(async () => /close the preview/.test((await notice()).text)), true);
        check('and never reaches the terminal: no overlay, no image upload, nothing typed',
            { overlay: overPreview.overlay, images: imageUploads,
                typed: dexec(['tmux', 'capture-pane', '-p']).trimEnd().split('\n').pop() !== paneBeforeDrop },
            (v) => !v.overlay && v.images === 1 && !v.typed);
        await closePreview();

        // Never into a protected folder or through a symlinked one.
        await menuButton(LOCKED).click();
        check('a protected folder\'s Upload here is disabled, with the reason',
            await wrapper.evaluate(`JSON.stringify((() => {
                const item = [...document.querySelectorAll('#files-menu .files-menu-item')]
                    .find((i) => i.textContent.startsWith('Upload here'));
                return item && { disabled: item.getAttribute('aria-disabled'), text: item.textContent };
            })())`).then(JSON.parse),
            (v) => v && v.disabled === 'true' && /never upload targets/.test(v.text));
        await page.keyboard.press('Escape');
        await menuButton(LINK).click();
        check('a symlinked folder offers no Upload here', await uploadHere.count(), 0);
        check('fixture: its menu is open', await wrapper.evaluate('!document.getElementById("files-menu").hidden'), true);
        await page.keyboard.press('Escape');
        const bodiesBefore = bodies.length;
        await dropOn({ folder: LOCKED }, 'x.txt', 'x');
        check('a drop on a protected folder is refused in the notice, with no upload',
            { said: await waitFor(async () => /secrets/.test((await notice()).text)), sent: bodies.length - bodiesBefore },
            (v) => v.said && v.sent === 0);
        check('the server refuses a protected folder too',
            await wrapper.evaluate(`fetch(${JSON.stringify(`api/files/upload?name=x.txt&dest=${encodeURIComponent(`${SIDEBAR_DIR}/${LOCKED}`)}&check=1&size=1`)},
                { method: 'POST' }).then((r) => r.status)`), 403);

        // A secret-shaped name uploads (certificates belong in /config), and
        // is revealed, but not opened while Show protected files is off.
        await menuButton(fixtureName).click();
        await uploadBudget(1);
        await pick(() => uploadHere.click(), local('cert.pem', 'CERT\n'));
        check('a certificate uploads like any file', await waitFor(() => read(`${SIDEBAR_DIR}/cert.pem`) === 'CERT\n'), true);
        check('it is revealed, and the notice says it is protected',
            await waitFor(async () => (await selected()) === `${SIDEBAR_DIR}/cert.pem`
                && /cert\.pem is protected: turn on Show protected files/.test((await notice()).text)), true);
        check('its preview does not open', (await previewState(wrapper)).active, false);

        // Over upload_max_mb (25 MB by default): refused by the check, so
        // not a byte of the body goes out.
        const before = bodies.length;
        await pick(uploadButton, local('big.bin', Buffer.alloc(26 * 1024 * 1024)));
        check('a file over the limit is refused, naming the limit and its option',
            await waitFor(async () => /26\.0 MB, over the 25 MB upload limit \(the add-on's upload_max_mb option\)/.test((await notice()).text)), true);
        check('and its body is never sent', bodies.length - before, 0);

        // The progress bar, while a body is held back.
        let held = 0;
        const gate = new Promise((r) => { release = r; });
        const isBody = (u) => u.pathname.endsWith('/api/files/upload') && !u.searchParams.has('check');
        await context.route(isBody, async (route) => {
            held++;
            await gate;
            await route.continue().catch(() => {});
        });
        // The bar's highest value while it shows, recorded as it changes:
        // it must move, not sit at 0 until it goes.
        await wrapper.evaluate(`(() => {
            const bar = document.getElementById('files-notice-progress');
            window.ctpBarMax = 0;
            new MutationObserver(() => {
                if (!bar.hidden) window.ctpBarMax = Math.max(window.ctpBarMax, bar.value);
            }).observe(bar, { attributes: true, attributeFilter: ['value', 'hidden'] });
        })()`);
        await uploadBudget(1);
        await pick(uploadButton, local('slow.bin', Buffer.alloc(512 * 1024, 7)));
        check('fixture: the upload is held', await waitFor(() => held === 1), true);
        check('an upload shows its line and a progress bar',
            await waitFor(async () => {
                const n = await notice();
                return n.text === 'Uploading slow.bin…' && n.bar;
            }), true);
        // Dismissing cannot cancel an upload, so it is not offered then.
        check('and no dismiss button while it runs, which would look like cancel', (await notice()).close, false);
        // Meanwhile the user goes back to the terminal: the file is
        // revealed when it is in, but no preview springs up over the
        // terminal they are typing in.
        await wrapper.evaluate(`${TERM}.focus()`);
        release();
        check('the bar goes when it is done',
            await waitFor(async () => {
                const n = await notice();
                return n.text === `Uploaded slow.bin to ${INBOX_DIR}.` && !n.bar;
            }), true);
        check('the bar moved before it went', await wrapper.evaluate('window.ctpBarMax'), (v) => v > 0);
        check('and the result can be dismissed again', await waitFor(async () => (await notice()).close), true);
        check('with focus back in the terminal, the file is revealed but not previewed',
            { selected: await selected(), preview: (await previewState(wrapper)).active,
                focus: await wrapper.evaluate('document.activeElement && document.activeElement.id') },
            (v) => v.selected === `${INBOX_DIR}/slow.bin` && !v.preview && v.focus === 'terminal-frame');
        await closePreview();
        // Nor with the sidebar closed by the time it is in.
        await uploadBudget(1);
        const gate2 = new Promise((r) => { release = r; });
        held = 0;
        await context.unroute(isBody);
        await context.route(isBody, async (route) => {
            held++;
            await gate2;
            await route.continue().catch(() => {});
        });
        await pick(uploadButton, local('closed.txt', 'closed\n'));
        await waitFor(() => held === 1);
        await wrapper.locator('#files-hide').click();
        release();
        check('with the sidebar closed meanwhile, it uploads and nothing opens',
            await waitFor(async () => read(`${INBOX_DIR}/closed.txt`) === 'closed\n'
                && (await selected()) === `${INBOX_DIR}/closed.txt`
                && !(await previewState(wrapper)).active), true);
        await context.unroute(isBody);
        await closePreview();
        await wrapper.locator('#files-btn').click();

        // Two files in one pick: one after another, then one line.
        await uploadBudget(2);
        await pick(uploadButton, [local('m1.txt', '1'), local('m2.txt', '2')]);
        check('two files picked together both upload, under one line',
            await waitFor(async () => (await notice()).text === `Uploaded 2 files to ${INBOX_DIR}.`
                && read(`${INBOX_DIR}/m1.txt`) === '1' && read(`${INBOX_DIR}/m2.txt`) === '2'), true);
        await closePreview();
        // A notice too long for its box scrolls, and Safari puts a scrolling
        // box in the Tab order only with a tabindex: it gets one while it
        // overflows, and only then.
        const isAsk = (u) => u.pathname.endsWith('/api/files/upload') && u.searchParams.has('check');
        // A function of its own, so its unroute leaves the 429 route alone.
        const isAskLong = (u) => isAsk(u);
        const noticeTabindex = () => wrapper.evaluate('document.getElementById("files-notice-text").getAttribute("tabindex")');
        check('a short notice is no tab stop', await noticeTabindex(), null);
        const LONG = 'This refusal is long enough to scroll. '.repeat(30).trim();
        await context.route(isAskLong, (route) => route.fulfill({ status: 403, contentType: 'application/json',
            body: JSON.stringify({ error: LONG }) }));
        await pick(uploadButton, local('long.txt', 'x'));
        check('fixture: the long refusal is in the notice',
            await waitFor(async () => (await notice()).text.includes(LONG)), true);
        check('a notice that overflows its box is a tab stop, so the keyboard can scroll it', await noticeTabindex(), '0');
        // Focus on it when it stops scrolling (the next file's short
        // "Checking" line) stays there: moved, it would lose the reader's
        // place. It keeps its tab stop while it has focus, and loses it on
        // blur if it still fits. The refusal is held back until released,
        // and then (for the next one too) half a second more, so it lands
        // after the sidebar below is closed.
        await context.unroute(isAskLong);
        const longHeld = new Promise((r) => { release = r; });
        await context.route(isAskLong, async (route) => {
            await longHeld;
            await sleep(500);
            await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: LONG }) });
        });
        await wrapper.evaluate('document.getElementById("files-notice-text").focus()');
        check('fixture: the scrolling notice has focus', await focusedId(), 'files-notice-text');
        await dropOn('#files-footer', 'long2.txt', 'x');
        check('fixture: the short "Checking" line replaced the long one',
            await waitFor(async () => (await notice()).text.startsWith('Checking long2.txt')), true);
        check('a notice that stops scrolling with focus on it keeps focus, and its tab stop',
            JSON.stringify({ focus: await focusedId(), tabindex: await noticeTabindex() }),
            JSON.stringify({ focus: 'files-notice-text', tabindex: '0' }));
        await wrapper.locator('#files-upload-btn').focus();
        check('and loses the tab stop once focus leaves it, since it fits',
            await waitFor(async () => (await noticeTabindex()) === null), true);
        release();
        await waitFor(async () => (await notice()).text.includes(LONG));
        // Arriving while the sidebar is closed, it has nothing to scroll;
        // the sidebar reopened, it does again.
        await dropOn('#files-footer', 'long3.txt', 'x');
        await wrapper.locator('#files-hide').click();
        check('fixture: the long refusal arrives while the sidebar is closed',
            await waitFor(async () => (await notice()).text.includes(LONG)), true);
        check('a notice in the closed sidebar is no tab stop', await noticeTabindex(), null);
        await wrapper.locator('#files-btn').click();
        check('the sidebar reopened, the long notice is a tab stop again',
            await waitFor(async () => (await noticeTabindex()) === '0'), true);
        await context.unroute(isAskLong);
        // Too many uploads (429, faked): the batch stops at the first one,
        // and one line covers every file it left, instead of a refusal per
        // file each spending another request.
        let busyChecks = 0;
        await context.route(isAsk, (route) => {
            busyChecks++;
            return route.fulfill({ status: 429, contentType: 'application/json',
                body: JSON.stringify({ error: 'Too many uploads. Try again in a minute.' }) });
        });
        await pick(uploadButton, [local('b1.txt', '1'), local('b2.txt', '2'), local('b3.txt', '3')]);
        check('a batch stops at the first 429, under one line for all it left',
            await waitFor(async () => (await notice()).text === '⏳ 3 not uploaded: too many uploads, try again in a minute.'), true);
        check('and asks nothing more after it', busyChecks, 1);
        check('a notice that fits again is no tab stop again', await noticeTabindex(), null);
        await context.unroute(isAsk);
        // (UPLOAD_PART is the download checks' stand-in, not a real one.)
        check('no upload part is left anywhere',
            dexec(['find', '/config', '-maxdepth', '3', '-name', '.ctp-upload-*.part', '!', '-name', UPLOAD_PART]).trim(), '');
        // uploadBudget must have seen every body that reached the server.
        check('fixture: every real upload body was budgeted', bodies.length, 11);
    } finally {
        release();
        await context.close();
        rmSync(pickDir, { recursive: true, force: true });
        dexec(['rm', '-rf', INBOX_DIR]);
    }
}

// 9. The terminal's own ways in: the paperclip, a paste and a drop take any
//    file. Small images (PNG, JPEG, GIF, WebP, SVG, at most 10 MB) still go
//    to the image upload, faked here so section 5 keeps the image limiter's
//    budget; everything else goes to the inbox through api/files/upload.
//    Every path is typed at the prompt, quoted where it needs it, without
//    Enter. A real paste or drop over the terminal lands in its frame's
//    document (the page hands the pointer to the frame there), so both are
//    dispatched there as well as on the page. What landed is read from the
//    container and what was typed from tmux. Its own context with service
//    workers blocked, so context.route sees what it fakes. Every real upload
//    body takes its share of uploadBudget first.
async function checkTerminalUploads(browser, url) {
    dexec(['rm', '-rf', INBOX_DIR]);
    await resetPane();
    const exists = (p) => dexec(['sh', '-c', '[ -e "$1" ] && echo yes || echo no', 'sh', p]).trim() === 'yes';
    const read = (p) => (exists(p) ? dexec(['cat', p]) : null);
    const size = (p) => (exists(p) ? Number(dexec(['stat', '-c', '%s', p]).trim()) : -1);
    const pickDir = mkdtempSync(join(tmpdir(), 'ctp-terminal-upload-'));
    const local = (name, body) => {
        const p = join(pickDir, name);
        writeFileSync(p, body);
        return p;
    };
    // The pane's last line (wrapped lines joined) and what follows the
    // prompt on it. Had Enter been sent, a fresh prompt would be there.
    const lastLine = () => dexec(['tmux', 'capture-pane', '-pJ']).trimEnd().split('\n').pop();
    // The bare prompt: the same last line twice in a row, once seq's
    // output (ending in 300) has been followed by it.
    let promptLine = '';
    await waitFor(() => {
        const line = lastLine();
        const settled = line === promptLine && line !== '300';
        promptLine = line;
        return settled;
    });
    const atPrompt = () => {
        const line = lastLine();
        return line.startsWith(promptLine) ? line.slice(promptLine.length).trimStart() : `(not at the prompt) ${line}`;
    };
    const typed = (text) => waitFor(() => atPrompt() === text);
    const clearPrompt = async () => {
        sendKeys('C-u');
        await waitFor(() => atPrompt() === '');
    };
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    // Inbox requests by kind: bodies (which reach the server unless a route
    // aborts them) and check=1 questions.
    const bodies = [];
    const asks = [];
    context.on('request', (r) => {
        const u = new URL(r.url());
        if (r.method() !== 'POST' || !u.pathname.endsWith('/api/files/upload')) return;
        (u.searchParams.has('check') ? asks : bodies).push(u);
    });
    // The image upload, faked: counted, never sent. Each answer names its
    // own file, so a typed path says which upload it was.
    let imageUploads = 0;
    await context.route((u) => /\/upload$/.test(u.pathname) && !u.pathname.endsWith('/api/files/upload'), (route) => {
        imageUploads++;
        const name = `pasted-0-0000000${imageUploads}.png`;
        return route.fulfill({ status: 200, contentType: 'application/json',
            body: JSON.stringify({ success: true, path: `/data/images/${name}`, filename: name, size: 3 }) });
    });
    let budgeted = 0;
    const budget = async (n) => {
        budgeted += n;
        await uploadBudget(n);
    };
    try {
        await page.goto(url, { waitUntil: 'load' });
        const wrapper = await wrapperFrame(page);
        const status = () => wrapper.evaluate('document.getElementById("status").textContent');
        const pick = async (files) => {
            const [chooser] = await Promise.all([page.waitForEvent('filechooser'), wrapper.locator('#upload-btn').click()]);
            await chooser.setFiles(files);
        };
        // Synthetic drops and pastes with a real DataTransfer: on the page
        // over the terminal, or in the terminal's frame on xterm's own
        // elements. files: [name, type, text or a byte count].
        const fire = (where, kind, { files = [], text = null } = {}) => wrapper.evaluate(`(() => {
            const where = ${JSON.stringify(where)};
            const kind = ${JSON.stringify(kind)};
            const frame = document.getElementById('terminal-frame').contentWindow;
            const w = where === 'frame' ? frame : window;
            const target = where === 'frame'
                ? (kind === 'paste' ? frame.term.textarea : frame.term.element.querySelector('.xterm-screen'))
                : (kind === 'paste' ? document.body : document.getElementById('terminal-container'));
            const dt = new w.DataTransfer();
            const text = ${JSON.stringify(text)};
            if (text !== null) dt.setData('text/plain', text);
            for (const [name, type, body] of ${JSON.stringify(files)}) {
                dt.items.add(new w.File([typeof body === 'number' ? new Uint8Array(body) : body], name, { type }));
            }
            const overlay = () => document.getElementById('drop-zone').classList.contains('active');
            if (kind === 'paste') {
                const ev = new w.Event('paste', { bubbles: true, cancelable: true });
                Object.defineProperty(ev, 'clipboardData', { value: dt });
                target.dispatchEvent(ev);
                return JSON.stringify({ prevented: ev.defaultPrevented });
            }
            const drag = (type) => new w.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
            target.dispatchEvent(drag('dragenter'));
            target.dispatchEvent(drag('dragover'));
            const during = overlay();
            const drop = drag('drop');
            target.dispatchEvent(drop);
            return JSON.stringify({ overlay: during, prevented: drop.defaultPrevented, after: overlay() });
        })()`).then(JSON.parse);

        // The paperclip takes any file, several at once.
        const looks = await wrapper.evaluate(`JSON.stringify({
            title: document.getElementById('upload-btn').title,
            label: document.getElementById('upload-btn').getAttribute('aria-label'),
            accept: document.getElementById('file-input').getAttribute('accept'),
            multiple: document.getElementById('file-input').multiple,
            drop: document.getElementById('drop-zone-text').textContent,
        })`);
        check('the paperclip is "Upload file", and its picker takes any file, several at once', looks,
            JSON.stringify({ title: 'Upload file', label: 'Upload file', accept: null, multiple: true, drop: 'Drop file here' }));
        if (JSON.parse(looks).accept !== null) return;   // the images-only flow: everything below would only time out

        const pdf = 'report $1.pdf';
        await budget(1);
        await pick(local(pdf, '%PDF-1.4 ctp\n'));
        check('a file picked with the paperclip lands in the inbox',
            await waitFor(() => read(`${INBOX_DIR}/${pdf}`) === '%PDF-1.4 ctp\n'), true);
        check('and its path is typed at the prompt, quoted, without Enter', await typed(`'${INBOX_DIR}/${pdf}'`), true);
        check('it never goes to the image upload', imageUploads, 0);
        await clearPrompt();

        await pick(local('small.png', PNG_A));
        check('a small image picked with the paperclip still goes to the image upload',
            await waitFor(() => imageUploads === 1), true);
        check('and its path is typed as it is', await typed('/data/images/pasted-0-00000001.png'), true);
        check('and none of it lands in the inbox', exists(`${INBOX_DIR}/small.png`), false);
        await clearPrompt();

        await budget(1);
        await pick([local('two.png', PNG_B), local('notes v2.txt', 'notes\n')]);
        check('files picked together are typed in order, space-separated, each quoted as it needs',
            await typed(`/data/images/pasted-0-00000002.png '${INBOX_DIR}/notes v2.txt'`), true);
        await clearPrompt();

        // Dropped on the page over the terminal: an image over 10 MB and a
        // HEIC photo go to the inbox.
        const BIG = 10 * 1024 * 1024 + 1;
        await budget(2);
        const onPage = await fire('page', 'drop', { files: [['big.png', 'image/png', BIG], ['photo.heic', 'image/heic', 'heic']] });
        check('a file drag over the terminal shows the drop overlay, and the drop hides it',
            onPage, (v) => v.overlay && !v.after);
        check('an image over 10 MB and a HEIC photo dropped on the terminal go to the inbox',
            await waitFor(() => size(`${INBOX_DIR}/big.png`) === BIG && read(`${INBOX_DIR}/photo.heic`) === 'heic'), true);
        check('and both paths are typed', await typed(`${INBOX_DIR}/big.png ${INBOX_DIR}/photo.heic`), true);
        check('still no image upload for them', imageUploads, 2);
        await clearPrompt();

        await budget(1);
        await fire('page', 'paste', { files: [['clip.pdf', 'application/pdf', 'clip\n']] });
        check('a file pasted with the page focused goes to the inbox, its path typed',
            (await waitFor(() => read(`${INBOX_DIR}/clip.pdf`) === 'clip\n')) && (await typed(`${INBOX_DIR}/clip.pdf`)), true);
        await clearPrompt();

        // Over the terminal, the page hands the pointer to the terminal's
        // frame, so a real paste or drop there happens in its document.
        check('fixture: over the terminal, the pointer goes to its frame',
            await wrapper.evaluate(`(() => {
                const r = document.getElementById('terminal-frame').getBoundingClientRect();
                return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.id;
            })()`), 'terminal-frame');
        const mouseMode = () => wrapper.evaluate(`(() => {
            const t = ${TERM};
            return (t.modes && t.modes.mouseTrackingMode) || t._core?.coreMouseService?.activeProtocol || null;
        })()`);
        const modeBefore = await mouseMode();
        check('fixture: tmux has the mouse, so xterm is reporting it', modeBefore, (m) => typeof m === 'string' && !/^none$/i.test(m));
        await budget(1);
        const inFrame = await fire('frame', 'drop', { files: [['frame drop.txt', 'text/plain', 'frame\n']] });
        check('a file drag inside the terminal frame shows the overlay, and its drop is taken',
            inFrame, (v) => v.overlay && v.prevented && !v.after);
        check('a file dropped inside the terminal frame lands in the inbox, its path typed',
            (await waitFor(() => read(`${INBOX_DIR}/frame drop.txt`) === 'frame\n'))
                && (await typed(`'${INBOX_DIR}/frame drop.txt'`)), true);
        check('mouse reporting is just as it was', await mouseMode(), modeBefore);
        await clearPrompt();

        await fire('frame', 'paste', { files: [['image.png', 'image/png', 'png']] });
        check('a screenshot pasted with the terminal focused goes to the image upload, its path typed',
            (await waitFor(() => imageUploads === 3)) && (await typed('/data/images/pasted-0-00000003.png')), true);
        await clearPrompt();

        // Text pastes stay xterm's: plain text, and text with a file beside
        // it (spreadsheet cells come with a picture of themselves).
        await fire('frame', 'paste', { text: 'echo ctp-plain-paste' });
        check('a text paste in the terminal is left to xterm, which types it', await typed('echo ctp-plain-paste'), true);
        await clearPrompt();
        await fire('frame', 'paste', { text: 'cells', files: [['cells.png', 'image/png', 'png']] });
        check('text with a file beside it pastes the text', await typed('cells'), true);
        await clearPrompt();
        // Positive control for "and uploads nothing": terminal uploads queue
        // in order, so had cells.png gone up, this one would be the fifth.
        await fire('frame', 'paste', { files: [['after.png', 'image/png', 'png']] });
        check('and uploads nothing: the next pasted image is the only upload since',
            (await typed('/data/images/pasted-0-00000004.png')) && imageUploads === 4, true);
        await clearPrompt();

        // Refusals: in the status line, and nothing typed for the refused.
        await budget(1);
        const bodiesBefore = bodies.length;
        await fire('page', 'drop', { files: [['ok.txt', 'text/plain', 'ok\n'], ['big.bin', 'application/octet-stream', 26 * 1024 * 1024]] });
        check('a file over upload_max_mb is refused in the status line, naming the limit and its option',
            await waitFor(async () => /26\.0 MB, over the 25 MB upload limit \(the add-on's upload_max_mb option\)/.test(await status())), true);
        check('the file before it in the batch is still typed', await typed(`${INBOX_DIR}/ok.txt`), true);
        check('and the refused body is never sent', bodies.length - bodiesBefore, 1);
        // "Sent to terminal: …" came first and arms a 5 s clear; the refusal
        // after it must outlive that. Polled for 6.5 s: it must never go.
        check('the refusal stays past the 5 s clear of the line before it',
            await waitFor(async () => !/upload limit/.test(await status()), { timeout: 6500 }), false);
        await clearPrompt();

        let busyAsks = 0;
        const isAsk = (u) => u.pathname.endsWith('/api/files/upload') && u.searchParams.has('check');
        await context.route(isAsk, (route) => {
            busyAsks++;
            return route.fulfill({ status: 429, contentType: 'application/json',
                body: JSON.stringify({ error: 'Too many uploads, try again in a minute' }) });
        });
        await fire('page', 'drop', { files: [['b1.txt', 'text/plain', '1'], ['b2.txt', 'text/plain', '2'], ['b3.txt', 'text/plain', '3']] });
        check('a batch stops at the first 429, with one line for all it left',
            await waitFor(async () => (await status()) === '⏳ 3 not uploaded: too many uploads, try again in a minute.'), true);
        check('and asks nothing more after it', busyAsks, 1);
        check('nothing is typed for them', atPrompt(), '');
        await context.unroute(isAsk);

        const isBody = (u) => u.pathname.endsWith('/api/files/upload') && !u.searchParams.has('check');
        await context.route(isBody, (route) => route.abort());
        await fire('page', 'drop', { files: [['lost.txt', 'text/plain', 'lost\n']] });
        check('an upload that gets no answer says so',
            await waitFor(async () => /^⚠️ Could not reach the add-on to upload lost\.txt\./.test(await status())), true);
        check('and types nothing', atPrompt(), '');
        await context.unroute(isBody);

        // When the terminal cannot take the text, uploadImage's old
        // fallback: the clipboard, else the status line.
        await budget(1);
        await wrapper.evaluate(`(() => {
            const f = document.getElementById('terminal-frame').contentWindow;
            window.ctpTerm = f.term;
            f.term = undefined;
        })()`);
        try {
            await fire('page', 'drop', { files: [['fallback x.txt', 'text/plain', 'fb\n']] });
            check('when the terminal cannot take the path, it goes to the clipboard or the status line instead',
                await waitFor(async () => /^(Copied path: |Path: )'\/config\/uploads\/fallback x\.txt'/.test(await status())), true);
        } finally {
            await wrapper.evaluate('document.getElementById("terminal-frame").contentWindow.term = window.ctpTerm');
        }
        check('and nothing was typed', atPrompt(), '');

        // (UPLOAD_PART is the download checks' stand-in, not a real one.)
        check('no upload part is left anywhere',
            dexec(['find', '/config', '-maxdepth', '3', '-name', '.ctp-upload-*.part', '!', '-name', UPLOAD_PART]).trim(), '');
        // uploadBudget must have seen every body that reached the server
        // (lost.txt's was aborted by the route, so it never did).
        check('fixture: every real upload body was budgeted', bodies.length - 1, budgeted);
    } finally {
        await context.close();
        rmSync(pickDir, { recursive: true, force: true });
        dexec(['rm', '-rf', INBOX_DIR]);
        sendKeys('C-u');
    }
}

// If upload-client.js does not load (a 404 while the add-on updates), the
// terminal still works: the paperclip goes, and so does the Files button
// (the sidebar uploads through it too). Its own context with service
// workers blocked, so the worker's precached copy cannot answer the aborted
// request. wrapperFrame() itself waits for a live terminal.
async function checkUploadClientMissing(browser, url) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    let aborted = 0;
    await page.route('**/upload-client.js', (route) => { aborted++; return route.abort(); });
    try {
        await page.goto(url, { waitUntil: 'load' });
        const wrapper = await wrapperFrame(page);
        check('fixture: the upload client script was blocked', aborted, (n) => n >= 1);
        check('without upload-client.js the paperclip and the Files button go, and the terminal still runs',
            await wrapper.evaluate(`JSON.stringify({
                paperclip: getComputedStyle(document.getElementById('upload-btn')).display,
                files: getComputedStyle(document.getElementById('files-btn')).display,
                client: typeof window.UploadClient,
            })`), JSON.stringify({ paperclip: 'none', files: 'none', client: 'undefined' }));
    } finally {
        await context.close();
    }
}

// Inside Home Assistant the on-screen keyboard shrinks only the TOP window's
// visual viewport (iOS, and Chromium by default); the ingress frame's own
// stays full height, so following it alone left the prompt behind the
// keyboard. A page scale on the top page reproduces that condition: the top
// visual viewport shrinks while innerHeight and the frame stay as they are.
// CDP is Chromium-only, so WebKit skips; the direct port has no outer window.
// Its own context, so the zoom cannot leak into the other checks.
async function checkKeyboardViewport(browser, engine, mode, url) {
    if (mode !== 'ingress') return;
    if (engine.name() !== 'chromium') {
        console.log('skip  - the keyboard fit under ingress (needs CDP page scale, Chromium only)');
        return;
    }
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        await page.goto(url, { waitUntil: 'load' });
        const wrapper = await wrapperFrame(page);
        const cdp = await context.newCDPSession(page);
        const topView = () => page.evaluate(`JSON.stringify({
            height: visualViewport.height,
            offsetTop: visualViewport.offsetTop,
            inner: innerHeight,
            frameTop: document.getElementById('ingress-frame').getBoundingClientRect().top,
        })`).then(JSON.parse);
        const layout = () => wrapper.evaluate(`JSON.stringify({
            app: getComputedStyle(document.documentElement).getPropertyValue('--app-height').trim(),
            container: document.getElementById('container').getBoundingClientRect().height,
            own: visualViewport.height,
            rows: ${TERM}.rows,
        })`).then(JSON.parse);
        const near = (a, b) => Math.abs(a - b) <= 1;

        const before = await layout();
        check('fixture: the page fills the ingress frame before any zoom',
            before, (v) => near(v.container, v.own));

        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
        await waitFor(async () => { const t = await topView(); return t.height < t.inner - 1; });
        const zoomed = await topView();
        check('fixture: page scale shrinks the top visual viewport but not innerHeight',
            zoomed, (t) => t.height < t.inner - 1 && near(t.inner, before.own + t.frameTop));
        const aboveKeyboard = zoomed.offsetTop + zoomed.height - zoomed.frameTop;
        await waitFor(async () => near((await layout()).container, aboveKeyboard));
        const shrunk = await layout();
        check('with the top viewport shrunk (the keyboard), the page keeps to the part of the frame above it',
            { ...shrunk, expected: aboveKeyboard },
            (v) => near(v.container, v.expected) && near(parseFloat(v.app), v.container) && v.own === before.own);
        await waitFor(async () => (await layout()).rows < before.rows);
        check('the terminal refits to the shorter page', (await layout()).rows, (r) => r < before.rows);

        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
        await waitFor(async () => near((await layout()).container, before.own));
        await waitFor(async () => (await layout()).rows === before.rows);
        check('with the top viewport restored, the page and terminal get their height back',
            await layout(), (v) => near(v.container, before.own) && v.rows === before.rows);
    } finally {
        await context.close();
    }
}

// HA's top window outlives the ingress iframe: a reload replaces the frame's
// document, and leaving the panel and coming back replaces the frame itself.
// Each wrapper document adds a resize and a scroll listener to the TOP
// visual viewport and must take them off on pagehide, or every visit leaves
// two more behind, still firing into a dead document and keeping it alive.
// The top window's add/removeEventListener are counted before anything
// runs, so the count is of live listeners whatever registered them. Ingress
// only: on the direct port the wrapper is the top window and adds none.
const COUNT_TOP_VIEWPORT_LISTENERS = `(() => {
    if (window !== window.top || !window.visualViewport) return;
    const vv = window.visualViewport;
    const add = vv.addEventListener;
    const remove = vv.removeEventListener;
    const live = [];
    let adds = 0;
    const at = (type, fn) => live.findIndex((l) => l.type === type && l.fn === fn);
    vv.addEventListener = function (type, fn, opts) {
        adds++;
        if (at(type, fn) < 0) live.push({ type, fn });
        return add.call(this, type, fn, opts);
    };
    vv.removeEventListener = function (type, fn, opts) {
        const i = at(type, fn);
        if (i >= 0) live.splice(i, 1);
        return remove.call(this, type, fn, opts);
    };
    window.__ctpTopListeners = () => JSON.stringify({ adds, live: live.map((l) => l.type).sort() });
})()`;

async function checkOuterViewportTeardown(browser, mode, url) {
    if (mode !== 'ingress') return;
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript(COUNT_TOP_VIEWPORT_LISTENERS);
    const page = await context.newPage();
    const listeners = () => page.evaluate('window.__ctpTopListeners()').then(JSON.parse);
    const BOTH = JSON.stringify(['resize', 'scroll']);
    try {
        await page.goto(url, { waitUntil: 'load' });
        await wrapperFrame(page);
        const first = await listeners();
        check('fixture: the counter sees the wrapper add its resize and scroll listeners to the top viewport',
            first, (v) => v.adds === 2 && JSON.stringify(v.live) === BOTH);

        // Alternating: a reload of the frame's document, then HA dropping the
        // frame and making a new one, as on leaving the panel and returning.
        const cycles = [
            ['a frame reload', `document.getElementById('ingress-frame').contentWindow.location.reload()`],
            ['a new ingress frame', `(() => {
                const old = document.getElementById('ingress-frame');
                old.replaceWith(old.cloneNode());
            })()`],
        ];
        const counts = [];
        for (let i = 0; i < 4; i++) {
            const [, script] = cycles[i % cycles.length];
            const addsBefore = (await listeners()).adds;
            await page.evaluate(script);
            // The new document has attached once its adds arrive; the old
            // one's teardown ran on its pagehide, before the new one loaded.
            await waitFor(async () => (await listeners()).adds >= addsBefore + 2, { timeout: 20000 });
            await wrapperFrame(page);
            counts.push({ after: cycles[i % cycles.length][0], ...(await listeners()) });
        }
        check('fixture: every new wrapper document attached to the top viewport again',
            counts.map((c) => c.adds), (a) => a.every((n, i) => n === 2 * (i + 2)));
        check('the top viewport keeps exactly the live document\'s two listeners across reloads and new frames',
            counts, (c) => c.every((v) => JSON.stringify(v.live) === BOTH));
    } finally {
        await context.close();
    }
}

// viewport-fit.js failing to load (a 404 mid-update): the page must still
// size itself, from its own visual viewport as before the module existed,
// and keep following it, with no uncaught error from the missing global.
// Errors are collected in every frame before any script runs; a thrown probe
// proves the collector sees the wrapper's.
async function checkViewportFitMissing(browser, url) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript(`window.__ctpErrors = [];
        window.addEventListener('error', (e) => window.__ctpErrors.push(String(e.message)));
        window.addEventListener('unhandledrejection', (e) => window.__ctpErrors.push('rejection: ' + String(e.reason)));`);
    const page = await context.newPage();
    let aborted = 0;
    await page.route('**/viewport-fit.js', (route) => { aborted++; return route.abort(); });
    try {
        await page.goto(url, { waitUntil: 'load' });
        const wrapper = await wrapperFrame(page);
        const layout = () => wrapper.evaluate(`JSON.stringify({
            app: getComputedStyle(document.documentElement).getPropertyValue('--app-height').trim(),
            container: document.getElementById('container').getBoundingClientRect().height,
            own: visualViewport.height,
            rows: ${TERM}.rows,
        })`).then(JSON.parse);
        const sized = (v) => v.app === `${Math.round(v.own)}px` && Math.abs(v.container - v.own) <= 1;
        check('fixture: the viewport fit script was blocked', aborted, (n) => n >= 1);
        check('fixture: the page has no ViewportFit', await wrapper.evaluate('typeof window.ViewportFit'), 'undefined');
        const before = await layout();
        check('without viewport-fit.js the page sizes itself from its own viewport, and the terminal runs',
            before, (v) => sized(v) && v.rows > 0);

        const viewport = page.viewportSize();
        await page.setViewportSize({ width: viewport.width, height: viewport.height - 160 });
        await waitFor(async () => { const v = await layout(); return v.own < before.own && sized(v); });
        check('and follows that viewport when it shrinks',
            await layout(), (v) => v.own < before.own && sized(v));

        await wrapper.evaluate(`setTimeout(() => { throw new Error('ctp-probe'); })`);
        const errors = () => wrapper.evaluate('JSON.stringify(window.__ctpErrors)').then(JSON.parse);
        await waitFor(async () => (await errors()).some((m) => m.includes('ctp-probe')));
        const seen = await errors();
        check('fixture: the error collector sees an uncaught error in the wrapper',
            seen.some((m) => m.includes('ctp-probe')), true);
        check('and the missing module threw none',
            seen.filter((m) => !m.includes('ctp-probe')), (e) => e.length === 0);
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
    check('the upload client is served with revalidation',
        await cacheControl('upload-client.js'), 'no-cache');
    check('the service worker is served with revalidation',
        await cacheControl('sw.js'), 'no-cache');
    // The Files sidebar's UI moved out of index.html into its own script. It
    // must be served, with the same revalidation as every other script (or a
    // browser could pair a cached old copy with a new index.html), and it
    // must be what runs the sidebar.
    const served = async (path) => {
        const res = await fetch(base + path);
        return { status: res.status, cacheControl: res.headers.get('cache-control') };
    };
    check('the Files sidebar UI script is served, with revalidation',
        await served('files-sidebar-ui.js'), (v) => v.status === 200 && v.cacheControl === 'no-cache');
    check('the Files sidebar UI script is loaded by the page',
        await wrapper.evaluate('typeof window.FilesSidebarUI?.init'), 'function');
    check('icons stay cacheable, and never immutably',
        await cacheControl('icon-192.png'),
        (v) => v === 'public, max-age=86400');

    // 0b. The terminal fills its frame on first load, before anything in this
    //     run resizes the page. ttyd fits once under xterm's DOM renderer, then
    //     its preferences message swaps in WebGL (or canvas), whose cells snap
    //     to whole device pixels - and ttyd refits only for font options, so
    //     the first load sat ~20 columns short (160 of 179 at 1280px) until
    //     something resized the window. Compared against the fit addon's own
    //     proposal for the current layout, so fonts and engines don't matter.
    const fitGap = () => wrapper.evaluate(`(() => {
        const t = ${TERM};
        const fit = t._addonManager._addons
            .map((a) => a.instance)
            .find((i) => typeof i.proposeDimensions === 'function');
        const p = fit.proposeDimensions();
        return p ? p.cols - t.cols : 0;
    })()`);
    await waitFor(async () => (await fitGap()) === 0);
    check('the terminal fills its frame on first load, with no resize',
        await fitGap(), 0);

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
        + 'mkdir "$3"; printf "ref: x\\n" > "$3/HEAD"; printf partial > "$4"; printf partial > "$5"', 'sh',
        `${SIDEBAR_DIR}/${SIDEBAR_FILE}`, `${SIDEBAR_DIR}/secrets.yaml`,
        `${SIDEBAR_DIR}/.git`, `${SIDEBAR_DIR}/download.part`, `${SIDEBAR_DIR}/${UPLOAD_PART}`]);

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
    // Only the wrapper's own upload parts are hidden: a user's download.part
    // is an ordinary file.
    check('the tree hides .git and upload parts, and shows secrets.yaml and other *.part files',
        { git: names.includes('.git'), part: names.includes(UPLOAD_PART), mine: names.includes('download.part'),
            secrets: names.includes('secrets.yaml') },
        (v) => !v.git && !v.part && v.mine && v.secrets);

    // The list's roles must match how it behaves. It was a role="tree" with
    // each folder's ⋯ button inside it, but only treeitems belong in a tree
    // (axe flags it), and a tree promises arrow-key navigation the list never
    // had. Now every row is a plain button reached with Tab: a folder is a
    // disclosure button (aria-expanded) with its ⋯ beside it, and an open
    // folder's contents are a group named after it. The fixture folder is
    // open here, so folder rows, file rows and a group are all present.
    const listRoles = await wrapper.evaluate(`(() => {
        const list = document.getElementById('files-list');
        const name = ${JSON.stringify(SIDEBAR_DIR.split('/').pop())};
        const wrap = [...list.querySelectorAll('.files-row-wrap')]
            .find((w) => w.querySelector('.files-name')?.textContent === name);
        const row = wrap?.querySelector('.files-row');
        const group = wrap?.nextElementSibling;
        return JSON.stringify({
            listRole: list.getAttribute('role'),
            roles: [...new Set([...list.querySelectorAll('[role]')].map((e) => e.getAttribute('role')))],
            buttonsWithRoles: list.querySelectorAll('button[role]').length,
            otherFocusable: list.querySelectorAll('a[href], input, select, textarea, [tabindex]').length,
            folder: row ? row.getAttribute('aria-expanded') : null,
            menu: wrap?.querySelector(':scope > .files-menu-btn')?.getAttribute('aria-haspopup') ?? null,
            group: group ? group.getAttribute('role') + ':' + group.getAttribute('aria-label') : null,
        });
    })()`).then(JSON.parse);
    // The list itself is the sidebar tabs' panel (checkSidebarTabs).
    check('the file list is plain buttons, not a tree, with each ⋯ beside its folder', listRoles,
        (v) => v.listRole === 'tabpanel' && JSON.stringify(v.roles) === '["group"]'
            && v.buttonsWithRoles === 0 && v.otherFocusable === 0
            && v.folder === 'true' && v.menu === 'menu'
            && v.group === `group:${SIDEBAR_DIR.split('/').pop()}`);

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
    await checkSidebarTabs(browser, url);
    await checkDownloads(browser, url);
    await checkZipMenu(browser, url);
    await checkLateProtectedPreview(browser, url);
    await checkPreviewRequests(browser, url);
    await checkStaleListingPreview(browser, url);
    await checkSidebarScriptMissing(browser, url);
    await checkNoResizeObserver(browser, url);
    await checkUploads(browser, url);
    await checkTerminalUploads(browser, url);
    await checkUploadClientMissing(browser, url);
    await checkKeyboardViewport(browser, engine, mode, url);
    await checkOuterViewportTeardown(browser, mode, url);
    await checkViewportFitMissing(browser, url);
    dexec(['rm', '-rf', SIDEBAR_DIR, ZIP_CAP_DIR]);

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
    try { dexec(['rm', '-rf', SIDEBAR_DIR, ZIP_CAP_DIR, INBOX_DIR]); } catch { /* container gone */ }
}

console.log(`\nzip budget: peak ${zipStats.peak}/${ZIP_LIMIT} limiter requests in any ${ZIP_WINDOW_MS / 1000} s, `
    + `waited ${(zipStats.waitedMs / 1000).toFixed(1)} s in all`);
console.log(`upload budget: peak ${uploadStats.peak}/${UPLOAD_BUDGET} uploads (limit ${UPLOAD_LIMIT}, one kept free) in any ${ZIP_WINDOW_MS / 1000} s, `
    + `waited ${(uploadStats.waitedMs / 1000).toFixed(1)} s in all`);
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
