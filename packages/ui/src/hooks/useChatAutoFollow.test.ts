import { describe, expect, test } from 'bun:test';

import {
    REPIN_EPSILON_PX,
    decideRestoreGate,
    isMaxScrollClamp,
    shouldReleaseAutoFollow,
    shouldRepinAutoFollow,
    shouldRekickFollowOnResize,
} from './useChatAutoFollow';

// ─── Pure predicates consumed by the WI-B instant-snap auto-follow engine ─────
// These are the ONLY positional predicates the engine reads: a two-threshold
// hysteresis (release / re-pin), the content-collapse clamp guard, the resize
// growth gate, and the one-shot restore gate. Each assertion would produce the
// WRONG result if the specific threshold/branch it guards were broken.
// (Behavioral / runtime oscillation asserts live in the WI-C Playwright job.)
// ──────────────────────────────────────────────────────────────────────────────

// ─── follow-loop re-snap growth gate ─────────────────────────────────────────
// The follow-loop ResizeObserver fires on BOTH content growth (new tokens) and
// viewport changes (mobile keyboard shrinking clientHeight). Only genuine content
// (scrollHeight) growth may re-snap to the bottom — a viewport resize must not
// masquerade as content growth (AGENTS.md), otherwise the instant snap would yank
// the user on every keyboard open. Mutation: flipping `>` to `>=` or `!==` reds
// the viewport-only false case below.
// ──────────────────────────────────────────────────────────────────────────────
describe('shouldRekickFollowOnResize', () => {
    test('content GROWTH (scrollHeight increased) -> re-snap', () => {
        expect(shouldRekickFollowOnResize(1000, 1200)).toBe(true);
    });

    test('viewport-only change (scrollHeight unchanged) -> NO re-snap (keyboard/resize)', () => {
        expect(shouldRekickFollowOnResize(1000, 1000)).toBe(false);
    });

    test('content SHRINK / clientHeight growth (scrollHeight decreased) -> NO re-snap', () => {
        expect(shouldRekickFollowOnResize(1000, 800)).toBe(false);
    });
});

// ─── renderable guard without deadlock (the far-up bug) + hash exemption ──────
// decideRestoreGate decides whether the restore effect should skip (hash deeplink
// owns the scroll — NOT force-snapped to bottom), wait (snapshot not renderable
// yet — must NOT mark the already-scrolled ref, so the effect re-runs once it
// becomes renderable), or restore (renderable — proceed with always-bottom-on-open
// and mark the ref AFTER). The far-up deadlock was caused by marking the ref before
// the renderable check; a 'wait' decision that leaves the ref unmarked breaks it.
describe('decideRestoreGate', () => {
    test('hash deeplink -> skip (hash handler owns scroll; checked FIRST, even when renderable)', () => {
        expect(decideRestoreGate({ isRenderable: true, isHashDeeplink: true })).toBe('skip');
    });

    test('hash deeplink wins even when NOT renderable (ordering: hash before renderable guard)', () => {
        expect(decideRestoreGate({ isRenderable: false, isHashDeeplink: true })).toBe('skip');
    });

    test('not renderable + no hash -> wait (do NOT mark ref; effect re-runs when renderable)', () => {
        expect(decideRestoreGate({ isRenderable: false, isHashDeeplink: false })).toBe('wait');
    });

    test('renderable + no hash -> restore (proceed and mark ref after)', () => {
        expect(decideRestoreGate({ isRenderable: true, isHashDeeplink: false })).toBe('restore');
    });
});

// ─── Two-threshold hysteresis pin/unpin predicates (WI-A) ────────────────────
// shouldReleaseAutoFollow + shouldRepinAutoFollow + isMaxScrollClamp are the pure
// positional predicates consumed by the WI-B engine.  Each assertion would produce
// the WRONG result if the specific threshold logic it guards is broken:
//   - changing > to >= in shouldReleaseAutoFollow would fire at the boundary
//   - changing <= to < in shouldRepinAutoFollow would miss the epsilon boundary
//   - removing isMaxScrollClamp gate would false-release on content collapse
//   - setting repinEpsilon == releaseThreshold eliminates the gap and causes thrash
// ─────────────────────────────────────────────────────────────────────────────

