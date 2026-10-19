'use strict';

// How tall the page may be with the on-screen keyboard up (public/viewport-fit.js).
//
// Under Home Assistant the page is the ingress iframe, and iOS (Chromium too,
// by default) shrinks only the TOP window's visual viewport for the keyboard.
// The frame's own visualViewport stays full height, so following it alone left
// the prompt behind the keyboard. These pin when the top viewport is allowed to
// clamp the height, and when it must not.

const { test } = require('node:test');
const assert = require('node:assert');
const { visibleHeight, outerViewport, watchOuterViewport, MIN_HEIGHT } = require('../public/viewport-fit.js');

// An HA-shaped top window: 844 tall (an iPhone), the panel iframe 56 px down,
// below HA's header.
const outer = (o) => ({ vvHeight: 844, vvOffsetTop: 0, innerHeight: 844, frameTop: 56, ...o });

// --- visibleHeight ---

test('with no outer viewport the page follows its own visual viewport', () => {
    // The direct port, the PWA, or a cross-origin parent.
    assert.strictEqual(visibleHeight({ ownHeight: 700, outer: null }), 700);
    assert.strictEqual(visibleHeight({ ownHeight: 700 }), 700);
});

test('an outer viewport with no keyboard does not clamp', () => {
    // The top viewport fills the top window, so nothing covers the frame.
    assert.strictEqual(visibleHeight({ ownHeight: 788, outer: outer() }), 788);
});

test('rounding noise in the top viewport is not mistaken for a keyboard', () => {
    // Fractional device pixels can leave the viewport a hair under innerHeight.
    assert.strictEqual(visibleHeight({ ownHeight: 788, outer: outer({ vvHeight: 843.5 }) }), 788);
});

test('with the keyboard open the page keeps to the part of the frame above it', () => {
    // The keyboard takes 336 px: 508 px of the top window is visible, and the
    // frame starts 56 px down, so 452 px of the frame is above the keyboard.
    // The frame's own viewport still reports its full 788.
    assert.strictEqual(visibleHeight({ ownHeight: 788, outer: outer({ vvHeight: 508 }) }), 452);
});

test('a frame lower down the page loses its offset from the visible height', () => {
    // A panel 300 px down a dashboard, keyboard up.
    assert.strictEqual(
        visibleHeight({ ownHeight: 500, outer: outer({ vvHeight: 508, frameTop: 300 }) }),
        208);
});

test('a frame lower down the page is not clamped while no keyboard is up', () => {
    // A dashboard card scrolled partly off screen must keep its full size,
    // not be cut to what happened to be visible.
    assert.strictEqual(
        visibleHeight({ ownHeight: 500, outer: outer({ frameTop: 600 }) }),
        500);
});

test('a pinch-zoom counts the visual viewport offset', () => {
    // Zoomed 2x and panned 100 px down: the visible part of the top window
    // runs from 100 to 522, so the frame (from 56) fits 466 px.
    assert.strictEqual(
        visibleHeight({ ownHeight: 788, outer: outer({ vvHeight: 422, vvOffsetTop: 100 }) }),
        466);
});

test('the clamp never makes the page taller than its own viewport', () => {
    // The top viewport is short, but the frame is shorter still.
    assert.strictEqual(
        visibleHeight({ ownHeight: 300, outer: outer({ vvHeight: 600 }) }),
        300);
});

test('a bogus small height is ignored', () => {
    // iOS can report a near-zero viewport mid-transition; applying it would
    // collapse the terminal entirely. null means "keep what you have".
    assert.strictEqual(visibleHeight({ ownHeight: 0, outer: null }), null);
    assert.strictEqual(visibleHeight({ ownHeight: MIN_HEIGHT - 1, outer: null }), null);
    assert.strictEqual(visibleHeight({ ownHeight: MIN_HEIGHT, outer: null }), MIN_HEIGHT);
    // ...even with a keyboard up: a bogus own height is not rescued by the clamp.
    assert.strictEqual(visibleHeight({ ownHeight: MIN_HEIGHT - 1, outer: outer({ vvHeight: 508 }) }), null);
});

test('a clamp that leaves almost nothing above the keyboard falls back to the own height', () => {
    // The own height is real; only the clamp is too small to apply. Keeping
    // whatever height the page had instead could leave it taller than the
    // frame, so follow the frame's own viewport, as before the clamp existed.
    assert.strictEqual(visibleHeight({ ownHeight: 788, outer: outer({ vvHeight: 150 }) }), 788);
});

