'use strict';

// Terminal reconnect (public/terminal-reconnect.js): spotting ttyd's
// "Press ⏎ to Reconnect", retrying /health with growing gaps, and reloading
// the terminal frame once the wrapper answers.
//
// Ported with the module from ESJavadex/claude-code-ha
// (tests/test-terminal-reconnect.js); the tests after the upstream ones cover
// what differs here: the service worker's offline.html, the wrapper's
// starting page, and recovering().

const assert = require('node:assert');
const reconnect = require('../public/terminal-reconnect.js');

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// A frame whose xterm element holds ttyd's overlay, a manual clock, a
// MutationObserver that fires on demand and a scripted /health.
function makeSetup(healthResults) {
    const results = (healthResults || []).slice();
    const overlay = { textContent: '' };
    const xterm = { children: [] };
    let frameDoc;
    let hasTerminal = true;
    function newDoc() {
        return {
            body: {},
            querySelector: sel => (sel === '.xterm' && hasTerminal ? xterm : null)
        };
    }
    frameDoc = newDoc();

    const frameListeners = {};
    const iframe = {
        src: 'terminal/',
        reloads: 0,
        get contentDocument() { return frameDoc; },
        contentWindow: { location: { reload() { iframe.reloads++; } } },
        addEventListener(type, fn) { (frameListeners[type] = frameListeners[type] || []).push(fn); }
    };

    const observers = [];
    const winListeners = {};
    const docListeners = {};
    const win = {
        AbortController,
        MutationObserver: class {
            constructor(cb) { this.cb = cb; this.target = null; observers.push(this); }
            observe(target) { this.target = target; }
            disconnect() { this.target = null; }
        },
        addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); }
    };
    const doc = {
        hidden: false,
        addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); }
    };

    let timers = [];
    let nextId = 1;
    let clockMs = 0;
    const fetches = [];
    const api = reconnect.install(iframe, {
        window: win,
        document: doc,
        setTimeout(fn, ms) { const id = nextId++; timers.push({ id, fn, ms }); return id; },
        clearTimeout(id) { timers = timers.filter(t => t.id !== id); },
        log() {},
        now: () => clockMs,
        fetch(url, init) {
            fetches.push({ url, init });
            const r = results.length ? results.shift() : { ok: true };
            return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
        }
    });

    return {
        api, iframe, fetches,
        get timers() { return timers; },
        advance(ms) { clockMs += ms; },
        setStuck(text) {
            overlay.textContent = text;
            xterm.children = text === null ? [] : [overlay];
            // ttyd appends or changes the overlay: the observer sees it
            for (const o of observers) if (o.target) o.cb([]);
        },
        // Run the pending timer and let its /health promise settle
        async fire() {
            assert.strictEqual(timers.length, 1, `expected one timer, got ${timers.length}`);
            const t = timers.shift();
            await t.fn();
            await new Promise(r => setImmediate(r));
            return t.ms;
        },
        emitWindow(type) { (winListeners[type] || []).forEach(fn => fn()); },
        emitDoc(type) { (docListeners[type] || []).forEach(fn => fn()); },
        frameLoad(terminal = true) {
            hasTerminal = terminal;
            frameDoc = newDoc();
            (frameListeners.load || []).forEach(fn => fn());
        },
        observers,
        doc
    };
}

const STUCK = reconnect.STUCK_TEXT;

test('isStuck: only ttyd\'s "Press ⏎ to Reconnect" overlay counts', () => {
    const doc = children => ({ querySelector: () => ({ children }) });
    assert.strictEqual(STUCK, 'Press ⏎ to Reconnect');
    assert.strictEqual(reconnect.isStuck(doc([{ textContent: STUCK }])), true);
    assert.strictEqual(reconnect.isStuck(doc([{ textContent: 'Reconnecting...' }])), false);
    assert.strictEqual(reconnect.isStuck(doc([])), false);
    assert.strictEqual(reconnect.isStuck({ querySelector: () => null }), false);
    assert.strictEqual(reconnect.isStuck(null), false);
    assert.strictEqual(reconnect.isStuck({ querySelector() { throw new Error('cross-origin'); } }), false);
});

test('nothing happens while the terminal is connected', async () => {
    const s = makeSetup();
    s.setStuck('Reconnecting...');
    assert.strictEqual(s.timers.length, 0);
    s.emitWindow('online');
    s.emitDoc('visibilitychange');
    assert.strictEqual(s.timers.length, 0);
    assert.strictEqual(s.fetches.length, 0);
});

