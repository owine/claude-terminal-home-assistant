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
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { reconstructLoginUrl } = require('./public/login-link.js');

const NOTIFICATION_ID = 'claude_terminal_login';
const SESSION = 'claude'; // run.sh setup_tmux_session
const POLL_MS = 3000;
// Each poll spawns two tmux processes, logged in or not: /login to renew a
// login or switch account prints a link while the old login is still valid.
// With nothing to watch - no link to post and no notification up - the gap
// doubles up to this, so an idle add-on does not spawn ~57,600 of them a day.
// A link to post or a notification to watch brings it straight back to
// POLL_MS. The price is a slower first notice of a
// new login screen: up to this long after it appears.
const MAX_POLL_MS = 30000;
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

// The saved login, as two facts about the credentials file:
//
// - loggedIn: it holds an access token that has not expired. A missing or
//   unreadable file, or one without claudeAiOauth, is logged out.
// - stamp: a digest of its contents, which changes whenever the saved login
//   does (a new login, an account switch, a token refresh). Only ever
//   compared, never logged or sent anywhere; 'none' when there is no file.
//   null when the file could not be read or parsed (EACCES, caught
//   mid-write): that says nothing about the saved login, so the caller keeps
//   the last stamp it had rather than taking a digest of a half-written file
//   or a synthetic one that would look like a new login on the next read.
async function readCredentials({ readFile, homeDir, now }) {
    let raw;
    try {
        raw = String(await readFile(path.join(homeDir, '.claude', '.credentials.json'), 'utf8'));
    } catch (err) {
        return { loggedIn: false, stamp: err && err.code === 'ENOENT' ? 'none' : null };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { loggedIn: false, stamp: null };
    }
    const stamp = createHash('sha256').update(raw).digest('hex');
    const expiresAt = Number(parsed?.claudeAiOauth?.expiresAt);
    return { loggedIn: Number.isFinite(expiresAt) && expiresAt > now(), stamp };
}

// The visible pane only, not scrollback. Claude shows the URL on the login
// screen while it waits for the code, so the visible pane has it whenever it
// is still usable; an old one scrolled into history belongs to a finished
// login and must not be posted again (e.g. after a wrapper restart, which
// forgets which URLs were posted).
// The start of a login link: host and authorize path, which come in the
// first few dozen characters of every one. A capture that shows one but
// yields no complete URL (cut short, elided, mid-redraw) is inconclusive,
// not proof the login screen is gone. It is looked for in the capture with
// whitespace and box borders removed, so a wrap that splits the host or path
// across rows still matches. The authorize path is required: another link
// to the same hosts (docs, a URL Claude printed) must not keep a stale
// notification up.
const LOGIN_LINK_START =
    /https:\/\/(?:[a-z0-9-]+\.)*(?:claude\.ai|claude\.com|anthropic\.com)\/(?:[a-z0-9-]+\/)*oauth\/authorize/i;
const UNWRAP = /[\s│┃┆┇┊┋║|]+/g;

