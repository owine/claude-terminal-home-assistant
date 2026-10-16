// Files sidebar UI: the /config tree, the file preview with Insert path and
// Download, the protected toggle, the folder ⋯ menu and its zip download,
// the notice line, Recent changes, the HA configuration check, and the
// sidebar's open state, tabs and resizable width. The pure helpers it uses
// (quoting, sizes, URLs) are files-sidebar.js, which loads before this.
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
        const sidebar = document.getElementById('files-sidebar');
        const filesBtn = document.getElementById('files-btn');
        if (!helpers || !sidebar) {
            console.error('[wrapper] files-sidebar.js did not load');
            if (filesBtn) filesBtn.style.display = 'none';
            return;
        }

        const list = document.getElementById('files-list');
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
            row.style.paddingLeft = (8 + depth * 14) + 'px';
            if (!entry.sensitive) row.title = entry.path;
            else if (entry.type === 'dir') row.title = entry.path + ' (protected: its files open only with Show protected files on; never zipped)';
            else row.title = entry.path + ' (protected: may hold secrets; opens only with Show protected files on)';
            const twisty = document.createElement('span');
            twisty.className = 'files-twisty';
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

        // Generation of the view in #files-list. Every refresh() bumps it,
        // and a renderer whose generation is no longer current drops its
        // response: otherwise a slow Recent answer could land on top of the
        // Files tree after the user switched tabs (or changed the period,
        // or toggled Hidden files) while it was in flight.
        let viewGen = 0;

        // One folder level into `container`; subfolders load on expand.
        // `gen` is passed for the top level only: a subfolder renders into
        // its own container, which a refresh detaches rather than reuses.
        async function renderFolder(folderPath, container, depth, gen) {
            const stale = () => gen !== undefined && gen !== viewGen;
            container.replaceChildren(note('Loading…', depth));
            let data;
            try {
                data = await getJson('api/files/list?path=' + encodeURIComponent(folderPath));
            } catch (err) {
                if (stale()) return;
                container.replaceChildren(note('⚠️ ' + err.message, depth));
                return;
            }
            if (stale()) return;
            if (depth === 0 && data.root) rootPath = data.root;
            const entries = data.entries.filter((e) => showHidden.checked || !e.name.startsWith('.'));
            container.replaceChildren();
            if (!entries.length) container.append(note('(empty)', depth));
            for (const entry of entries) {
                const meta = entry.type === 'file' ? helpers.formatSize(entry.size) : '';
                const row = makeRow(entry, depth, entry.name, meta);
                // Plain buttons, reached with Tab: a folder is a disclosure
                // button (aria-expanded below) with its ⋯ beside it, and its
                // contents a group named after it. Not a role="tree": only
                // treeitems may sit in one, so the ⋯ could not, and a tree
                // promises arrow-key navigation this list never had.
                if (entry.type === 'dir') {
                    const wrap = document.createElement('div');
                    wrap.className = 'files-row-wrap';
                    wrap.append(row, makeMenuButton(entry));
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
                    let loaded = false;
                    row.addEventListener('click', () => {
                        select(row);
                        const open = children.hidden;
                        children.hidden = !open;
                        row.setAttribute('aria-expanded', String(open));
                        row.firstChild.textContent = open ? '▾' : '▸';
                        if (open && !loaded) {
                            loaded = true;
                            renderFolder(entry.path, children, depth + 1);
                        }
                    });
                } else {
                    row.addEventListener('click', () => { select(row); openPreview(entry.path, entry.sensitive); });
                }
            }
            if (data.truncated) container.append(note('… more entries not shown', depth));
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
            if (data.root) rootPath = data.root;
            list.replaceChildren();
            if (!data.entries.length) list.append(note('Nothing changed in this period'));
            for (const entry of data.entries) {
                const row = makeRow(entry, 0, helpers.relativeTo(rootPath, entry.path), helpers.formatAgo(entry.mtime));
                row.addEventListener('click', () => { select(row); openPreview(entry.path, entry.sensitive); });
                list.append(row);
            }
            if (data.truncated || data.incomplete) list.append(note('… showing the newest found; the search stopped early'));
        }

        function refresh() {
            closeMenu();
            tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === currentTab)));
            hiddenToggle.hidden = currentTab !== 'files';
            placeProtectedToggle();
            recentHours.hidden = currentTab !== 'recent';
            selectedRow = null;
            const gen = ++viewGen;
            if (currentTab === 'files') renderFolder(rootPath, list, 0, gen);
            else renderRecent(gen);
        }

        // kind: '' (news), 'busy' (try again shortly) or 'error'.
        // Returns the notice's generation, bumped by every showNotice
        // (a dismissal included), for showNoticeIf.
        let noticeGen = 0;
        function showNotice(text, kind = '') {
            noticeText.textContent = text;
            notice.className = kind;
            notice.hidden = !text;
            return ++noticeGen;
        }
        // Only if nothing has replaced notice `gen` since: an older zip's
        // good news must not overwrite a newer one's. Refusals do not
        // use it; they always show.
        function showNoticeIf(gen, text, kind = '') {
            if (gen === noticeGen) showNotice(text, kind);
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
            const gen = showNotice('Preparing ' + zipName + '…');
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
            showNoticeIf(gen, 'Downloading ' + (plan.name || zipName) + ': ' + plan.files
                + (plan.files === 1 ? ' file, ' : ' files, ') + helpers.formatSize(plan.bytes)
                + ' before compression. Protected files are left out.');
        }

        // Folder actions, behind the always-visible ⋯ on each folder row
        // (hover-only controls do not exist on a touch screen). A list,
        // so another action (the upload PR's "Upload here") is one more
        // entry. `hint` is shown under a disabled action, since a tooltip
        // is out of reach on touch.
        function folderActions(entry) {
            return [{
                label: 'Download as zip',
                disabled: !!entry.sensitive,
                hint: entry.sensitive ? 'Protected folders are never zipped' : '',
                title: entry.sensitive
                    ? 'This folder may hold secrets, so it is never zipped. Its files open one at a time with Show protected files on.'
                    : 'Download this folder as a .zip; protected files are left out',
                run: () => downloadZip(entry),
            }];
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
                if (action.disabled) {
                    item.setAttribute('aria-disabled', 'true');
                    // On screen inside the item, but read as its
                    // description, not as part of its name.
                    if (action.hint) {
                        const hint = document.createElement('span');
                        hint.className = 'files-menu-hint';
                        hint.id = 'files-menu-hint-' + menu.childElementCount;
                        hint.setAttribute('aria-hidden', 'true');
                        hint.textContent = action.hint;
                        item.append(hint);
                        item.setAttribute('aria-describedby', hint.id);
                    }
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
        function closePreview() {
            preview.classList.remove('active');
            if (previewSensitive) blankPreview();
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

        function setOpen(open, { persist = true } = {}) {
            if (!open) closeMenu();
            sidebar.classList.toggle('collapsed', !open);
            filesBtn.setAttribute('aria-expanded', String(open));
            if (persist) save(STORE.open, open ? '1' : '0');
            if (open && !list.childElementCount) refresh();
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

        // Insert path: types the quoted path at the prompt, no Enter - the
        // same sendInput() the upload button uses. On a phone the open
        // sidebar covers the terminal, so it closes first.
        document.getElementById('files-insert-btn').addEventListener('click', async () => {
            if (!previewPath) return;
            const text = helpers.shellQuote(previewPath);
            closePreview();
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
        document.getElementById('files-notice-close').addEventListener('click', () => showNotice(''));

        // previewPath is read at click time: a blanked preview has none,
        // and a protected file never goes out with the toggle off (by
        // construction its preview is blanked then; checked anyway).
        downloadBtn.addEventListener('click', () => {
            if (!previewPath || downloadBtn.disabled) return;
            if (previewSensitive && !showProtected.checked) return;
            startDownload(helpers.downloadUrl(previewPath, { protectedOn: showProtected.checked }));
        });
        document.getElementById('files-close-btn').addEventListener('click', closePreview);
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
        function applyWidth(width) {
            sidebar.style.width = helpers.clampWidth(width, document.getElementById('main').clientWidth) + 'px';
        }
        applyWidth(load(STORE.width));

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
            save(STORE.width, parseInt(sidebar.style.width, 10));
        }
        resizer.addEventListener('pointerdown', (e) => {
            // One drag at a time. A second pointer going down mid-drag
            // used to replace `drag`, orphaning the first onMove listener
            // so the sidebar kept following the pointer after pointerup.
            if (drag) return;
            if (e.button !== 0 || sidebar.classList.contains('collapsed') || PHONE.matches) return;
            e.preventDefault();
            const right = sidebar.getBoundingClientRect().right;
            drag = {
                pointerId: e.pointerId,
                onMove: (ev) => applyWidth(right - ev.clientX),
            };
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
        // A narrower window may no longer fit a remembered width.
        window.addEventListener('resize', () => {
            if (!drag) applyWidth(parseInt(sidebar.style.width, 10));
        });

        // Restore. A phone never reopens on load: there the sidebar
        // covers the terminal, which is not what someone opening the
        // add-on expects to see.
        tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === currentTab)));
        hiddenToggle.hidden = currentTab !== 'files';
        placeProtectedToggle();
        recentHours.hidden = currentTab !== 'recent';
        if (load(STORE.open) === '1' && !PHONE.matches) setOpen(true, { persist: false });
    }

    root.FilesSidebarUI = { init };
})(typeof self !== 'undefined' ? self : this);