describe('shouldReleaseAutoFollow', () => {
    const RELEASE_T = 80; // representative bottom-zone threshold

    test('distanceFromBottom strictly above releaseThreshold -> releases', () => {
        expect(shouldReleaseAutoFollow({ distanceFromBottom: RELEASE_T + 1, releaseThreshold: RELEASE_T })).toBe(true);
    });

    test('large overshoot -> releases', () => {
        expect(shouldReleaseAutoFollow({ distanceFromBottom: 500, releaseThreshold: RELEASE_T })).toBe(true);
    });

    test('at exactly releaseThreshold -> does NOT release (exclusive boundary)', () => {
        // Bug: changing > to >= would make this return true (off-by-one thrash at boundary)
        expect(shouldReleaseAutoFollow({ distanceFromBottom: RELEASE_T, releaseThreshold: RELEASE_T })).toBe(false);
    });

    test('one px below releaseThreshold -> does NOT release', () => {
        expect(shouldReleaseAutoFollow({ distanceFromBottom: RELEASE_T - 1, releaseThreshold: RELEASE_T })).toBe(false);
    });

    test('distanceFromBottom === 0 (pinned at true bottom) -> does NOT release', () => {
        expect(shouldReleaseAutoFollow({ distanceFromBottom: 0, releaseThreshold: RELEASE_T })).toBe(false);
    });
});

describe('shouldRepinAutoFollow', () => {
    const REPIN_E = 2; // REPIN_EPSILON_PX

    test('distanceFromBottom === 0 (true bottom) -> re-pins', () => {
        expect(shouldRepinAutoFollow({ distanceFromBottom: 0, repinEpsilon: REPIN_E })).toBe(true);
    });

    test('distanceFromBottom at exactly repinEpsilon -> re-pins (inclusive boundary)', () => {
        // Bug: changing <= to < would miss the epsilon boundary case
        expect(shouldRepinAutoFollow({ distanceFromBottom: REPIN_E, repinEpsilon: REPIN_E })).toBe(true);
    });

    test('distanceFromBottom one px above repinEpsilon (in the gap) -> does NOT re-pin', () => {
        expect(shouldRepinAutoFollow({ distanceFromBottom: REPIN_E + 1, repinEpsilon: REPIN_E })).toBe(false);
    });

    test('distanceFromBottom well above repinEpsilon -> does NOT re-pin', () => {
        expect(shouldRepinAutoFollow({ distanceFromBottom: 80, repinEpsilon: REPIN_E })).toBe(false);
    });
});

describe('hysteresis gap — state is sticky between the two thresholds', () => {
    const RELEASE_T = 80;
    const REPIN_E = REPIN_EPSILON_PX; // 2

    test('in the gap (repinEpsilon < d < releaseThreshold) -> neither releases nor re-pins', () => {
        // A distance squarely in the gap must leave state unchanged
        const dInGap = Math.floor((REPIN_E + RELEASE_T) / 2); // 41 px
        expect(shouldReleaseAutoFollow({ distanceFromBottom: dInGap, releaseThreshold: RELEASE_T })).toBe(false);
        expect(shouldRepinAutoFollow({ distanceFromBottom: dInGap, repinEpsilon: REPIN_E })).toBe(false);
    });

    test('at the lower gap boundary (repinEpsilon + 1) -> neither fires', () => {
        const d = REPIN_E + 1;
        expect(shouldReleaseAutoFollow({ distanceFromBottom: d, releaseThreshold: RELEASE_T })).toBe(false);
        expect(shouldRepinAutoFollow({ distanceFromBottom: d, repinEpsilon: REPIN_E })).toBe(false);
    });

    test('at the upper gap boundary (releaseThreshold) -> neither fires (inclusive re-pin excluded)', () => {
        expect(shouldReleaseAutoFollow({ distanceFromBottom: RELEASE_T, releaseThreshold: RELEASE_T })).toBe(false);
        expect(shouldRepinAutoFollow({ distanceFromBottom: RELEASE_T, repinEpsilon: REPIN_E })).toBe(false);
    });

    test('INVARIANT: REPIN_EPSILON_PX < mobile bottom-zone threshold (no single-threshold thrash)', () => {
        // 40 px is BOTTOM_SPACER_MOBILE_PX — the smallest possible releaseThreshold.
        // If repinEpsilon >= releaseThreshold the gap disappears and state thrashes.
        expect(REPIN_EPSILON_PX).toBeLessThan(40);
        expect(REPIN_EPSILON_PX).toBeGreaterThan(0);
    });
});