test('stuck, and the add-on answers: the frame is reloaded once', async () => {
    const s = makeSetup([{ ok: true }]);
    s.setStuck(STUCK);
    assert.strictEqual(await s.fire(), 1000);
    assert.deepStrictEqual(s.fetches.map(f => f.url), ['health']);
    assert.strictEqual(s.fetches[0].init.cache, 'no-store');
    assert.strictEqual(s.iframe.reloads, 1);
    assert.strictEqual(s.timers.length, 1, 'navigation watchdog remains active');
    s.setStuck(null);
    s.frameLoad();
    assert.strictEqual(s.timers.length, 0, 'recovery at load frees the reload watchdog');
    assert.strictEqual(s.timers.length, 0);
});

test('a refused session (401) or no network: retries at 1, 2, 5, then every 10 s', async () => {
    const s = makeSetup([{ ok: false, status: 401 }, new Error('offline'), { ok: false, status: 401 },
        { ok: false, status: 502 }, { ok: false, status: 401 }, { ok: true }]);
    s.setStuck(STUCK);
    const delays = [];
    for (let i = 0; i < 6; i++) delays.push(await s.fire());
    assert.deepStrictEqual(delays, [1000, 2000, 5000, 10000, 10000, 10000]);
    assert.strictEqual(s.fetches.length, 6);
    assert.strictEqual(s.iframe.reloads, 1);
});

test('back online or tab shown again: checks at once', async () => {
    const s = makeSetup([{ ok: false, status: 401 }, { ok: true }]);
    s.setStuck(STUCK);
    await s.fire();                       // 401, next try in 2 s
    assert.strictEqual(s.timers[0].ms, 2000);
    s.emitWindow('online');
    assert.strictEqual(s.timers.length, 1);
    assert.strictEqual(s.timers[0].ms, 0);
    await s.fire();
    assert.strictEqual(s.iframe.reloads, 1);

    const t = makeSetup([{ ok: true }]);
    t.setStuck(STUCK);
    t.doc.hidden = true;
    t.emitDoc('visibilitychange');
    assert.strictEqual(t.timers[0].ms, 1000, 'a hidden tab keeps the normal wait');
    t.doc.hidden = false;
    t.emitDoc('visibilitychange');
    assert.strictEqual(t.timers.length, 1);
    assert.strictEqual(t.timers[0].ms, 0);
});

test('reconnected by Enter while /health was pending: no reload', async () => {
    const s = makeSetup([{ ok: true }]);
    s.setStuck(STUCK);
    const t = s.timers.shift();
    const pending = t.fn();
    s.setStuck(null);                     // ttyd reconnected meanwhile
    await pending;
    await new Promise(r => setImmediate(r));
    assert.strictEqual(s.iframe.reloads, 0);
    assert.strictEqual(s.timers.length, 0);
});

test('after a reload, the new frame document is watched', async () => {
    const s = makeSetup([{ ok: true }, { ok: true }]);
    s.setStuck(STUCK);
    await s.fire();
    assert.strictEqual(s.iframe.reloads, 1);
    s.setStuck(null);
    s.frameLoad();
    assert.strictEqual(s.timers.length, 0, 'recovery at load frees the reload watchdog');
    const live = s.observers.filter(o => o.target);
    assert.strictEqual(live.length, 1, 'only the new document is observed');
    s.advance(reconnect.STABLE_MS); // a later drop, not a flap
    s.setStuck(STUCK);
    assert.strictEqual(await s.fire(), 1000, 'the wait starts again from 1 s');
    assert.strictEqual(s.iframe.reloads, 2);
});

test('a hung health request times out and retries', async () => {
    const s = makeSetup([new Promise(() => {}), { ok: true }]);
    s.setStuck(STUCK);
    const pending = s.timers.shift().fn();
    await new Promise(r => setImmediate(r));
    assert.strictEqual(s.timers[0].ms, 10000);
    const signal = s.fetches[0].init.signal;
    s.timers.shift().fn();
    await pending;
    assert.strictEqual(signal.aborted, true);
    assert.strictEqual(s.timers[0].ms, 2000);
    await s.fire();
    assert.strictEqual(s.iframe.reloads, 1);
});

