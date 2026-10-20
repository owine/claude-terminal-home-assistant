// Files sidebar UI: the /config tree, the file preview with Insert path and
// Download, the protected toggle, the folder ⋯ menu with its zip download
// and Upload here, uploads (the Upload button, drops, pastes, the collision
// prompt, progress), the notice line, Recent changes, the HA configuration
// check, and the sidebar's open state, tabs and resizable width. The pure helpers it uses
// (quoting, sizes, URLs) are files-sidebar.js, and the upload flow it shares
// with the terminal (asking, sending, batches, reading drops) is
// upload-client.js; both load before this.
//
// Browser only, no module system: this attaches window.FilesSidebarUI and
// does nothing else when it loads. index.html calls init() once, as the
// last thing its page script does, which is when this code ran back when
// it was inline there. The page's elements all exist by then.
//
// init() gets the only three things it uses from the page script:
//   injectIntoTerminal(text)  types text at the prompt (Insert path);
//                             false when the terminal cannot take it
//   copyToClipboard(text)     resolves true when the text was copied
//   setStatus(message, type, persistent)  the header's status line
// Everything else here is its own: its elements, fetches and state. Every
// name and every file body goes in through textContent, never as HTML. Of
// the terminal iframe it touches only the width (ttyd refits itself on its
// window's resize event) and, after Insert path, the terminal's focus.
//
// Deliberately not strict mode: this code ran as part of index.html's
// sloppy-mode script, and moving it here was meant to change nothing about
// how it runs.
(function (root) {
    const DEPS = ['injectIntoTerminal', 'copyToClipboard', 'setStatus'];

    function init(deps) {
        for (const name of DEPS) {
            if (typeof deps?.[name] !== 'function') {
                throw new TypeError('FilesSidebarUI.init: ' + name + ' must be a function');
            }
        }
        const { injectIntoTerminal, copyToClipboard, setStatus } = deps;
        const helpers = window.FilesSidebar;
        const client = window.UploadClient;
        const sidebar = document.getElementById('files-sidebar');
        const filesBtn = document.getElementById('files-btn');
        if (!helpers || !client || !sidebar) {
            console.error(helpers && sidebar
                ? '[wrapper] upload-client.js did not load'
                : '[wrapper] files-sidebar.js did not load');
            if (filesBtn) filesBtn.style.display = 'none';
            return;
        }

        const list = document.getElementById('files-list');
        const tablist = document.getElementById('files-tablist');
        const tabs = Array.from(document.querySelectorAll('.files-tab'));
        const showHidden = document.getElementById('files-show-hidden');
        const hiddenToggle = document.getElementById('files-hidden-toggle');
        const showProtected = document.getElementById('files-show-protected');
        const protectedToggle = document.getElementById('files-protected-toggle');
        const protectedStrip = document.getElementById('files-protected-strip');
        const recentHours = document.getElementById('files-recent-hours');
        const refreshBtn = document.getElementById('files-refresh');
        const checkBtn = document.getElementById('ha-check-btn');
        const checkResult = document.getElementById('ha-check-result');
        const resizer = document.getElementById('files-resizer');
        const preview = document.getElementById('files-preview');
        const previewTitle = document.getElementById('files-preview-title');
        const previewMeta = document.getElementById('files-preview-meta');
        const previewBody = document.getElementById('files-preview-body');
        const downloadBtn = document.getElementById('files-download-btn');
        const menu = document.getElementById('files-menu');
        const notice = document.getElementById('files-notice');
        const noticeText = document.getElementById('files-notice-text');
        const noticeProgress = document.getElementById('files-notice-progress');
        const noticeClose = document.getElementById('files-notice-close');
        const uploadBtn = document.getElementById('files-upload-btn');
        const uploadInput = document.getElementById('files-upload-input');
        const prompt = document.getElementById('files-prompt');
        const promptText = document.getElementById('files-prompt-text');
        const promptReplace = document.getElementById('files-prompt-replace');
        const promptKeep = document.getElementById('files-prompt-keep');
        const promptCancel = document.getElementById('files-prompt-cancel');
        const railFiles = document.querySelector('#files-rail [data-open-tab="files"]');
        const questionAnnouncer = document.getElementById('files-question-announcer');

        const PHONE = window.matchMedia('(max-width: 700px)');
        const STORE = { open: 'filesSidebar.open', width: 'filesSidebar.width', tab: 'filesSidebar.tab' };

        // localStorage can throw (private mode, blocked storage) or be
        // absent; the sidebar works the same without it.
        function load(key) {
            try { return window.localStorage.getItem(key); } catch { return null; }
        }
        function save(key, value) {
            try { window.localStorage.setItem(key, String(value)); } catch { /* not persisted */ }
        }

        let currentTab = load(STORE.tab) === 'recent' ? 'recent' : 'files';
        let rootPath = '/config';
        let previewPath = null;
        let previewSensitive = false;   // the open preview is a protected file
        // Bumped by every openPreview and blankPreview, so a reply lands
        // only on the request that asked for it. A path check is not
        // enough: the same file reopened (say with the toggle now off)
        // has the same path as a stale reply still in flight.
        let previewGen = 0;
        let selectedRow = null;
        // Per row, for reveal() and drops: the listing entry a row shows, a
        // folder row's opener, and a folder's wrap as a drop target.
        const rowEntries = new WeakMap();
        const folderOpeners = new WeakMap();
        const dropFolders = new WeakMap();
        let rootRender = null;   // the Files tree's top level, while it loads

        // A refusal throws with its HTTP status and the server's own
        // message (when it sent one) attached. A network failure is
        // fetch's own error, with no status.
        async function getJson(url) {
            const res = await fetch(url, { cache: 'no-store' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                const said = data.error || data.message || '';
                const err = new Error(said || res.statusText || 'Request failed');
                err.status = res.status;
                err.serverMessage = said;
                throw err;
            }
            return data;
        }

        function note(text, depth = 0) {
            const el = document.createElement('div');
            el.className = 'files-note';
            el.style.paddingLeft = (12 + depth * 14) + 'px';
            el.textContent = text;
            return el;
        }

        function makeRow(entry, depth, label, meta) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'files-row' + (entry.sensitive ? ' sensitive' : '');
            row.dataset.path = entry.path;
            row.style.paddingLeft = (8 + depth * 14) + 'px';
            if (!entry.sensitive) row.title = entry.path;
            else if (entry.type === 'dir') row.title = entry.path + ' (protected: its files open only with Show protected files on; never zipped)';
            else row.title = entry.path + ' (protected: may hold secrets; opens only with Show protected files on)';
            const twisty = document.createElement('span');
            twisty.className = 'files-twisty';
            // Decorative: aria-expanded on the row carries the state, and the
            // glyph would otherwise be read out as part of the folder's name.
            twisty.setAttribute('aria-hidden', 'true');
            twisty.textContent = entry.type === 'dir' ? '▸' : '';
            const icon = document.createElement('span');
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = entry.sensitive ? '\u{1F512}' : entry.type === 'dir' ? '\u{1F4C1}' : '\u{1F4C4}';
            const name = document.createElement('span');
            name.className = 'files-name';
            name.textContent = label;
            row.append(twisty, icon, name);
            if (meta) {
                const metaEl = document.createElement('span');
                metaEl.className = 'files-meta';
                metaEl.textContent = meta;
                row.append(metaEl);
            }
            return row;
        }

        function select(row) {
            if (selectedRow) selectedRow.classList.remove('selected');
            selectedRow = row;
            row.classList.add('selected');
        }

        // A row picked by the user (a click, or Enter or Space on it) also
        // takes focus, so a paste that follows is the sidebar's (see its
        // paste listener). Safari does not focus a button on click: focus
        // stayed on the page, and a file pasted after clicking a folder went
        // the terminal's way. The user is in the sidebar already, so this
        // takes focus from nothing else. Not select() itself: an upload's
        // reveal selects its file too, minutes later, maybe while the user
        // is typing in the terminal.
        function pickRow(row) {
            select(row);
            if (document.activeElement !== row) row.focus({ preventScroll: true });
        }

        // Generation of the view in #files-list. Every refresh() bumps it,
        // and a renderer whose generation is no longer current drops its
        // response: otherwise a slow Recent answer could land on top of the
        // Files tree after the user switched tabs (or changed the period,
        // or toggled Hidden files) while it was in flight.
        let viewGen = 0;

        // What a listing that is not one shows (helpers.isListing): a
        // proxy's page answering 200, say, which getJson reads as {}.
        const NOT_A_LISTING = '⚠️ The add-on gave an unexpected answer. Try again.';

        // One folder level into `container`; subfolders load on expand.
        // `gen` is passed for the top level only: a subfolder renders into
        // its own container, which a refresh detaches rather than reuses.
        // Resolves to whether the folder was listed: false when it failed
        // (its error showing in its place) or was dropped as stale.
        async function renderFolder(folderPath, container, depth, gen) {
            const stale = () => gen !== undefined && gen !== viewGen;
            container.replaceChildren(note('Loading…', depth));
            let data;
            try {
                data = await getJson('api/files/list?path=' + encodeURIComponent(folderPath));
            } catch (err) {
                if (stale()) return false;
                container.replaceChildren(note('⚠️ ' + err.message, depth));
                return false;
            }
            if (stale()) return false;
            if (!helpers.isListing(data)) {
                container.replaceChildren(note(NOT_A_LISTING, depth));
                return false;
            }
            if (depth === 0 && data.root) rootPath = data.root;
            const entries = data.entries.filter((e) => showHidden.checked || !e.name.startsWith('.'));
            // Names the server could not read are not "(empty)".
            const unreadable = helpers.unreadableNote(data.unreadableNames, 'folder');
            container.replaceChildren();
            if (!entries.length && !unreadable) container.append(note('(empty)', depth));
            for (const entry of entries) {
                const meta = entry.type === 'file' ? helpers.formatSize(entry.size) : '';
                const row = makeRow(entry, depth, entry.name, meta);
                // Plain buttons, reached with Tab: a folder is a disclosure
                // button (aria-expanded below) with its ⋯ beside it, and its
                // contents a group named after it. Not a role="tree": only
                // treeitems may sit in one, so the ⋯ could not, and a tree
                // promises arrow-key navigation this list never had.
                rowEntries.set(row, entry);
                if (entry.type === 'dir') {
                    const wrap = document.createElement('div');
                    wrap.className = 'files-row-wrap';
                    wrap.append(row, makeMenuButton(entry));
                    dropFolders.set(wrap, entry);
                    container.append(wrap);
                } else {
                    container.append(row);
                }
                if (entry.type === 'dir') {
                    const children = document.createElement('div');
                    children.setAttribute('role', 'group');
                    children.setAttribute('aria-label', entry.name);
                    children.hidden = true;
                    container.append(children);
                    row.setAttribute('aria-expanded', 'false');
                    const expand = (open) => {
                        children.hidden = !open;
                        row.setAttribute('aria-expanded', String(open));
                        row.firstChild.textContent = open ? '▾' : '▸';
                    };
                    // Opens the folder, listing it the first time, or again
                    // with `reload` (reveal(), after an upload into it).
                    // Resolves once its listing is in. A listing that
                    // failed is not kept: opening the folder again (collapse
                    // and expand) asks again, where a kept failure would
                    // show its error until the whole tree was refreshed.
                    let loading = null;
                    const open = ({ reload = false } = {}) => {
                        expand(true);
                        if (!loading || reload) {
                            const listing = renderFolder(entry.path, children, depth + 1);
                            loading = listing;
                            const forget = () => { if (loading === listing) loading = null; };
                            listing.then((listed) => { if (!listed) forget(); }, forget);
                        }
                        return loading;
                    };
                    folderOpeners.set(row, open);
                    row.addEventListener('click', () => {
                        pickRow(row);
                        if (children.hidden) open();
                        else expand(false);
                    });
                } else {
                    row.addEventListener('click', () => { pickRow(row); openPreview(entry.path, entry.sensitive); });
                }
            }
            if (data.truncated) container.append(note('… more entries not shown', depth));
            if (unreadable) container.append(note(unreadable, depth));
            return true;
        }

        async function renderRecent(gen) {
            list.replaceChildren(note('Loading…'));
            let data;
            try {
                data = await getJson('api/files/recent?hours=' + encodeURIComponent(recentHours.value));
            } catch (err) {
                if (gen !== viewGen) return;
                list.replaceChildren(note('⚠️ ' + err.message));
                return;
            }
            if (gen !== viewGen) return;
            if (!helpers.isListing(data)) {
                list.replaceChildren(note(NOT_A_LISTING));
                return;
            }
            if (data.root) rootPath = data.root;
            // Its count covers names of any age, so one could have changed
            // in the period: not "Nothing changed" then.
            const unreadable = helpers.unreadableNote(data.unreadableNames, 'recent');
            list.replaceChildren();
            if (!data.entries.length && !unreadable) list.append(note('Nothing changed in this period'));
            for (const entry of data.entries) {
                const row = makeRow(entry, 0, helpers.relativeTo(rootPath, entry.path), helpers.formatAgo(entry.mtime));
                row.addEventListener('click', () => { pickRow(row); openPreview(entry.path, entry.sensitive); });
                list.append(row);
            }
            if (data.truncated || data.incomplete) list.append(note('… showing the newest found; the search stopped early'));
            if (unreadable) list.append(note(unreadable));
        }

        // The selected tab: aria-selected, the tablist's one tab stop, and
        // the name of the panel (#files-list) both tabs show.
        function syncTabs() {
            for (const t of tabs) {
                const on = t.dataset.tab === currentTab;
                t.setAttribute('aria-selected', String(on));
                t.tabIndex = on ? 0 : -1;
            }
            list.setAttribute('aria-labelledby', 'files-tab-' + currentTab);
        }

        function refresh() {
            closeMenu();
            syncTabs();
            hiddenToggle.hidden = currentTab !== 'files';
            placeProtectedToggle();
            recentHours.hidden = currentTab !== 'recent';
            selectedRow = null;
            const gen = ++viewGen;
            if (currentTab === 'files') {
                rootRender = renderFolder(rootPath, list, 0, gen);
            } else {
                rootRender = null;
                renderRecent(gen);
            }
        }

        // kind: '' (news), 'busy' (try again shortly) or 'error'.
        // `fraction` (0 to 1) shows the progress bar; null hides it. The
        // text is only replaced when it changes: the notice is a live
        // region, and an upload's progress must not be read out at every
        // step (the bar carries it).
        function setNotice(text, kind, fraction) {
            const changed = noticeText.textContent !== text || notice.hidden !== !text;
            if (noticeText.textContent !== text) noticeText.textContent = text;
            notice.className = kind;
            notice.hidden = !text;
            noticeProgress.hidden = fraction === null;
            if (fraction !== null) noticeProgress.value = fraction;
            if (changed) fitNoticeScroll();
        }
        // A long notice scrolls (its max-height, in index.html). Safari puts
        // a scrolling box in the Tab order only with a tabindex, so without
        // one the keyboard cannot read what is below. It gets one while it
        // overflows, and only then: a tab stop on a line that fits would be
        // one for nothing. Checked when the text changes (at once: a
        // ResizeObserver can run frames later), and when the box changes
        // size for any other reason: the sidebar reopened (closed, nothing
        // scrolls), resized, or the window. With focus on it when it stops
        // scrolling, it keeps the tab stop until focus leaves: moving focus
        // would lose the reader's place.
        function fitNotice(focused) {
            if (noticeText.scrollHeight > noticeText.clientHeight) {
                noticeText.setAttribute('tabindex', '0');
            } else if (noticeText.hasAttribute('tabindex') && !focused) {
                noticeText.removeAttribute('tabindex');
            }
        }
        const fitNoticeScroll = () => fitNotice(document.activeElement === noticeText);
        noticeText.addEventListener('blur', () => fitNotice(false));
        // Old iOS WebViews (before 13.4) have no ResizeObserver: there the
        // check on every text change (setNotice) is the only one.
        if (typeof ResizeObserver === 'function') new ResizeObserver(fitNoticeScroll).observe(noticeText);
        // The notice's generation. Only what starts something new advances
        // it: a progress line ("Preparing …", "Uploading …") and a
        // dismissal. An operation's later lines go through showNoticeIf
        // with the generation its progress line got, so an older zip's or
        // upload's news cannot overwrite a newer one's.
        let noticeGen = 0;
        function showProgress(text, fraction = null) {
            setNotice(text, '', fraction);
            return ++noticeGen;
        }
        // Refusals and results always show, and leave the generation alone:
        // an older zip's late refusal used to take it, and with it the
        // newer zip's "Downloading …" line that came after.
        function showNotice(text, kind = '') {
            setNotice(text, kind, null);
        }
        function showNoticeIf(gen, text, kind = '', fraction = null) {
            if (gen === noticeGen) setNotice(text, kind, fraction);
        }
        function dismissNotice() {
            setNotice('', '', null);
            ++noticeGen;
        }

        // What a refused zip preflight says in the notice. 429 is the
        // server being busy (two zips already running, or the zip rate
        // limit), not something wrong with the folder: "try again".
        function zipRefusal(err, zipName) {
            if (err.status === 429) {
                const said = err.serverMessage || 'The add-on is busy.';
                return ['⏳ ' + zipName + ' did not start: ' + said
                    + (/try again/i.test(said) ? '' : ' Try again shortly.'), 'busy'];
            }
            if (err.status === undefined) {
                return ['⚠️ Could not reach the add-on to prepare ' + zipName + ' (' + err.message
                    + '). Check the connection and try again.', 'error'];
            }
            return ['⚠️ ' + zipName + ': ' + err.message, 'error'];
        }

        // Folders whose preflight is still out. A second activation of
        // the same folder meanwhile (a double click, say) is dropped
        // rather than starting the same zip twice. It covers the
        // preflight only, which a small folder answers well within a
        // key repeat: a held Enter is kept from zipping again by the
        // menu ignoring repeated keys instead (see its keydown).
        const zipsPreparing = new Set();

        // A zip is checked first (check=1: the same walk, answered as
        // JSON), so a refusal - over the size cap, too many files, a
        // protected or vanished folder, a busy server - shows here with
        // its reason, and no download starts. Once the browser has the
        // download, an error could only appear as a failed download with
        // no reason.
        //
        // Zips of different folders may overlap. Each one asked for is
        // started, whenever its answer comes. A refusal always shows, so
        // no reason is lost; only the good news ("Downloading …") of an
        // older zip gives way to a newer one's (showNoticeIf).
        async function downloadZip(entry) {
            if (entry.sensitive) return;   // never offered; the server refuses it too
            if (zipsPreparing.has(entry.path)) return;
            zipsPreparing.add(entry.path);
            const zipName = entry.name + '.zip';
            const gen = showProgress('Preparing ' + zipName + '…');
            let plan;
            try {
                plan = await getJson(helpers.downloadUrl(entry.path, { zip: true, check: true }));
            } catch (err) {
                showNotice(...zipRefusal(err, zipName));
                return;
            } finally {
                zipsPreparing.delete(entry.path);
            }
            // A reply that is not a plan (say a proxy's page answered
            // 200) is not a passed check.
            if (!plan || typeof plan.files !== 'number') {
                showNotice('⚠️ ' + zipName + ': the add-on gave an unexpected answer. Try again.', 'error');
                return;
            }
            startDownload(helpers.downloadUrl(entry.path, { zip: true }));
            const unreadable = helpers.unreadableNote(plan.unreadableNames, 'zip');
            showNoticeIf(gen, 'Downloading ' + (plan.name || zipName) + ': ' + plan.files
                + (plan.files === 1 ? ' file, ' : ' files, ') + helpers.formatSize(plan.bytes)
                + ' before compression. Protected files are left out.' + (unreadable ? ' ' + unreadable : ''));
        }

        // Folder actions, behind the always-visible ⋯ on each folder row
        // (hover-only controls do not exist on a touch screen). `hint` is
        // shown under the action, since a tooltip is out of reach on touch:
        // why it is disabled, or what to know before using it. Upload here
        // is not offered at all on a symlinked folder (uploads into one are
        // refused); helpers.uploadTarget decides, as the server does.
        function folderActions(entry) {
            const actions = [{
                label: 'Download as zip',
                disabled: !!entry.sensitive,
                hint: entry.sensitive ? 'Protected folders are never zipped' : '',
                title: entry.sensitive
                    ? 'This folder may hold secrets, so it is never zipped. Its files open one at a time with Show protected files on.'
                    : 'Download this folder as a .zip; protected files are left out',
                run: () => downloadZip(entry),
            }];
            const target = helpers.uploadTarget(entry, rootPath);
            if (target) {
                actions.push({
                    label: 'Upload here',
                    disabled: target.disabled,
                    hint: target.hint,
                    title: target.title,
                    run: () => pickFiles(entry.path),
                });
            }
            return actions;
        }

        let menuOwner = null;   // the ⋯ button whose menu is open

        // Focus inside the menu goes back to its ⋯ when the menu closes
        // under it (a scroll, a resize); emptying the menu would otherwise
        // drop it on the page body. Not when focus is leaving anyway
        // (restoreFocus: false): a press elsewhere, or the window losing
        // focus, which is what a click into the terminal iframe looks
        // like from here - taking focus back then would pull it out of
        // the terminal on the very click meant to put it there.
        function closeMenu({ focusOwner = false, restoreFocus = true } = {}) {
            if (!menuOwner) return;
            const owner = menuOwner;
            menuOwner = null;
            const hadFocus = restoreFocus && menu.contains(document.activeElement);
            menu.hidden = true;
            menu.replaceChildren();
            owner.setAttribute('aria-expanded', 'false');
            if ((focusOwner || hadFocus) && owner.isConnected) owner.focus({ preventScroll: true });
        }

        function openMenu(button, entry) {
            closeMenu();
            menuOwner = button;
            button.setAttribute('aria-expanded', 'true');
            menu.setAttribute('aria-label', button.getAttribute('aria-label'));
            // Each action is fixed as the menu opens: an item marked
            // disabled stays inert even if the mark is later removed.
            for (const action of folderActions(entry)) {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'files-menu-item';
                item.setAttribute('role', 'menuitem');
                item.tabIndex = -1;
                item.textContent = action.label;
                item.title = action.title || '';
                if (action.disabled) item.setAttribute('aria-disabled', 'true');
                // On screen inside the item, but read as its description,
                // not as part of its name.
                if (action.hint) {
                    const hint = document.createElement('span');
                    hint.className = 'files-menu-hint';
                    hint.id = 'files-menu-hint-' + menu.childElementCount;
                    hint.setAttribute('aria-hidden', 'true');
                    hint.textContent = action.hint;
                    item.append(hint);
                    item.setAttribute('aria-describedby', hint.id);
                }
                item.addEventListener('click', () => {
                    if (action.disabled) return;   // stays open, its reason showing
                    closeMenu({ focusOwner: true });
                    action.run();
                });
                menu.append(item);
            }
            menu.hidden = false;
            // Under the button, right edges aligned, kept inside the
            // sidebar; flipped above it near the bottom.
            const bar = sidebar.getBoundingClientRect();
            const btn = button.getBoundingClientRect();
            menu.style.right = Math.max(4, bar.right - btn.right) + 'px';
            menu.style.top = (btn.bottom - bar.top + 2) + 'px';
            const box = menu.getBoundingClientRect();
            if (box.bottom > bar.bottom - 4) {
                menu.style.top = Math.max(4, btn.top - bar.top - box.height - 2) + 'px';
            }
            // The first item, disabled or not: aria-disabled keeps it
            // focusable, so the keyboard reaches its reason.
            const first = menu.querySelector('.files-menu-item');
            if (first) first.focus({ preventScroll: true });
        }

        function makeMenuButton(entry) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'files-menu-btn';
            btn.textContent = '⋯';
            btn.title = 'Folder actions';
            btn.setAttribute('aria-label', 'Actions for ' + entry.name);
            btn.setAttribute('aria-haspopup', 'menu');
            btn.setAttribute('aria-controls', 'files-menu');
            btn.setAttribute('aria-expanded', 'false');
            btn.addEventListener('click', () => {
                if (menuOwner === btn) closeMenu();
                else openMenu(btn, entry);
            });
            // See isRepeatedActivation, below with the menu's keys.
            btn.addEventListener('keydown', (e) => {
                if (isRepeatedActivation(e)) e.preventDefault();
            });
            return btn;
        }

        // Hand a download to the browser without leaving this page: a
        // click on a temporary <a download>. Not location.href or
        // window.open - the download attribute keeps this frame (and the
        // terminal in it) where it is even if the answer turns out not
        // to be a file, and it is not a popup, so nothing blocks it. The
        // URL is relative (downloadUrl) and so same-origin, which the
        // download attribute requires, and stays below the ingress path.
        function startDownload(url) {
            const a = document.createElement('a');
            a.href = url;
            a.download = '';   // the name comes from Content-Disposition
            a.hidden = true;
            document.body.append(a);
            try { a.click(); } finally { a.remove(); }
        }

        // --- Uploads ---
        //
        // The flow itself is upload-client.js's (client), shared with the
        // terminal's paperclip, paste and drop; what it shows is this file's.
        // One file per request, one after another, each asked about first
        // (check=1, no body), so a refusal - a name already taken, the size
        // limit, a protected folder - comes back as an answer: one sent
        // before a big body has been read is often lost behind ingress, and
        // the browser shows only a network error. A sidebar upload never
        // types into the terminal: it reveals the new file and, while the
        // user is still in the sidebar, opens its preview (a protected one
        // only with Show protected files on).

        let pickDest;   // where the next pick goes; undefined is the inbox
        let uploadChain = Promise.resolve();
        // Files picked or dropped and not yet started, in the running batch
        // and in those queued behind it: a waiting question counts them.
        let filesWaiting = 0;

        // The same input for the Upload button and every Upload here, so
        // pickDest says which it was. Emptied first: holding its last
        // selection, a pick of the same file again would fire no change.
        function pickFiles(dest) {
            pickDest = dest;
            uploadInput.value = '';
            uploadInput.click();
        }

        // The inline Replace / Keep both / Cancel question for a name that
        // is taken. Never confirm(), which would block the page and the
        // terminal with it. Resolves to 'replace', 'keep-both' or null
        // (Cancel, Escape). Replace is offered only for a regular file.
        //
        // It can come minutes after the pick, mid-batch, or from a drop
        // made while typing in the terminal. So it takes focus only from
        // the sidebar itself (or from nowhere), and then puts it on Keep
        // both, which loses nothing: focus pulled out of the terminal would
        // let the next Enter answer a question nobody saw, and with the
        // preview open Escape would answer it instead of closing the
        // preview. Otherwise the notice, a live region, asks for the answer.
        let answerPrompt = null;

        // The question lives in the sidebar, so with the sidebar hidden it
        // would wait unseen and hold up every file behind it. So it would
        // under the file preview, which covers the whole page, and which
        // finishBatch itself opens: a queued batch's next question comes up
        // under it. While a question waits unseen, a dot on the Files
        // button and on the rail's Files button says one is waiting, both
        // buttons' names say it too, and a live region outside the sidebar
        // announces it (the notice, a live region itself, is hidden with the
        // sidebar). Recomputed wherever any of it changes: a question asked
        // (askCollision) or answered (answerPrompt), the sidebar shown or
        // hidden (setOpen), the preview opened or closed.
        const QUESTION_WAITING = 'an upload is waiting for your answer';
        const filesLabel = filesBtn.getAttribute('aria-label');
        const filesTitle = filesBtn.title;
        const railTitle = railFiles ? railFiles.title : '';
        const railLabel = railFiles ? railFiles.getAttribute('aria-label') || railTitle : '';
        const previewOpen = () => preview.classList.contains('active');
        function syncQuestionBadge() {
            const on = Boolean(answerPrompt) && (sidebar.classList.contains('collapsed') || previewOpen());
            if (filesBtn.classList.contains('has-question') === on) return;
            filesBtn.classList.toggle('has-question', on);
            filesBtn.setAttribute('aria-label', on ? filesLabel + ': ' + QUESTION_WAITING : filesLabel);
            filesBtn.title = on ? 'Files: ' + QUESTION_WAITING : filesTitle;
            if (railFiles) {
                railFiles.classList.toggle('has-question', on);
                railFiles.setAttribute('aria-label', on ? railLabel + ': ' + QUESTION_WAITING : railLabel);
                railFiles.title = on ? 'Files: ' + QUESTION_WAITING : railTitle;
            }
            if (questionAnnouncer) {
                questionAnnouncer.textContent = on ? 'An upload is waiting for your answer in the Files sidebar.' : '';
            }
        }

        function askCollision(text, replaceable) {
            return new Promise((resolve) => {
                const returnTo = document.activeElement;
                const takeFocus = !previewOpen()
                    && (!returnTo || returnTo === document.body || sidebar.contains(returnTo));
                showProgress(text + ' Answer in the Files sidebar.'
                    + (filesWaiting ? ' ' + filesWaiting + ' more waiting.' : ''));
                promptText.textContent = text;
                promptReplace.hidden = !replaceable;
                prompt.hidden = false;
                answerPrompt = (choice) => {
                    answerPrompt = null;
                    // Answered from behind the preview (it does not trap
                    // focus), the dot is up: it goes with the question.
                    syncQuestionBadge();
                    const hadFocus = prompt.contains(document.activeElement);
                    prompt.hidden = true;
                    promptText.textContent = '';
                    // Back where it came from; from nowhere (the page
                    // body), from something gone since (a row the tree
                    // drew again), or from something hidden since, where
                    // focus() does not take, to Upload rather than the page.
                    if (hadFocus) {
                        const back = returnTo && returnTo !== document.body && returnTo.isConnected ? returnTo : uploadBtn;
                        back.focus({ preventScroll: true });
                        if (document.activeElement !== back) uploadBtn.focus({ preventScroll: true });
                    }
                    resolve(choice);
                };
                syncQuestionBadge();
                if (takeFocus) promptKeep.focus({ preventScroll: true });
            });
        }

        // One file: { result } once it is in /config, { problem, status }
        // when it was refused or failed, { skipped } when the user cancelled
        // (client.uploadOne). Its steps show in the notice, under the
        // notice's generation gate; a taken name is asked about here. The
        // notice shows the name without invisible marks.
        function uploadOne(file, dest, counter) {
            const shown = helpers.displayName(file.name);
            return client.uploadOne(file, {
                dest,
                askCollision,
                onCheck: () => showProgress('Checking ' + shown + counter + '…'),
                onSend: () => {
                    const line = 'Uploading ' + shown + counter + '…';
                    const gen = showProgress(line, 0);
                    return (fraction) => showNoticeIf(gen, line, '', fraction);
                },
            });
        }

        // The listed row for a path, if one is on screen.
        const rowFor = (p) => Array.from(list.querySelectorAll('.files-row')).find((r) => r.dataset.path === p) || null;

        // Show a file in the tree: the Files tab, each folder down to it
        // opened, and the folder it is in listed afresh, since the file is
        // new. Resolves to its row, or null when it cannot be shown (a
        // dotfolder with Hidden files off, say).
        async function reveal(filePath) {
            const rel = helpers.relativeTo(rootPath, filePath);
            if (rel === filePath) return null;   // not below the root
            if (currentTab !== 'files') switchTab('files');
            if (rootRender) await rootRender;
            const folders = rel.split('/').slice(0, -1);
            // Lists again whatever holds the next folder: the root (a
            // refresh) or the folder above (its opener).
            let relist = () => { refresh(); return rootRender; };
            if (!folders.length) {
                await relist();
                return rowFor(filePath);
            }
            let dir = rootPath;
            for (let i = 0; i < folders.length; i++) {
                dir += '/' + folders[i];
                let row = rowFor(dir);
                if (!row) {   // made since it was listed: the inbox, the first time
                    await relist();
                    row = rowFor(dir);
                }
                const open = row && folderOpeners.get(row);
                if (!open) return null;
                relist = () => open({ reload: true });
                await open({ reload: i === folders.length - 1 });
            }
            return rowFor(filePath);
        }

        // Where the user is when a batch ends, which can be minutes after
        // it began: still in the open sidebar (focus in it, or nowhere), or
        // gone back to the terminal or elsewhere.
        function stillInSidebar() {
            const active = document.activeElement;
            return !sidebar.classList.contains('collapsed')
                && (!active || active === document.body || sidebar.contains(active));
        }

        // After a batch: one line for it, with every refusal, then the last
        // file uploaded revealed and, if the user is still in the sidebar,
        // previewed. The preview covers the whole page: sprung on someone
        // typing in the terminal it would take their keys, and a drop on
        // it would once have gone to the terminal. A protected file is
        // revealed but not opened unless Show protected files is on.
        async function finishBatch(outcome) {
            const { lines, kind } = helpers.uploadSummary(outcome);
            const last = outcome.results[outcome.results.length - 1];
            if (!last) {
                showNotice(lines.join('\n'), kind);
                return;
            }
            // The upload is in, whatever the tree does next: a listing that
            // fails to show it must not turn it into "Upload failed", which
            // would invite the same file again. Unrevealed, it is not
            // previewed either.
            let row = null;
            try {
                row = await reveal(last.path);
            } catch (err) {
                console.error('[wrapper] could not show the upload in the tree:', err);
            }
            const entry = row && rowEntries.get(row);
            if (row) {
                select(row);
                row.scrollIntoView({ block: 'nearest' });
            }
            if (entry && entry.sensitive && !showProtected.checked) {
                lines.splice(1, 0, helpers.displayName(last.name) + ' is protected: turn on Show protected files to open it.');
                showNotice(lines.join('\n'), kind);
                return;
            }
            showNotice(lines.join('\n'), kind);
            const refused = outcome.problems.length || outcome.busy.length;
            if (entry && !refused && stillInSidebar()) openPreview(entry.path, entry.sensitive);
        }

        // The notice's dismiss button goes while a batch runs: dismissing
        // cannot cancel an upload (not offered yet), and an × beside
        // "Uploading …" reads as one. Focus on it moves to Upload.
        function setUploading(on) {
            if (on && document.activeElement === noticeClose) uploadBtn.focus({ preventScroll: true });
            noticeClose.hidden = on;
        }

        // `folders`: what a drop left out, named in the batch's line. The
        // batch stops at the first 429 (client.runBatch).
        async function runBatch(files, dest, folders) {
            let started = 0;
            setUploading(true);
            try {
                let outcome;
                try {
                    outcome = await client.runBatch(files, (file, counter) => uploadOne(file, dest, counter), {
                        onStart: () => {
                            filesWaiting--;
                            started++;
                        },
                    });
                } finally {
                    filesWaiting -= files.length - started;   // what a failure left unstarted
                }
                await finishBatch({ ...outcome, folders });
            } finally {
                setUploading(false);
            }
        }

        // Batches queue behind each other, so their prompts come one at a
        // time and in order. No dest is the inbox.
        function uploadFiles(files, dest, folders = []) {
            const batch = Array.from(files);
            if (!batch.length) return uploadChain;
            filesWaiting += batch.length;
            uploadChain = uploadChain.then(() => runBatch(batch, dest, folders)).catch((err) => {
                console.error('[wrapper] upload failed:', err);
                showNotice('⚠️ Upload failed: ' + err.message, 'error');
            });
            return uploadChain;
        }

        async function openPreview(filePath, sensitive) {
            const gen = ++previewGen;
            previewPath = filePath;
            previewSensitive = Boolean(sensitive);
            // Enabled once the preview loads: a refused preview (a
            // protected file with the toggle off) means a refused download.
            downloadBtn.disabled = true;
            previewTitle.textContent = filePath;
            previewMeta.textContent = '';
            previewBody.textContent = 'Loading…';
            preview.classList.add('active');
            syncQuestionBadge();
            try {
                const data = await getJson('api/files/preview?path=' + encodeURIComponent(filePath)
                    + (showProtected.checked ? '&protected=1' : ''));
                if (gen !== previewGen) return;   // opened again, or blanked, meanwhile
                // The server says what it actually opened; the listing
                // can be stale (a file since replaced by a link to
                // .env). Either one marks it protected, and neither
                // alone can clear the mark. Should the toggle have gone
                // off while this was loading, the answer is dropped.
                previewSensitive = previewSensitive || data.sensitive === true;
                if (previewSensitive && !showProtected.checked) {
                    closePreview();
                    blankPreview();
                    return;
                }
                const parts = [helpers.formatSize(data.size), 'modified ' + new Date(data.mtime).toLocaleString()];
                if (data.truncated) parts.push('showing the first ' + helpers.formatSize(data.limit));
                previewMeta.textContent = parts.join(' · ');
                previewBody.textContent = data.binary ? '(binary file, no preview)' : data.content;
                downloadBtn.disabled = false;
            } catch (err) {
                if (gen !== previewGen) return;
                downloadBtn.disabled = true;
                previewBody.textContent = '⚠️ ' + err.message;
            }
        }

        // A protected file's text does not outlive its preview: closing
        // it clears the dialog, rather than leaving the secret hidden in
        // the DOM.
        //
        // A question that waited under it is in view now, with the sidebar
        // open: focus goes to its Keep both when it would have gone there
        // had the preview not been in the way (askCollision's rule), so from
        // the preview itself, the sidebar, or nowhere; never from the
        // terminal or the header. Or when setOpen owed it that focus and it
        // is still where setOpen left it. `focusQuestion` false leaves focus
        // alone: Insert path, which hands it to the terminal. A preview that
        // was not open (a late answer closing it again) moves nothing: focus
        // has gone wherever the user took it since.
        function closePreview({ focusQuestion = true } = {}) {
            const wasOpen = previewOpen();
            const hadFocus = preview.contains(document.activeElement);
            const owedFrom = questionFocusOwedFrom;
            questionFocusOwedFrom = null;
            preview.classList.remove('active');
            if (previewSensitive) blankPreview();
            syncQuestionBadge();
            if (!wasOpen || !focusQuestion || !answerPrompt || sidebar.classList.contains('collapsed')) return;
            const active = document.activeElement;
            if (hadFocus || !active || active === document.body || sidebar.contains(active)
                || (owedFrom && active === owedFrom)) {
                promptKeep.focus({ preventScroll: true });
            }
        }

        // Bumping previewGen also drops an answer still in flight: the
        // generation check in openPreview no longer matches it.
        function blankPreview() {
            ++previewGen;
            previewPath = null;
            previewSensitive = false;
            downloadBtn.disabled = true;
            previewTitle.textContent = '';
            previewMeta.textContent = '';
            previewBody.textContent = '';
        }

        // Set when the sidebar opened on a question under the preview: the
        // element focus stayed on, for closePreview to give the question
        // the focus it was owed. Cleared when the preview closes or the
        // sidebar does.
        let questionFocusOwedFrom = null;

        function setOpen(open, { persist = true } = {}) {
            if (!open) closeMenu();
            questionFocusOwedFrom = null;
            sidebar.classList.toggle('collapsed', !open);
            filesBtn.setAttribute('aria-expanded', String(open));
            if (persist) save(STORE.open, open ? '1' : '0');
            if (open && !list.childElementCount) refresh();
            syncQuestionBadge();
            // Opened with a question waiting: that is what the user came
            // for. Not with the preview over it (reached from the keyboard
            // behind it): focus behind the preview would let Escape answer
            // the question instead of closing the preview. Closing it gives
            // the question focus then (closePreview, questionFocusOwedFrom).
            if (open && answerPrompt) {
                if (previewOpen()) questionFocusOwedFrom = document.activeElement;
                else promptKeep.focus({ preventScroll: true });
            }
        }

        function switchTab(tab) {
            if (tab !== 'files' && tab !== 'recent') return;
            currentTab = tab;
            save(STORE.tab, tab);
            refresh();
        }

        filesBtn.addEventListener('click', () => setOpen(sidebar.classList.contains('collapsed')));
        document.getElementById('files-hide').addEventListener('click', () => setOpen(false));
        document.getElementById('files-expand').addEventListener('click', () => setOpen(true));
        document.querySelectorAll('[data-open-tab]').forEach((btn) => btn.addEventListener('click', () => {
            const wasEmpty = !list.childElementCount;
            if (currentTab !== btn.dataset.openTab) {
                currentTab = btn.dataset.openTab;
                save(STORE.tab, currentTab);
                if (!wasEmpty) refresh();
            }
            setOpen(true);
        }));
        tabs.forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
        // Arrow keys, Home and End move focus between the tabs; Enter or
        // Space (the button's own click) switches. Manual activation, since
        // each switch reloads the list and Recent changes walks /config:
        // arrowing past a tab must not start a walk.
        tablist.addEventListener('keydown', (e) => {
            if (e.altKey || e.ctrlKey || e.metaKey) return;
            const next = helpers.tabKeyTarget(e.key, tabs.indexOf(document.activeElement), tabs.length);
            if (next < 0) return;
            e.preventDefault();
            tabs[next].focus();
        });
        showHidden.addEventListener('change', refresh);

        // "Show protected files" is never remembered: cleared on every
        // load, and again when the browser brings the page back from its
        // back/forward cache, which keeps form state as it was.
        // Switching off also takes down a protected preview: one already
        // open (the toggle is reachable by keyboard behind it), one still
        // loading, and one a back/forward-cache restore brings back.
        function setProtected(on) {
            showProtected.checked = on;
            protectedStrip.textContent = on
                ? '\u{1F512} Protected files can be opened and downloaded. Turn off \u201CShow protected files\u201D when you are done.'
                : '';
            if (!on && previewSensitive) {
                closePreview();
                blankPreview();
            }
            placeProtectedToggle();
        }
        // Off, it is a Files-tab control like Hidden files. On, it shows
        // on every tab, as the amber strip does, so it can always be
        // switched off from where the strip is showing. Hiding it while
        // it has focus would drop focus to the page, so the active tab
        // takes it.
        function placeProtectedToggle() {
            const hide = currentTab !== 'files' && !showProtected.checked;
            const hadFocus = protectedToggle.contains(document.activeElement);
            protectedToggle.hidden = hide;
            if (hide && hadFocus) tabs.find((t) => t.dataset.tab === currentTab)?.focus();
        }
        setProtected(false);
        window.addEventListener('pageshow', (e) => { if (e.persisted) setProtected(false); });
        showProtected.addEventListener('change', () => setProtected(showProtected.checked));
        recentHours.addEventListener('change', refresh);
        refreshBtn.addEventListener('click', refresh);

        // Insert path: types the quoted path at the prompt, no Enter,
        // through the page's injectIntoTerminal (handed to init). On a phone
        // the open sidebar covers the terminal, so it closes first.
        document.getElementById('files-insert-btn').addEventListener('click', async () => {
            if (!previewPath) return;
            const text = helpers.shellQuote(previewPath);
            closePreview({ focusQuestion: false });
            if (PHONE.matches) setOpen(false);
            if (injectIntoTerminal(text)) {
                try { document.getElementById('terminal-frame').contentWindow.term.focus(); } catch { /* not ready */ }
            } else if (await copyToClipboard(text)) {
                setStatus('Copied path: ' + text + ' — paste in terminal', 'success');
            } else {
                setStatus('Path: ' + text, 'success', true);
            }
        });
        document.getElementById('files-copy-btn').addEventListener('click', async () => {
            if (!previewPath) return;
            const ok = await copyToClipboard(previewPath);
            setStatus(ok ? 'Path copied' : 'Copy failed', ok ? 'success' : 'error');
        });

        // The menu closes on a press anywhere else, Escape, Tab, scrolling
        // the tree, a change of width, and the window losing focus -
        // which is also what a click into the terminal iframe looks like
        // from this page. Focus that was in it goes back to the ⋯, except
        // when it is leaving anyway (see closeMenu).
        document.addEventListener('pointerdown', (e) => {
            if (menuOwner && !menu.contains(e.target) && !menuOwner.contains(e.target)) {
                closeMenu({ restoreFocus: false });
            }
        });
        // A held key repeats. Enter on an item runs it and puts focus on
        // the ⋯, where the next repeat would reopen the menu and the one
        // after run the item again: one press, one action.
        const isRepeatedActivation = (e) => e.repeat && (e.key === 'Enter' || e.key === ' ');
        menu.addEventListener('keydown', (e) => {
            if (isRepeatedActivation(e)) {
                e.preventDefault();
                return;
            }
            const items = Array.from(menu.querySelectorAll('.files-menu-item'));
            const at = items.indexOf(document.activeElement);
            let next = null;
            if (e.key === 'Escape' || e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                closeMenu({ focusOwner: true });
                return;
            }
            if (e.key === 'ArrowDown') next = items[(at + 1) % items.length];
            else if (e.key === 'ArrowUp') next = items[(at - 1 + items.length) % items.length];
            else if (e.key === 'Home') next = items[0];
            else if (e.key === 'End') next = items[items.length - 1];
            if (next) {
                e.preventDefault();
                next.focus({ preventScroll: true });
            }
        });
        list.addEventListener('scroll', () => closeMenu());
        // Width only: on a phone the URL bar and the on-screen keyboard
        // change the height alone, and that must not close the menu.
        let menuWidth = window.innerWidth;
        window.addEventListener('resize', () => {
            if (window.innerWidth === menuWidth) return;
            menuWidth = window.innerWidth;
            closeMenu();
        });
        window.addEventListener('blur', () => closeMenu({ restoreFocus: false }));
        document.getElementById('files-notice-close').addEventListener('click', dismissNotice);

        uploadBtn.addEventListener('click', () => pickFiles(undefined));
        uploadInput.addEventListener('change', () => {
            const files = Array.from(uploadInput.files || []);
            uploadInput.value = '';
            uploadFiles(files, pickDest);
        });
        promptReplace.addEventListener('click', () => answerPrompt?.('replace'));
        promptKeep.addEventListener('click', () => answerPrompt?.('keep-both'));
        promptCancel.addEventListener('click', () => answerPrompt?.(null));
        prompt.addEventListener('keydown', (e) => {
            // A held key's repeats. Enter on the Files button (or the
            // rail's) opening the sidebar on a question puts focus on Keep
            // both, where the key's next repeat would answer it; so does
            // Escape closing the preview over a question, where its next
            // repeat would cancel it unseen. One press, one action.
            if (isRepeatedActivation(e) || (e.repeat && e.key === 'Escape')) {
                e.preventDefault();
                return;
            }
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            answerPrompt?.(null);
        });

        // Files dropped on the sidebar: onto a folder row means Upload here,
        // anywhere else the inbox. Every drag event that carries files stops
        // here, so the page's terminal drop handler (on document, in
        // index.html) never also takes a drop meant for the sidebar, and its
        // overlay never shows while the drag is over the sidebar.
        const carriesFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
        const dropWrapOf = (e) => {
            const wrap = e.target instanceof Element ? e.target.closest('.files-row-wrap') : null;
            return wrap && list.contains(wrap) ? wrap : null;
        };
        let dropHighlight = null;
        function highlightDrop(wrap) {
            if (dropHighlight === wrap) return;
            if (dropHighlight) dropHighlight.classList.remove('drop-target');
            dropHighlight = wrap;
            if (wrap) wrap.classList.add('drop-target');
        }
        function endDropHover() {
            sidebar.classList.remove('drop-active');
            highlightDrop(null);
        }
        for (const type of ['dragenter', 'dragover']) {
            sidebar.addEventListener(type, (e) => {
                if (!carriesFiles(e)) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'copy';
                sidebar.classList.add('drop-active');
                highlightDrop(dropWrapOf(e));
            });
        }
        sidebar.addEventListener('dragleave', (e) => {
            if (!carriesFiles(e)) return;
            e.stopPropagation();
            if (!e.relatedTarget || !sidebar.contains(e.relatedTarget)) endDropHover();
        });
        sidebar.addEventListener('drop', (e) => {
            if (!carriesFiles(e)) return;
            e.preventDefault();
            e.stopPropagation();
            const wrap = dropWrapOf(e);
            endDropHover();
            // Read now: a drop's data is gone once its event is over. A
            // dropped folder arrives as a File too; it is left out, and
            // named in the batch's line.
            const { files, folders } = client.droppedFiles(e.dataTransfer);
            if (!files.length) {
                showNotice('⚠️ Folders cannot be uploaded. Drop the files inside them instead.', 'error');
                return;
            }
            uploadAimedAt(wrap ? dropFolders.get(wrap) : null, 'drop', files, folders);
        });

        // Files go where `entry` says (helpers.uploadDestination): Upload
        // here for a folder, the inbox for anything else, or refused in the
        // notice. A drop's folder row, a paste's selected row.
        function uploadAimedAt(entry, how, files, folders = []) {
            const { dest, refused } = helpers.uploadDestination(entry, rootPath, how);
            if (refused) {
                showNotice('⚠️ Not uploaded: ' + refused, 'error');
                return;
            }
            uploadFiles(files, dest, folders);
        }

        // Files pasted with focus in the sidebar follow the drop rule, with
        // the selected row for the row dropped on: a folder means Upload
        // here, anything else (a file, or nothing selected) the inbox. The
        // paste is stopped here, so the page's terminal paste handler (on
        // document, in index.html) never also uploads it to /data/images
        // and types its path. A clipboard with text in it is a text paste
        // (client.clipboardFiles), left alone for whatever has focus. Only
        // a selected row on screen counts: one the tree has drawn again
        // since, one inside a closed folder, or any with the sidebar down to
        // its rail, would send the files somewhere the user cannot see. That
        // is nothing selected, as a drop on the rail is a drop on no row.
        sidebar.addEventListener('paste', (e) => {
            const files = client.clipboardFiles(e.clipboardData);
            if (!files.length) return;
            e.preventDefault();
            e.stopPropagation();
            const shown = selectedRow && selectedRow.getClientRects().length > 0;
            uploadAimedAt(shown ? rowEntries.get(selectedRow) : null, 'paste', files);
        });

        // Files dragged over the open preview. It covers the whole page, so
        // a drop there has no target the user can see: refused (the cursor
        // says so during the drag), never uploaded somewhere they did not
        // pick, and stopped here, so the page's terminal drop handler (on
        // document) never sends an image to /data/images and types its
        // path for a sidebar upload, nor shows its overlay.
        for (const type of ['dragenter', 'dragover', 'dragleave']) {
            preview.addEventListener(type, (e) => {
                if (!carriesFiles(e)) return;
                e.preventDefault();
                e.stopPropagation();
                if (type !== 'dragleave') e.dataTransfer.dropEffect = 'none';
            });
        }
        preview.addEventListener('drop', (e) => {
            if (!carriesFiles(e)) return;
            e.preventDefault();
            e.stopPropagation();
            showNotice('⚠️ Not uploaded: close the preview first, then drop the files onto the Files sidebar.', 'error');
        });

        // previewPath is read at click time: a blanked preview has none,
        // and a protected file never goes out with the toggle off (by
        // construction its preview is blanked then; checked anyway).
        downloadBtn.addEventListener('click', () => {
            if (!previewPath || downloadBtn.disabled) return;
            if (previewSensitive && !showProtected.checked) return;
            startDownload(helpers.downloadUrl(previewPath, { protectedOn: showProtected.checked }));
        });
        document.getElementById('files-close-btn').addEventListener('click', () => closePreview());
        preview.addEventListener('click', (e) => { if (e.target === preview) closePreview(); });
        preview.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePreview(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && preview.classList.contains('active')) closePreview();
        });

        checkBtn.addEventListener('click', async () => {
            checkBtn.disabled = true;
            checkResult.className = '';
            checkResult.textContent = 'Checking… (this can take a minute)';
            try {
                const res = await fetch('api/files/ha-check', { method: 'POST' });
                const data = await res.json().catch(() => ({}));
                const ok = res.ok && data.ok === true;
                checkResult.className = ok ? 'ok' : 'error';
                checkResult.textContent = (ok ? '✅ ' : '❌ ') + (data.message || data.error || res.statusText || 'Check failed');
            } catch (err) {
                checkResult.className = 'error';
                checkResult.textContent = '❌ ' + err.message;
            } finally {
                checkBtn.disabled = false;
            }
        });

        // Resize by dragging the left edge. Pointer capture keeps the drag
        // on the handle; the body class stops the iframe from swallowing
        // the pointer if capture does not hold across the frame boundary.
        // Every way a drag can end clears both, so the terminal is never
        // left without the pointer.
        //
        // The width the user chose (stored, or dragged to) is kept apart
        // from the one shown: a window too narrow for it shows less, and the
        // window wide again shows it again. Only a drag changes it and is
        // stored; a bare click on the edge, which moves nothing, stores
        // nothing (it used to store the narrowed width as the choice).
        function applyWidth(width) {
            sidebar.style.width = helpers.clampWidth(width, document.getElementById('main').clientWidth) + 'px';
        }
        let chosenWidth = load(STORE.width);
        applyWidth(chosenWidth);
        // How far the pointer must go before a press on the edge is a drag:
        // a click with a tremble in it is not one.
        const DRAG_SLOP = 3;

        let drag = null;
        function endDrag() {
            const ending = drag;
            if (!ending) return;
            drag = null;   // first: releasing capture re-enters via lostpointercapture
            window.removeEventListener('pointermove', ending.onMove);
            window.removeEventListener('pointerup', endDrag);
            window.removeEventListener('pointercancel', endDrag);
            window.removeEventListener('blur', endDrag);
            resizer.classList.remove('dragging');
            document.body.classList.remove('files-resizing');
            try { resizer.releasePointerCapture(ending.pointerId); } catch { /* already released */ }
            if (!ending.moved) return;
            chosenWidth = parseInt(sidebar.style.width, 10);
            save(STORE.width, chosenWidth);
        }
        resizer.addEventListener('pointerdown', (e) => {
            // One drag at a time. A second pointer going down mid-drag
            // used to replace `drag`, orphaning the first onMove listener
            // so the sidebar kept following the pointer after pointerup.
            if (drag) return;
            if (e.button !== 0 || sidebar.classList.contains('collapsed') || PHONE.matches) return;
            e.preventDefault();
            const right = sidebar.getBoundingClientRect().right;
            const startX = e.clientX;
            const d = { pointerId: e.pointerId, moved: false };
            d.onMove = (ev) => {
                if (!d.moved && Math.abs(ev.clientX - startX) < DRAG_SLOP) return;
                d.moved = true;
                applyWidth(right - ev.clientX);
            };
            drag = d;
            try { resizer.setPointerCapture(e.pointerId); } catch { /* best effort */ }
            resizer.classList.add('dragging');
            document.body.classList.add('files-resizing');
            window.addEventListener('pointermove', drag.onMove);
            window.addEventListener('pointerup', endDrag);
            window.addEventListener('pointercancel', endDrag);
            window.addEventListener('blur', endDrag);
        });
        resizer.addEventListener('lostpointercapture', endDrag);
        // Switching tabs or apps mid-drag can swallow the pointerup.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') endDrag();
        });
        // A narrower window may no longer fit the chosen width, and a wider
        // one may fit it again.
        window.addEventListener('resize', () => {
            if (!drag) applyWidth(chosenWidth);
        });

        // Restore. A phone never reopens on load: there the sidebar
        // covers the terminal, which is not what someone opening the
        // add-on expects to see.
        syncTabs();
        hiddenToggle.hidden = currentTab !== 'files';
        placeProtectedToggle();
        recentHours.hidden = currentTab !== 'recent';
        if (load(STORE.open) === '1' && !PHONE.matches) setOpen(true, { persist: false });
    }

    root.FilesSidebarUI = { init };
})(typeof self !== 'undefined' ? self : this);