test('rotating to landscape with the keyboard up fits the page to the frame', () => {
    // Landscape iPhone: the top window is 390 tall, the keyboard leaves 170 of
    // it, and the frame starts 56 down - a clamp of 114, under MIN_HEIGHT. The
    // frame itself is now 334. Keeping the portrait height (452) would
    // overflow it; the frame's own height is the best available.
    assert.strictEqual(
        visibleHeight({ ownHeight: 334, outer: outer({ vvHeight: 170, innerHeight: 390 }) }),
        334);
});

test('a non-numeric height is ignored', () => {
    assert.strictEqual(visibleHeight({ ownHeight: NaN, outer: null }), null);
    assert.strictEqual(visibleHeight({ ownHeight: undefined, outer: null }), null);
});

test('an outer viewport with unusable numbers is ignored, not obeyed', () => {
    assert.strictEqual(visibleHeight({ ownHeight: 700, outer: outer({ vvHeight: NaN }) }), 700);
    assert.strictEqual(visibleHeight({ ownHeight: 700, outer: outer({ frameTop: undefined }) }), 700);
});

// --- outerViewport ---
//
// Fake windows: just the properties the walk reads. A top window is its own
// parent; a child window's frameElement is the <iframe> in its parent.

function topWindow({ vvHeight = 844, vvOffsetTop = 0, innerHeight = 844 } = {}) {
    const win = { innerHeight, visualViewport: { height: vvHeight, offsetTop: vvOffsetTop } };
    win.parent = win;
    return win;
}

function childOf(parent, top, clientTop) {
    return { parent, frameElement: { getBoundingClientRect: () => ({ top }), clientTop } };
}

test('the top window has no outer viewport', () => {
    assert.strictEqual(outerViewport(topWindow()), null);
});

test('an ingress frame reads the top window and its own offset', () => {
    const top = topWindow({ vvHeight: 508 });
    const got = outerViewport(childOf(top, 56));
    assert.strictEqual(got.viewport, top.visualViewport);
    assert.deepStrictEqual(
        { vvHeight: got.vvHeight, vvOffsetTop: got.vvOffsetTop, innerHeight: got.innerHeight, frameTop: got.frameTop },
        { vvHeight: 508, vvOffsetTop: 0, innerHeight: 844, frameTop: 56 });
});

test('nested frames sum their offsets up to the top window', () => {
    const top = topWindow();
    const middle = childOf(top, 56);
    assert.strictEqual(outerViewport(childOf(middle, 20)).frameTop, 76);
});

test('a bordered frame counts its border in the offset', () => {
    // getBoundingClientRect().top is the frame's border edge; its document
    // starts clientTop (the top border) further down.
    const top = topWindow();
    assert.strictEqual(outerViewport(childOf(top, 56, 3)).frameTop, 59);
    const middle = childOf(top, 56, 2);
    assert.strictEqual(outerViewport(childOf(middle, 20, 1)).frameTop, 79);
});

test('a cross-origin parent gives no outer viewport', () => {
    // Across origins the browser hides frameElement (null)...
    const top = topWindow();
    assert.strictEqual(outerViewport({ parent: top, frameElement: null }), null);
    // ...and reading anything on the other window throws a SecurityError.
    const guarded = { get parent() { throw new Error('SecurityError'); } };
    assert.strictEqual(outerViewport(guarded), null);
    const hostile = { parent: top, get frameElement() { throw new Error('SecurityError'); } };
    assert.strictEqual(outerViewport(hostile), null);
});

test('a top window without visualViewport gives no outer viewport', () => {
    const top = topWindow();
    delete top.visualViewport;
    assert.strictEqual(outerViewport(childOf(top, 56)), null);
});

test('no window at all gives no outer viewport', () => {
    assert.strictEqual(outerViewport(undefined), null);
    assert.strictEqual(outerViewport(null), null);
});

// --- watchOuterViewport ---
//
// The listeners go on HA's top viewport, which outlives this frame: HA drops
// the ingress iframe when the user leaves the panel and makes a new one on
// return. Left attached, each visit's listeners keep firing and keep the dead
// document (wrapper, ttyd frame, xterm buffers) alive.

