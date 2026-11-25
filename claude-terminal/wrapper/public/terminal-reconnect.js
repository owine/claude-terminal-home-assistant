/**
 * Reconnect the terminal after sleep or a network drop.
 *
 * ttyd 1.7.7 retries a dropped connection once, straight away, and if that
 * fails it stops at "Press ⏎ to Reconnect". That one try often comes too
 * early: after sleep the network isn't back yet, or Home Assistant's ingress
 * session has expired and every request from the panel gets a 401 until Home
 * Assistant's page creates a new one when it next checks, up to a minute
 * later (ha-panel-app.ts).
 * While Home Assistant restarts, the app can't be reached at all (502), and
 * when run.sh's supervise() restarts the wrapper the socket simply closes.
 *
 * While ttyd shows that message, this asks the wrapper's /health with growing
 * gaps (1, 2, 5, then every 10 s), and at once when the browser comes back
 * online or the tab is shown again. When the wrapper answers, the terminal
 * frame is reloaded, which attaches to the same tmux session.
 *
 * Recovery ends only when the frame holds a NEW document with an `.xterm` in
 * it. A reload can land on something else: the service worker answers a
 * failed navigation with offline.html, and while ttyd is not listening the
 * wrapper answers with its "Starting the terminal…" page (proxy-error.js).
 * Neither has an `.xterm`, so the watchdog keeps reloading, backing off from
 * 10 to 60 s, until ttyd's page is back.
 *
 * This only reloads the frame. It does not touch mouse reporting, which is
 * tmux's alone (CLAUDE.md, "Mouse ownership"); the new ttyd client gets
 * tmux's mouse mode when it attaches. index.html's frame `load` handler wires
 * the new document's `term` (OSC 52, keys, fit) as it does on first load.
 *
 * Ported from ESJavadex/claude-code-ha (aca83b5, 43bb363, 6e28528), where
 * Neil Sleightholm wrote it. Kept close to that file so later fixes there
 * port cleanly; `recovering()` on the returned object is ours.
 */
