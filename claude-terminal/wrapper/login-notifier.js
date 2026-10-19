'use strict';

// Login notifier — posts Claude Code's OAuth login link as a Home Assistant
// persistent notification, and dismisses it once the login has gone through.
//
// The terminal header's Login Link Assistant (public/login-link.js) only exists
// while a browser has the terminal open. A notification reaches every HA
// frontend and the Companion app, so a login can be started on a phone without
// selecting a wrapped URL out of a terminal. The URL is rebuilt with the same
// reconstructLoginUrl() the assistant uses, so the two never disagree about it.
//
// Idea from nsleigh/claude-code-ha (2.1.9), itself adapted from
// heytcass/home-assistant-addons 2.5.2/2.5.3.
//
// This runs on timers inside the supervised wrapper, where an uncaught
// exception or unhandled rejection costs every open session a restart.
// tick() therefore never throws or rejects: each step swallows its own errors
// and the loop carries on.

const { execFile: nodeExecFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { reconstructLoginUrl } = require('./public/login-link.js');

const NOTIFICATION_ID = 'claude_terminal_login';
const SESSION = 'claude'; // run.sh setup_tmux_session
const POLL_MS = 3000;
const TMUX_TIMEOUT_MS = 5000;
const HTTP_TIMEOUT_MS = 10000;

// Promise wrapper over execFile: argv only, never a shell.
function runFile(execFile, file, args) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { timeout: TMUX_TIMEOUT_MS }, (err, stdout) => {
            if (err) reject(err);
            else resolve(String(stdout));
        });
    });
}

// Logged in = the credentials file holds an access token that has not expired.
// A missing or unreadable file, or one without claudeAiOauth, is logged out.
async function isLoggedIn({ readFile, homeDir, now }) {
    try {
        const raw = await readFile(path.join(homeDir, '.claude', '.credentials.json'), 'utf8');
        const expiresAt = Number(JSON.parse(raw)?.claudeAiOauth?.expiresAt);
        return Number.isFinite(expiresAt) && expiresAt > now();
    } catch {
        return false;
    }
}

// The visible pane only, not scrollback. Claude shows the URL on the login
// screen while it waits for the code, so the visible pane has it whenever it
// is still usable; an old one scrolled into history belongs to a finished
// login and must not be posted again (e.g. after a wrapper restart, which
// forgets which URLs were posted).
async function findLoginUrl({ execFile }) {
    const [screen, width] = await Promise.all([
        runFile(execFile, 'tmux', ['capture-pane', '-p', '-t', SESSION]),
        runFile(execFile, 'tmux', ['display-message', '-p', '-t', SESSION, '#{pane_width}']),
    ]);
    const cols = parseInt(width, 10);
    return reconstructLoginUrl(screen.split('\n'), Number.isFinite(cols) ? cols : undefined);
}