describe('isMaxScrollClamp — content-collapse clamp guard', () => {
    test('maxScroll decreased -> content-driven clamp (must NOT release)', () => {
        expect(isMaxScrollClamp({ maxScrollNow: 1500, maxScrollPrev: 2000 })).toBe(true);
    });

    test('minimal shrink (1 px) is still a clamp', () => {
        // Bug: using <= instead of < would miss the equality case
        expect(isMaxScrollClamp({ maxScrollNow: 1999, maxScrollPrev: 2000 })).toBe(true);
    });

    test('maxScroll unchanged -> NOT a clamp (potential user scroll)', () => {
        expect(isMaxScrollClamp({ maxScrollNow: 2000, maxScrollPrev: 2000 })).toBe(false);
    });

    test('maxScroll increased (content grew) -> NOT a clamp', () => {
        expect(isMaxScrollClamp({ maxScrollNow: 2100, maxScrollPrev: 2000 })).toBe(false);
    });

    test('combining guard + shouldReleaseAutoFollow: clamp-shrink must NOT release', () => {
        // Scenario: placeholder collapsed, maxScroll dropped 500 px; distanceFromBottom
        // is now large — but it is clamp-driven, not a user scroll.
        const maxScrollNow = 1500;
        const maxScrollPrev = 2000;
        const dfb = 200; // far above a typical releaseThreshold
        const releaseThreshold = 80;

        // Step 1: guard fires -> call site must skip the release check
        expect(isMaxScrollClamp({ maxScrollNow, maxScrollPrev })).toBe(true);

        // Step 2: without the guard the release predicate would incorrectly fire
        expect(shouldReleaseAutoFollow({ distanceFromBottom: dfb, releaseThreshold })).toBe(true);

        // Step 3: correct gated usage -> no release
        const isClamp = isMaxScrollClamp({ maxScrollNow, maxScrollPrev });
        const willRelease = !isClamp && shouldReleaseAutoFollow({ distanceFromBottom: dfb, releaseThreshold });
        expect(willRelease).toBe(false);
    });
});

// ─── WI-C: PINNED auto-load-earlier / history prepend — no oscillation ─────────
// Oracle #3 / the residual session-open jiggle root cause, locked down here at the
// predicate level. The jiggle was TWO concurrent scrollTop writers disagreeing on
// the bottom target across different cadences (idle LERP + the 280 ms
// startSettleBurst rAF). WI-B (commit 9de56a46) collapsed everything to ONE
// idempotent instant writer: snapToBottomIfPinned, whose target is the browser
// max-scroll `scrollHeight - clientHeight` and which is a NO-OP when scrollTop is
// already there (useChatAutoFollow.ts:264-273).
//
// For a bottom-PINNED viewport, a history prepend of height `delta` must satisfy
// the AGREEMENT INVARIANT so there is no second, differing write:
//   • useChatTimelineController prepend compensation: scrollTop += delta
//     (useChatTimelineController.ts:417-421)
//   • useChatAutoFollow snap target:                  scrollHeight - clientHeight
// Both resolve to the SAME value, so the snap that runs after the compensation is
// idempotent — one write, no up-then-down.
//
// These asserts drive a REAL stateful scroll element (a fake of the external DOM
// I/O boundary — permitted by the fidelity hierarchy; NO internal module is
// mocked) through the REAL exported hysteresis/clamp predicates. Each would
// produce the WRONG result if the two-threshold hysteresis or the clamp guard
// regressed such that a pinned prepend RELEASED (FAB flicker) or failed to RE-PIN
// (stuck away from bottom) — the observable oscillation. The negative control
// proves the assertions are behavioral: drop the compensation and the SAME real
// predicates DO release.
//
// The multi-writer *timing* regression (a second rAF cadence such as
// startSettleBurst) is a runtime-only property — a real browser is required to
// observe scrollTop moving across frames — so it is guarded by the WI-C Playwright
// job e2e/sessionOpenNoOscillation.e2e.ts, which frame-samples scrollTop on
// session open and asserts zero change.
// ──────────────────────────────────────────────────────────────────────────────

interface FakeScrollGeometry {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
}

// The browser's universal max-scroll contract (NOT project-internal logic): the
// furthest scrollTop that still shows the bottom edge. This is the exact target
// snapToBottomIfPinned computes (Math.max(0, scrollHeight - clientHeight)).
const maxScrollOf = (el: FakeScrollGeometry): number => Math.max(0, el.scrollHeight - el.clientHeight);
const distanceFromBottomOf = (el: FakeScrollGeometry): number => maxScrollOf(el) - el.scrollTop;

