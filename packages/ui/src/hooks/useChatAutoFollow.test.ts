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