test('failed navigation keeps retrying until a terminal document loads', async () => {
    const s = makeSetup([{ ok: true }, { ok: false, status: 502 }, { ok: true }]);
    s.setStuck(STUCK);
    await s.fire();
    s.setStuck(null);
    s.frameLoad(false); // ingress error page, without xterm
    await s.fire();
    assert.strictEqual(s.iframe.reloads, 1);
    s.emitWindow('online');
    assert.strictEqual(s.timers[0].ms, 0);
    await s.fire();
    assert.strictEqual(s.iframe.reloads, 2);
    s.frameLoad();
    assert.strictEqual(s.timers.length, 0, 'recovery at load frees the reload watchdog');
    assert.strictEqual(s.timers.length, 0);
});

test('a navigation that never loads is retried', async () => {
    const s = makeSetup();
    s.setStuck(STUCK);
    await s.fire();
    await s.fire();
    assert.strictEqual(s.iframe.reloads, 2);
});

test('repeated failed navigations back off and recovery resets the delay', async () => {
    const s = makeSetup();
    s.setStuck(STUCK);
    await s.fire();
    for (const delay of [10000, 20000, 40000, 60000, 60000]) {
        assert.strictEqual(s.timers[0].ms, delay);
        await s.fire();
    }
    s.setStuck(null);
    s.frameLoad();
    assert.strictEqual(s.timers.length, 0, 'recovery at load frees the reload watchdog');
    assert.strictEqual(s.timers.length, 0);
    s.advance(reconnect.STABLE_MS); // a later drop, not a flap
    s.setStuck(STUCK);
    assert.strictEqual(await s.fire(), 1000);
    assert.strictEqual(s.timers[0].ms, 10000);
});

// A terminal whose page loads but whose socket keeps failing would otherwise
// "recover" and reload again every couple of seconds, forever.
test('flapping: stuck again soon after each recovery, the wait doubles up to the cap', async () => {
    const s = makeSetup();
    s.setStuck(STUCK);
    assert.strictEqual(await s.fire(), 1000, 'the first drop is quick');
    const waits = [];
    for (let i = 0; i < 7; i++) {
        s.setStuck(null);
        s.frameLoad();          // ttyd's page loads: recovery ends...
        assert.strictEqual(s.timers.length, 0, 'recovery at load frees the reload watchdog');
        assert.strictEqual(s.timers.length, 0);
        s.advance(2000);        // ...then the socket fails again at once
        s.setStuck(STUCK);
        waits.push(await s.fire());
    }
    assert.deepStrictEqual(waits, [10000, 20000, 40000, 80000, 160000, 300000, 300000]);
    assert.strictEqual(reconnect.FLAP_MAX_MS, 300000);
    // Once it stays up for STABLE_MS, a later drop is quick again.
    s.setStuck(null);
    s.frameLoad();
    assert.strictEqual(s.timers.length, 0, 'recovery at load frees the reload watchdog');
    s.advance(reconnect.STABLE_MS);
    s.setStuck(STUCK);
    assert.strictEqual(await s.fire(), 1000);
});

test('flapping: coming back online still checks at once', async () => {
    const s = makeSetup();
    s.setStuck(STUCK);
    await s.fire();
    s.setStuck(null);
    s.frameLoad();
    assert.strictEqual(s.timers.length, 0, 'recovery at load frees the reload watchdog');
    s.advance(1000);
    s.setStuck(STUCK);
    assert.strictEqual(s.timers[0].ms, 10000, 'a flap waits');
    s.emitWindow('online');
    assert.strictEqual(s.timers.length, 1);
    assert.strictEqual(s.timers[0].ms, 0, 'online replaces the wait with an immediate check');
});

// --- timer bookkeeping (Sourcery on #595) ---

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}
const settle = () => new Promise(r => setImmediate(r));

test('a 429 from /health counts as the app being up: only the wrapper answers it', async () => {
    const s = makeSetup([{ ok: false, status: 429 }]);
    s.setStuck(STUCK);
    await s.fire();
    assert.strictEqual(s.iframe.reloads, 1);
});

test('a replacement terminal loading under the watchdog frees it, so a drop soon after schedules its own check', async () => {
    const s = makeSetup();
    s.setStuck(STUCK);
    await s.fire();
    assert.strictEqual(s.timers[0].ms, 10000, 'the reload watchdog');
    s.setStuck(null);
    s.frameLoad();
    assert.strictEqual(s.api.recovering(), false);
    assert.strictEqual(s.timers.length, 0, 'the watchdog is gone');
    s.advance(reconnect.STABLE_MS);
    s.setStuck(STUCK);
    assert.strictEqual(s.timers.length, 1);
    assert.strictEqual(s.timers[0].ms, 1000, 'its own check, not the old watchdog');
});

