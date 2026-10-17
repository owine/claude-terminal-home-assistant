'use strict';

// How tall the page may be while the on-screen keyboard is up — pure logic,
// no DOM writes. Shipped to the browser (attaches to window.ViewportFit) AND
// required by the Node test harness (module.exports).
//
// The keyboard shrinks the visual viewport but leaves 100vh alone, so
// index.html sizes the layout from --app-height, set from visualViewport.
// That alone works on the direct port and in the PWA, where this page is the
// top window. Inside Home Assistant it is the ingress iframe, and iOS (and
// Chromium by default) shrink only the TOP window's visual viewport: this
// frame's own stays full height, and the prompt sat behind the keyboard until
// a keystroke made the browser scroll. Ingress is same-origin, so the top
// window's viewport is readable; follow it too.
//
// Ported from ESJavadex/claude-code-ha v2.3.6 (#50, by @nsleigh).
(function (root) {
    // Below this a height is bogus (iOS reports near-zero values mid-
    // transition) and applying it would collapse the terminal entirely.
    const MIN_HEIGHT = 120;

    // Rounding can leave the top viewport a fraction of a pixel short of
    // innerHeight with no keyboard up; that must not count as one.
    const SLACK = 1;

    const usable = (n) => typeof n === 'number' && Number.isFinite(n);

    /**
     * The height the page should take, or null to keep the current one.
     *
     * ownHeight: this page's own visualViewport.height.
     * outer: null (this page is the top window, or a parent is cross-origin),
     *   or the top window's { vvHeight, vvOffsetTop, innerHeight } plus
     *   frameTop, where this frame starts in the top window's layout viewport.
     *
     * The clamp applies only while the top viewport is shorter than the top
     * window: the keyboard, or a pinch-zoom. Otherwise this frame may be a
     * dashboard card scrolled partly off screen, and clamping would cut it to
     * whatever happened to be visible.
     */
    function visibleHeight({ ownHeight, outer } = {}) {
        if (!usable(ownHeight)) return null;
        let height = ownHeight;
        if (outer && usable(outer.vvHeight) && usable(outer.vvOffsetTop)
            && usable(outer.innerHeight) && usable(outer.frameTop)
            && outer.vvHeight < outer.innerHeight - SLACK) {
            const bottom = outer.vvOffsetTop + outer.vvHeight;
            height = Math.min(height, bottom - outer.frameTop);
        }
        return height < MIN_HEIGHT ? null : height;
    }

    /**
     * The top window's visual viewport as seen from `win`, or null when `win`
     * is the top window or any parent is cross-origin. frameTop sums each
     * frame's offset in its parent, so it is where `win` starts in the top
     * window. `viewport` is the live VisualViewport, for event listeners;
     * the numbers are a snapshot, so call again on each event.
     *
     * Every read is inside the try: across origins frameElement is null, and
     * touching the other window's properties throws a SecurityError.
     */
    function outerViewport(win) {
        try {
            if (!win) return null;
            let current = win;
            let frameTop = 0;
            while (current.parent !== current) {
                const frame = current.frameElement;
                if (!frame) return null;
                frameTop += frame.getBoundingClientRect().top;
                current = current.parent;
            }
            const viewport = current.visualViewport;
            if (current === win || !viewport) return null;
            return {
                viewport,
                vvHeight: viewport.height,
                vvOffsetTop: viewport.offsetTop,
                innerHeight: current.innerHeight,
                frameTop,
            };
        } catch {
            return null;
        }
    }

    const api = { visibleHeight, outerViewport, MIN_HEIGHT };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.ViewportFit = api;
})(typeof self !== 'undefined' ? self : this);
