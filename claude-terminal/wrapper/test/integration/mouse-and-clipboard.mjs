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
        // (pinned in files-download.test.js), so accept exactly that one
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
        check('no refusal (404, protected, 429, network, not a plan) started a download, nor a second zip',
            zipPaths(since).sort(), (v) => JSON.stringify(v) === JSON.stringify([SIDEBAR_DIR, `${SIDEBAR_DIR}/${OTHER}`]));
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
    check('the file list is plain buttons, not a tree, with each ⋯ beside its folder', listRoles,
        (v) => v.listRole === null && JSON.stringify(v.roles) === '["group"]'
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
    await checkDownloads(browser, url);
    await checkZipMenu(browser, url);
    await checkLateProtectedPreview(browser, url);
    await checkPreviewRequests(browser, url);
    await checkStaleListingPreview(browser, url);
    await checkSidebarScriptMissing(browser, url);
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
    try { dexec(['rm', '-rf', SIDEBAR_DIR, ZIP_CAP_DIR]); } catch { /* container gone */ }
}

console.log(`\nzip budget: peak ${zipStats.peak}/${ZIP_LIMIT} limiter requests in any ${ZIP_WINDOW_MS / 1000} s, `
    + `waited ${(zipStats.waitedMs / 1000).toFixed(1)} s in all`);
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