// An event target that records add/remove calls and can fire its listeners.
function fakeTarget() {
    const listeners = new Map();
    const t = {
        added: [],
        removed: [],
        addEventListener(type, fn) {
            t.added.push(type);
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(fn);
        },
        removeEventListener(type, fn) {
            t.removed.push(type);
            if (listeners.has(type)) listeners.get(type).delete(fn);
        },
        fire(type, event = {}) {
            for (const fn of [...(listeners.get(type) || [])]) fn(event);
        },
        count: (type) => (listeners.get(type) || new Set()).size,
    };
    return t;
}

test('the outer viewport gets resize and scroll listeners for the handler', () => {
    const win = fakeTarget();
    const viewport = fakeTarget();
    let calls = 0;
    watchOuterViewport(win, { viewport }, () => { calls += 1; });
    assert.deepStrictEqual(viewport.added.sort(), ['resize', 'scroll']);
    viewport.fire('resize');
    viewport.fire('scroll');
    assert.strictEqual(calls, 2);
});

test('the frame unloading removes both outer listeners, once', () => {
    const win = fakeTarget();
    const viewport = fakeTarget();
    watchOuterViewport(win, { viewport }, () => {});
    assert.deepStrictEqual(win.added, ['pagehide']);
    win.fire('pagehide', { persisted: false });
    assert.deepStrictEqual(viewport.removed.sort(), ['resize', 'scroll']);
    assert.strictEqual(viewport.count('resize') + viewport.count('scroll'), 0);
    // A second pagehide (or any later teardown) must not remove again.
    win.fire('pagehide', { persisted: false });
    assert.strictEqual(viewport.removed.length, 2);
    // ...and the pagehide listener took itself off the frame's window.
    assert.strictEqual(win.count('pagehide'), 0);
});

test('a page entering the back-forward cache keeps its listeners', () => {
    // persisted: the whole tab is frozen with HA's top window, nothing leaks,
    // and the page may come back - it would come back without the fit.
    const win = fakeTarget();
    const viewport = fakeTarget();
    watchOuterViewport(win, { viewport }, () => {});
    win.fire('pagehide', { persisted: true });
    assert.deepStrictEqual(viewport.removed, []);
    win.fire('pagehide', { persisted: false });
    assert.deepStrictEqual(viewport.removed.sort(), ['resize', 'scroll']);
});

test('the returned teardown removes the listeners too, once', () => {
    const win = fakeTarget();
    const viewport = fakeTarget();
    const teardown = watchOuterViewport(win, { viewport }, () => {});
    teardown();
    assert.deepStrictEqual(viewport.removed.sort(), ['resize', 'scroll']);
    assert.strictEqual(viewport.count('resize'), 0);
    assert.strictEqual(viewport.count('scroll'), 0);
    assert.strictEqual(win.count('pagehide'), 0);
    teardown();
    win.fire('pagehide', { persisted: false });
    assert.strictEqual(viewport.removed.length, 2);
});

test('a throwing outer viewport never throws out of the watcher', () => {
    // A parent gone cross-origin, or already torn down.
    const boom = () => { throw new Error('SecurityError'); };
    const win = fakeTarget();
    const teardown = watchOuterViewport(win,
        { viewport: { addEventListener: boom, removeEventListener: boom } }, () => {});
    assert.strictEqual(typeof teardown, 'function');
    assert.doesNotThrow(() => teardown());

    // Adds succeed, removes throw: the pagehide path must swallow it too.
    const win2 = fakeTarget();
    const viewport = fakeTarget();
    viewport.removeEventListener = boom;
    watchOuterViewport(win2, { viewport }, () => {});
    assert.doesNotThrow(() => win2.fire('pagehide', { persisted: false }));

    // And a frame window that refuses listeners.
    const watched = fakeTarget();
    assert.doesNotThrow(() => watchOuterViewport(
        { addEventListener: boom, removeEventListener: boom }, { viewport: watched }, () => {})());
});

test('no outer viewport gives a teardown that does nothing', () => {
    const win = fakeTarget();
    for (const outer of [null, undefined, {}]) {
        const teardown = watchOuterViewport(win, outer, () => {});
        assert.doesNotThrow(() => teardown());
    }
    assert.deepStrictEqual(win.added, []);
});