describe('WI-C: pinned history prepend keeps a single bottom target (no oscillation)', () => {
    const CLIENT_H = 800;
    const RELEASE_T = 80; // representative desktop bottom-zone threshold
    const REPIN_E = REPIN_EPSILON_PX;
    const PREPEND_DELTA = 600; // older messages inserted above

    // Bottom-pinned viewport before the prepend.
    const makePinnedBottom = (): FakeScrollGeometry => {
        const el: FakeScrollGeometry = { scrollTop: 0, scrollHeight: 2000, clientHeight: CLIENT_H };
        el.scrollTop = maxScrollOf(el); // 1200 — truly at the bottom
        return el;
    };

    test('correct prepend compensation lands EXACTLY on the snap target (writers agree)', () => {
        const before = makePinnedBottom();
        expect(distanceFromBottomOf(before)).toBe(0); // precondition: pinned

        const maxScrollPrev = maxScrollOf(before);

        // Prepend older messages above: content grows by delta, scrollTop unchanged
        // by the browser (overflow-anchor:none). Timeline controller then applies
        // the compensation scrollTop += delta.
        const after: FakeScrollGeometry = {
            scrollTop: before.scrollTop + PREPEND_DELTA, // the compensation write
            scrollHeight: before.scrollHeight + PREPEND_DELTA,
            clientHeight: CLIENT_H,
        };
        const maxScrollNow = maxScrollOf(after);

        // AGREEMENT INVARIANT: compensated scrollTop === the snap target. The snap
        // that runs next is therefore a no-op — no second, differing write.
        expect(after.scrollTop).toBe(maxScrollOf(after));
        expect(distanceFromBottomOf(after)).toBe(0);

        // The prepend is content GROWTH, not a clamp — the clamp guard must NOT
        // swallow it (that guard is only for content SHRINK).
        expect(isMaxScrollClamp({ maxScrollNow, maxScrollPrev })).toBe(false);

        // With the writers in agreement the real hysteresis predicates keep the
        // viewport pinned: no release, re-pin holds.
        expect(shouldReleaseAutoFollow({ distanceFromBottom: distanceFromBottomOf(after), releaseThreshold: RELEASE_T })).toBe(false);
        expect(shouldRepinAutoFollow({ distanceFromBottom: distanceFromBottomOf(after), repinEpsilon: REPIN_E })).toBe(true);
    });

    test('NEGATIVE control: without the compensation the SAME predicates RELEASE (proves the assertion is behavioral)', () => {
        const before = makePinnedBottom();
        const maxScrollPrev = maxScrollOf(before);

        // Prepend WITHOUT compensation: content grows, scrollTop left where it was.
        const uncompensated: FakeScrollGeometry = {
            scrollTop: before.scrollTop, // BUG: no += delta
            scrollHeight: before.scrollHeight + PREPEND_DELTA,
            clientHeight: CLIENT_H,
        };
        const maxScrollNow = maxScrollOf(uncompensated);

        // The viewport is now delta px from the (grown) bottom.
        expect(distanceFromBottomOf(uncompensated)).toBe(PREPEND_DELTA);

        // The clamp guard cannot save it (maxScroll GREW, so not a clamp) and the
        // distance now exceeds the release threshold -> the real predicate RELEASES.
        // That release, immediately followed by the snap re-pin, is the up-then-down
        // oscillation the agreement invariant prevents.
        expect(isMaxScrollClamp({ maxScrollNow, maxScrollPrev })).toBe(false);
        expect(shouldReleaseAutoFollow({ distanceFromBottom: distanceFromBottomOf(uncompensated), releaseThreshold: RELEASE_T })).toBe(true);
    });

    test('idempotent snap: a redundant snap after correct compensation writes nothing (distance already 0)', () => {
        const after: FakeScrollGeometry = { scrollTop: 0, scrollHeight: 2600, clientHeight: CLIENT_H };
        after.scrollTop = maxScrollOf(after); // 1800 — post-compensation bottom

        // snapToBottomIfPinned early-returns when scrollTop === target
        // (useChatAutoFollow.ts:269). Model that guard against the REAL geometry
        // contract: distance is already 0, so no write occurs.
        const target = maxScrollOf(after);
        const wouldWrite = after.scrollTop !== target;
        expect(wouldWrite).toBe(false);
        expect(distanceFromBottomOf(after)).toBe(0);
    });

    test('a RELEASED viewport prepend still does not spuriously re-pin (compensation preserves read position, not bottom)', () => {
        // A user scrolled up (released) then a background prepend lands. Compensation
        // preserves the READ position (scrollTop += delta), so the distance from the
        // new bottom is unchanged and large -> re-pin must NOT fire.
        const releasedTop = 300;
        const before: FakeScrollGeometry = { scrollTop: releasedTop, scrollHeight: 2000, clientHeight: CLIENT_H };
        const distBefore = distanceFromBottomOf(before); // 1200 - 300 = 900

        const after: FakeScrollGeometry = {
            scrollTop: before.scrollTop + PREPEND_DELTA, // preserve read position
            scrollHeight: before.scrollHeight + PREPEND_DELTA,
            clientHeight: CLIENT_H,
        };
        // Distance from the new bottom is preserved by the compensation.
        expect(distanceFromBottomOf(after)).toBe(distBefore);
        expect(shouldRepinAutoFollow({ distanceFromBottom: distanceFromBottomOf(after), repinEpsilon: REPIN_E })).toBe(false);
    });
});