// { url: the complete login URL on the pane, or null; linkStart: whether the
// pane shows the start of a login-host link at all }.
async function findLoginUrl({ execFile }) {
    const [screen, width] = await Promise.all([
        runFile(execFile, 'tmux', ['capture-pane', '-p', '-t', SESSION]),
        runFile(execFile, 'tmux', ['display-message', '-p', '-t', SESSION, '#{pane_width}']),
    ]);
    const cols = parseInt(width, 10);
    return {
        url: reconstructLoginUrl(screen.split('\n'), Number.isFinite(cols) ? cols : undefined),
        linkStart: LOGIN_LINK_START.test(screen.replace(UNWRAP, '')),
    };
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
    maxPollMs = MAX_POLL_MS,
    timers = { setTimeout, clearTimeout },
} = {}) {
    // URLs already posted. One whose login completed is kept for good: after
    // the access token expires the used link may still be on screen, and
    // posting it again would send the user to a login whose code nobody is
    // waiting for. A new login always prints a new URL (fresh state/PKCE
    // challenge), so it is still posted. One dismissed because it left the
    // capture moves to `abandoned` (see dismissShown) and may be posted
    // again, since the login may still be waiting - the capture only sees the
    // session's active window. Any login that completes after it was posted
    // moves an abandoned URL back here: the user may have used it without the
    // notifier ever seeing it on screen again.
    //
    // "A login completes" = logged in, with a credentials stamp other than
    // the one taken when the link was posted. Being logged in is not enough
    // on its own: /login to renew or switch account runs while the old login
    // is still valid, and its link must stay up until the new one is saved.
    // A token refresh changes the stamp too, so one landing mid-/login
    // dismisses that link early; the terminal banner still has it.
    const posted = new Set();
    const abandoned = new Map(); // url -> credentials stamp when it was posted
    let shownUrl = null;  // URL of the notification currently up, if any
    let shownStamp = null; // credentials stamp when shownUrl was posted
    // The last stamp read successfully (see readCredentials); null until one
    // has been. A link posted while it is unknown has no baseline yet, and
    // takes the next good read as its baseline rather than as a change.
    let lastStamp = null;
    let missing = 0;      // consecutive captures without shownUrl on screen
    let timer = null;
    let delay = pollMs;   // gap before the next poll; see MAX_POLL_MS
    let watching = false; // set by tick(): a link to post or a notification up
    // Whether a capture has succeeded since start(). Until one has, a failed
    // capture is the boot case - the wrapper starts minutes before tmux can -
    // and the loop holds its pace rather than backing off, so the first
    // login screen is seen promptly. After that, a failed capture (the
    // session gone) backs off like an idle one.
    let paneSeen = false;
    let waitingForPane = false; // set by tick()
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
            if (forget) {
                posted.delete(url);
                abandoned.set(url, shownStamp);
            }
            shownUrl = null;
            shownStamp = null;
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
        let unposted = false;
        waitingForPane = false;
        try {
            // Links are looked for while logged in too, so this does not
            // return: a login completing is only grounds to dismiss.
            const creds = await readCredentials({ readFile, homeDir, now });
            if (creds.stamp === null) creds.stamp = lastStamp;
            else lastStamp = creds.stamp;
            if (creds.loggedIn) {
                for (const [u, stamp] of abandoned) {
                    if (stamp === null) {
                        abandoned.set(u, creds.stamp);
                    } else if (stamp !== creds.stamp) {
                        posted.add(u);
                        abandoned.delete(u);
                    }
                }
                if (shownUrl && shownStamp === null) {
                    shownStamp = creds.stamp;
                } else if (shownUrl && creds.stamp !== shownStamp) {
                    await dismissShown('login complete');
                }
            }

            let url, linkStart;
            try {
                ({ url, linkStart } = await findLoginUrl({ execFile }));
            } catch {
                waitingForPane = !paneSeen;
                return; // no tmux session yet, or tmux busy - try next tick
            }
            paneSeen = true;

            if (url && !alreadyPosted(url)) {
                unposted = true; // retried every poll until the create succeeds
                if (await callService('create', notificationBody(url))) {
                    posted.add(url);
                    abandoned.delete(url);
                    shownUrl = url;
                    shownStamp = creds.stamp;
                    missing = 0;
                    log.log('Login notifier: login link posted as a Home Assistant notification');
                }
                return;
            }

            // The credentials file is not the only way a login ends. A Console
            // (API-billing) login stores an API key in ~/.claude.json and
            // never writes claudeAiOauth, and an aborted one (Esc, claude
            // exiting, a /login cancelled while still logged in) writes
            // nothing. Both take the login screen away, so a link that has
            // left the pane for two polls in a row is done with. Two, so one
            // odd capture mid-redraw does not count; a failed capture
            // returned above and does not count either, and a truncated one
            // still shows the login screen.
            //
            // Gone from the capture is not proof the login is over, though:
            // the user may only have switched tmux windows. So the link is
            // set aside as abandoned, not used, and posted again if it comes
            // back before a login completes.
            if (shownUrl) {
                const onScreen = url === shownUrl || (url && isTruncationOf(url, shownUrl));
                // No complete URL, but a login link still starts on the pane:
                // a capture cut short or elided. It neither confirms nor
                // counts against the link; only a pane without one does.
                const inconclusive = !url && linkStart;
                if (onScreen) missing = 0;
                else if (!inconclusive) missing += 1;
                if (missing >= 2) await dismissShown('login screen gone', { forget: true });
            }
        } catch (err) {
            log.log(`Login notifier: ${err.message}`);
        } finally {
            watching = unposted || shownUrl !== null;
        }
    }

    function schedule(gen) {
        timer = timers.setTimeout(async () => {
            if (gen !== generation) return;
            await tick();
            if (gen !== generation) return;
            if (watching) delay = pollMs;
            else if (!waitingForPane) delay = Math.min(delay * 2, Math.max(maxPollMs, pollMs));
            schedule(gen);
        }, delay);
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
            timers.clearTimeout(timer);
            delay = pollMs;
            paneSeen = false;
            await dismiss();
            if (gen === generation) schedule(gen);
        },
        stop() {
            generation++;
            timers.clearTimeout(timer);
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