test('online during an in-flight check that then fails: the next check runs at once', async () => {
    const d = deferred();
    const s = makeSetup([d.promise]);
    s.setStuck(STUCK);
    const first = s.timers.shift();
    first.fn();                        // /health in flight
    s.emitWindow('online');
    assert.strictEqual(s.timers[0].ms, 0);
    await s.fire();                    // runs while the first is in flight
    d.resolve({ ok: false, status: 502 });
    await settle(); await settle();
    assert.strictEqual(s.timers.length, 1);
    assert.strictEqual(s.timers[0].ms, 0, 'immediate, not the 2 s back-off');
});

test('online during an in-flight check that then succeeds: one reload, not two', async () => {
    const d = deferred();
    const s = makeSetup([d.promise, { ok: true }]);
    s.setStuck(STUCK);
    s.timers.shift().fn();             // /health in flight
    s.emitWindow('online');            // an immediate check is queued...
    d.resolve({ ok: true });           // ...but the in-flight one wins
    await settle(); await settle();
    assert.strictEqual(s.iframe.reloads, 1);
    assert.strictEqual(s.timers.length, 1, 'only the reload watchdog');
    assert.strictEqual(s.timers[0].ms, 10000);
});

// --- ours: documents a reload can land on in this app ---

test('a reload answered by the service worker\'s offline.html keeps recovering', async () => {
    // sw.js answers a failed navigation with offline.html: same origin, a
    // body, no .xterm. That is not a recovered terminal.
    const s = makeSetup([{ ok: true }, { ok: true }]);
    s.setStuck(STUCK);
    await s.fire();
    assert.strictEqual(s.iframe.reloads, 1);
    s.setStuck(null);                    // the stuck document is gone
    s.frameLoad(false);                  // offline.html
    assert.strictEqual(s.api.recovering(), true);
    assert.strictEqual(s.timers.length, 1, 'the watchdog is still armed');
    assert.strictEqual(await s.fire(), 10000);
    assert.strictEqual(s.iframe.reloads, 2, 'offline.html was reloaded past');
    s.frameLoad();                       // ttyd's page again
    assert.strictEqual(s.timers.length, 0, 'recovery at load frees the reload watchdog');
    assert.strictEqual(s.api.recovering(), false);
    assert.strictEqual(s.timers.length, 0);
});

test('the wrapper\'s starting page, reloading itself, does not end recovery', async () => {
    // While ttyd is down the wrapper serves a page that refreshes every
    // second. Each refresh is a new document, but without an .xterm.
    const s = makeSetup([{ ok: true }]);
    s.setStuck(STUCK);
    await s.fire();
    s.setStuck(null);
    for (let i = 0; i < 5; i++) s.frameLoad(false);
    assert.strictEqual(s.api.recovering(), true);
    assert.strictEqual(s.timers.length, 1, 'refreshes must not stack timers');
    s.frameLoad();
    assert.strictEqual(s.api.recovering(), false);
});

test('recovering() is false while connected and true once ttyd gives up', () => {
    const s = makeSetup();
    assert.strictEqual(s.api.recovering(), false);
    s.setStuck('Reconnecting...');
    assert.strictEqual(s.api.recovering(), false);
    s.setStuck(STUCK);
    assert.strictEqual(s.api.recovering(), true);
});

test('the reloaded document itself (same document object) never counts as recovered', async () => {
    // A reload that has not navigated yet leaves the old document in place;
    // with ttyd's overlay cleared it must still not end recovery.
    const s = makeSetup([{ ok: true }]);
    s.setStuck(STUCK);
    await s.fire();
    s.setStuck(null);
    assert.strictEqual(s.api.recovering(), true);
});

(async () => {
    let failed = 0;
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log(`  ok  ${name}`);
        } catch (err) {
            failed++;
            console.log(`  FAIL ${name}\n       ${err.message}`);
        }
    }
    if (failed) {
        console.log(`Terminal reconnect tests: ${failed} failed`);
        process.exit(1);
    }
    console.log('Terminal reconnect tests passed');
})();