// Markdown link targets end at ')' and break at whitespace. Claude's OAuth URLs
// contain neither, but encode them anyway rather than trust that.
function markdownHref(url) {
    return url.replace(/[()\s]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

function notificationBody(url) {
    return {
        notification_id: NOTIFICATION_ID,
        title: 'Claude Code login',
        message:
            `[Open the Claude Code login page](${markdownHref(url)})\n\n` +
            'After signing in, paste the code it shows into the Claude Terminal Prowine terminal.\n\n' +
            `If the link does not open, copy it instead:\n\n\`${url}\``,
    };
}

function createLoginNotifier({
    supervisorUrl = 'http://supervisor',
    supervisorToken,
    homeDir,
    execFile = nodeExecFile,
    readFile = fs.readFile,
    fetch = globalThis.fetch,
    now = Date.now,
    log = console,
    pollMs = POLL_MS,
} = {}) {
    // URLs already posted. One whose login completed is kept for good: after
    // the access token expires the used link may still be on screen, and
    // posting it again would send the user to a login whose code nobody is
    // waiting for. A new login always prints a new URL (fresh state/PKCE
    // challenge), so it is still posted. One dismissed because it left the
    // capture is forgotten (see dismissShown), since the login may still be
    // waiting - the capture only sees the session's active window.
    const posted = new Set();
    let shownUrl = null;  // URL of the notification currently up, if any
    let missing = 0;      // consecutive captures without shownUrl on screen
    let timer = null;
    let generation = 0;   // bumped by start() and stop(); a stale loop exits
    // Last failure per service, so a Supervisor that keeps failing (HA Core
    // restarting, a 401) logs once per change instead of every poll.
    const lastFailure = {};

    function noteOutcome(service, failure) {
        const prefix = `Login notifier: persistent_notification.${service}`;
        if (failure && failure !== lastFailure[service]) {
            log.log(`${prefix} ${failure}`);
        } else if (!failure && lastFailure[service]) {
            log.log(`${prefix} working again`);
        }
        lastFailure[service] = failure;
    }

    // Returns whether the Supervisor accepted the call; never throws.
    async function callService(service, body) {
        try {
            const res = await fetch(`${supervisorUrl}/core/api/services/persistent_notification/${service}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${supervisorToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
            });
            noteOutcome(service, res.ok ? null : `returned HTTP ${res.status}`);
            return res.ok;
        } catch (err) {
            noteOutcome(service, `failed: ${err.message}`);
            return false;
        }
    }

    function dismiss() {
        return callService('dismiss', { notification_id: NOTIFICATION_ID });
    }

    async function dismissShown(reason, { forget = false } = {}) {
        const url = shownUrl;
        if (await dismiss()) {
            if (forget) posted.delete(url);
            shownUrl = null;
            missing = 0;
            log.log(`Login notifier: ${reason}, notification dismissed`);
        }
    }

    // A capture that lands mid-resize rebuilds the URL from rows at the wrong
    // width and stops short: a strict prefix of the real URL that still
    // passes isAuthUrl. It is the same login screen, seen badly - never a
    // link to post over the good one.
    function isTruncationOf(url, full) {
        return full.length > url.length && full.startsWith(url);
    }

    function alreadyPosted(url) {
        if (posted.has(url)) return true;
        for (const p of posted) if (isTruncationOf(url, p)) return true;
        return false;
    }

    async function tick() {
        try {
            if (await isLoggedIn({ readFile, homeDir, now })) {
                if (shownUrl) await dismissShown('login complete');
                return;
            }

            let url;
            try {
                url = await findLoginUrl({ execFile });
            } catch {
                return; // no tmux session yet, or tmux busy - try next tick
            }

            if (url && !alreadyPosted(url)) {
                if (await callService('create', notificationBody(url))) {
                    posted.add(url);
                    shownUrl = url;
                    missing = 0;
                    log.log('Login notifier: login link posted as a Home Assistant notification');
                }
                return;
            }

            // The credentials file is not the only way a login ends. A Console
            // (API-billing) login stores an API key in ~/.claude.json and
            // never writes claudeAiOauth, and an aborted one (Esc, claude
            // exiting) writes nothing. Both take the login screen away, so a
            // link that has left the pane for two polls in a row is done
            // with. Two, so one odd capture mid-redraw does not count; a
            // failed capture returned above and does not count either, and
            // a truncated one still shows the login screen.
            //
            // Gone from the capture is not proof the login is over, though:
            // the user may only have switched tmux windows. So the link is
            // forgotten as well, and posted again if it comes back.
            if (shownUrl) {
                const onScreen = url === shownUrl || (url && isTruncationOf(url, shownUrl));
                missing = onScreen ? 0 : missing + 1;
                if (missing >= 2) await dismissShown('login screen gone', { forget: true });
            }
        } catch (err) {
            log.log(`Login notifier: ${err.message}`);
        }
    }

    function schedule(gen) {
        timer = setTimeout(async () => {
            if (gen !== generation) return;
            await tick();
            if (gen === generation) schedule(gen);
        }, pollMs);
        timer.unref?.();
    }

    return {
        // A notification outlives the container, and its URL belongs to the
        // claude process that printed it. One left from a previous run points
        // at a login nobody is waiting for, so clear it before polling.
        // The generation check covers a stop() (or another start()) while
        // that dismiss or a tick is in flight: only the newest loop runs.
        async start() {
            const gen = ++generation;
            clearTimeout(timer);
            await dismiss();
            if (gen === generation) schedule(gen);
        },
        stop() {
            generation++;
            clearTimeout(timer);
            timer = null;
        },
        tick,
    };
}

// Build a notifier from the wrapper's environment, or return null when it
// should not run: switched off (LOGIN_NOTIFICATION, from the add-on option),
// no Supervisor to post through, or token auth (CLAUDE_CODE_OAUTH_TOKEN),
// where there is no browser login and no credentials file, so every poll
// would read as logged out.
function loginNotifierFromEnv(env = process.env, overrides = {}) {
    if (env.LOGIN_NOTIFICATION === 'false') return null;
    if (!env.SUPERVISOR_TOKEN) return null;
    if (env.CLAUDE_CODE_OAUTH_TOKEN) return null;
    return createLoginNotifier({
        supervisorToken: env.SUPERVISOR_TOKEN,
        homeDir: env.HOME || '/data/home',
        ...overrides,
    });
}

module.exports = { createLoginNotifier, loginNotifierFromEnv, notificationBody, NOTIFICATION_ID };