(function (root, factory) {
    'use strict';
    var api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.ClaudeTerminalReconnect = api;
    }
})(typeof self !== 'undefined' ? self : null, function () {
    'use strict';

    // ttyd's own text (xterm/index.ts), shown in an overlay div that it
    // appends to the xterm element (addons/overlay.ts)
    var STUCK_TEXT = 'Press ⏎ to Reconnect';
    var DELAYS_MS = [1000, 2000, 5000, 10000];
    // Flapping: recovery ends as soon as ttyd's page loads, before its
    // WebSocket connects. If /health answers but the socket keeps failing
    // (a proxy that drops the upgrade, an origin the wrapper refuses), every
    // cycle would end in a fresh "recovery" and reload again within seconds,
    // forever. A terminal stuck again within STABLE_MS of recovering counts
    // as a flap, and each flap in a row doubles the wait before the next
    // check, from 10 s up to FLAP_MAX_MS. A terminal that stays up for
    // STABLE_MS clears the count.
    var STABLE_MS = 30000;
    var FLAP_MAX_MS = 300000;

    function isStuck(doc) {
        var term;
        try {
            term = doc && doc.querySelector('.xterm');
        } catch {
            return false;
        }
        if (!term || !term.children) {
            return false;
        }
        for (var i = 0; i < term.children.length; i++) {
            if (term.children[i].textContent === STUCK_TEXT) {
                return true;
            }
        }
        return false;
    }

    function install(iframe, options) {
        var opts = options || {};
        var win = opts.window || window;
        var doc = opts.document || document;
        var fetchFn = opts.fetch || function (url, init) { return win.fetch(url, init); };
        var setTimer = opts.setTimeout || function (fn, ms) { return win.setTimeout(fn, ms); };
        var clearTimer = opts.clearTimeout || function (id) { win.clearTimeout(id); };
        var healthUrl = opts.healthUrl || 'health';
        var clock = opts.now || function () { return Date.now(); };
        var recoveredAt = null;
        var flaps = 0;
        var log = opts.log || function (msg) {
            if (win.console) {
                win.console.info('[terminal-reconnect] ' + msg);
            }
        };
        var attempt = 0;
        var timer = null;
        var checking = false;
        var observer = null;
        var recovering = false;
        var reloading = false;
        var reloadDoc = null;
        var reloadAttempt = 0;

        function frameDoc() {
            try {
                return iframe.contentDocument;
            } catch {
                return null;
            }
        }

        function stuck() {
            return isStuck(frameDoc());
        }

        function needsRecovery() {
            if (stuck() && !recovering) {
                recovering = true;
                flaps = recoveredAt !== null && clock() - recoveredAt < STABLE_MS ? flaps + 1 : 0;
            }
            var d = frameDoc();
            // Only a replacement terminal document can finish a reload.
            if (recovering && (!reloading || d !== reloadDoc) && !stuck()) {
                try {
                    if (d && d.querySelector('.xterm')) {
                        recovering = false;
                        reloading = false;
                        reloadAttempt = 0;
                        attempt = 0;
                        recoveredAt = clock();
                    }
                } catch { /* a browser error page may be inaccessible */ }
            }
            return recovering;
        }

        function healthCheck() {
            var controller = new win.AbortController();
            var timeout;
            var request = Promise.resolve().then(function () {
                return fetchFn(healthUrl, { cache: 'no-store', signal: controller.signal });
            });
            var deadline = new Promise(function (resolve, reject) {
                timeout = setTimer(function () {
                    reject(new Error('health check timed out'));
                    controller.abort();
                }, 10000);
            });
            return Promise.race([request, deadline]).finally(function () {
                clearTimer(timeout);
            });
        }

        function schedule(now) {
            if (timer !== null) {
                clearTimer(timer);
            }
            var delay = 0;
            if (!now) {
                delay = DELAYS_MS[Math.min(attempt, DELAYS_MS.length - 1)];
                attempt++;
                if (flaps > 0) {
                    delay = Math.max(delay, Math.min(10000 * Math.pow(2, flaps - 1), FLAP_MAX_MS));
                }
            }
            timer = setTimer(check, delay);
            return delay;
        }

        function reload() {
            try {
                iframe.contentWindow.location.reload();
            } catch {
                // A cross-origin error page refuses location.reload();
                // assigning src again navigates the frame regardless.
                var src = iframe.src;
                iframe.src = src;
            }
        }

        function check() {
            timer = null;
            // A check already in flight schedules the next one itself
            if (checking) {
                return Promise.resolve();
            }
            if (!needsRecovery()) {
                attempt = 0;
                return Promise.resolve();
            }
            checking = true;
            return Promise.resolve()
                .then(function () {
                    return healthCheck();
                })
                .then(function (resp) {
                    if (resp && resp.ok) {
                        return true;
                    }
                    log('health answered ' + (resp ? resp.status : 'nothing'));
                    return false;
                }, function (err) {
                    log('health failed: ' + (err && err.message ? err.message : err));
                    return false;
                })
                .then(function (ok) {
                    checking = false;
                    // Enter pressed in the meantime may have reconnected it
                    if (!needsRecovery()) {
                        attempt = 0;
                    } else if (ok) {
                        log('app reachable, reloading the terminal');
                        reloadDoc = frameDoc();
                        reloading = true;
                        reload();
                        // Navigation can fail after health succeeds. Keep a watchdog
                        // until a replacement terminal document appears.
                        var reloadDelay = Math.min(10000 * Math.pow(2, reloadAttempt), 60000);
                        reloadAttempt = Math.min(reloadAttempt + 1, 3);
                        timer = setTimer(check, reloadDelay);
                    } else {
                        log('retrying in ' + schedule(false) / 1000 + ' s');
                    }
                });
        }

        function onMutation() {
            if (timer === null && !checking && needsRecovery()) {
                schedule(false);
            }
        }

        // A reload gives the frame a new document, so watch each one
        function watch() {
            if (observer) {
                observer.disconnect();
                observer = null;
            }
            var d = frameDoc();
            if (!d || !d.body || typeof win.MutationObserver !== 'function') {
                return;
            }
            observer = new win.MutationObserver(onMutation);
            observer.observe(d.body, { childList: true, subtree: true });
            onMutation();
        }

        iframe.addEventListener('load', watch);
        watch();
        win.addEventListener('online', function () {
            if (needsRecovery()) {
                schedule(true);
            }
        });
        doc.addEventListener('visibilitychange', function () {
            if (!doc.hidden && needsRecovery()) {
                schedule(true);
            }
        });

        // recovering(): true from the moment ttyd's prompt is seen until a
        // replacement terminal document has loaded. index.html uses it to
        // hold back its "did not finish loading" message for documents this
        // is already reloading past (offline.html, the starting page).
        return {
            check: check,
            recovering: needsRecovery
        };
    }

    return {
        install: install,
        isStuck: isStuck,
        STUCK_TEXT: STUCK_TEXT,
        DELAYS_MS: DELAYS_MS,
        STABLE_MS: STABLE_MS,
        FLAP_MAX_MS: FLAP_MAX_MS
    };
});
