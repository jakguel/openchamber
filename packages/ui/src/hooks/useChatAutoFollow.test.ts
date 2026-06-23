import { describe, expect, test } from 'bun:test';

import {
    MAX_RESTORE_RECORRECTIONS,
    decideReCorrection,
    decideRestoreGate,
    isAtBottomSnapshot,
    isHealthyScrollSnapshot,
    isRealMessageAnchor,
    isReleasedSinceWindowOpen,
    nextFollowTop,
    resolveRestoreTarget,
    shouldReleaseAutoFollowOnScroll,
} from './useChatAutoFollow';

// ─── Regression context ────────────────────────────────────────────────────────
// Bug: pending-subagent ToolPart height churn transiently collapses scrollHeight.
// The browser clamps scrollTop downward (currentTop < previousTop) even though the
// user never touched the scroll handle.  HALF 1 fix: shouldReleaseAutoFollowOnScroll
// returns false when maxScrollNow < maxScrollPrev (content-driven clamp).
// These tests FAIL if that guard is removed (bug reintroduced).
// ──────────────────────────────────────────────────────────────────────────────

// Layout is injected (scrollTop / maxScroll = scrollHeight - clientHeight) because
// bun:test has no real DOM layout; that is the only external boundary stubbed here.

const base = {
    state: 'following' as const,
    currentTop: 800,
    previousTop: 1000,
    maxScrollNow: 2000,
    maxScrollPrev: 2000,
    programmatic: false,
};

describe('shouldReleaseAutoFollowOnScroll', () => {
    test('AC4: genuine scroll-up with UNCHANGED maxScroll releases auto-follow', () => {
        // moved up (800 < 1000), maxScroll unchanged -> real user gesture
        expect(shouldReleaseAutoFollowOnScroll(base)).toBe(true);
    });

    test('AC2: content-driven clamp (scroll-up + maxScroll DECREASED) does NOT release', () => {
        // placeholder collapsed: scrollHeight dropped -> maxScroll dropped ->
        // scrollTop clamped down. Must stay following.
        expect(shouldReleaseAutoFollowOnScroll({
            ...base,
            maxScrollNow: 1500,
            maxScrollPrev: 2000,
        })).toBe(false);
    });

    test('does not release when not currently following', () => {
        expect(shouldReleaseAutoFollowOnScroll({
            ...base,
            state: 'released',
        })).toBe(false);
    });

    test('does not release when scroll did not move up (downward / no move)', () => {
        // scrolled down
        expect(shouldReleaseAutoFollowOnScroll({
            ...base,
            currentTop: 1200,
            previousTop: 1000,
        })).toBe(false);
        // no movement
        expect(shouldReleaseAutoFollowOnScroll({
            ...base,
            currentTop: 1000,
            previousTop: 1000,
        })).toBe(false);
    });

    test('content GROWTH with a downward scroll does not release (normal follow path)', () => {
        expect(shouldReleaseAutoFollowOnScroll({
            ...base,
            currentTop: 1100,
            previousTop: 1000,
            maxScrollNow: 2200,
            maxScrollPrev: 2000,
        })).toBe(false);
    });

    test('genuine scroll-up while maxScroll GREW still releases (user fights growth)', () => {
        // maxScroll increased (content grew) but the user scrolled up anyway:
        // not a clamp, so a real gesture must still release.
        expect(shouldReleaseAutoFollowOnScroll({
            ...base,
            maxScrollNow: 2100,
            maxScrollPrev: 2000,
        })).toBe(true);
    });

    test('gap#5: programmatic restore write does NOT release auto-follow', () => {
        expect(shouldReleaseAutoFollowOnScroll({
            ...base,
            programmatic: true,
        })).toBe(false);
    });

    test('gap#5: same scroll delta from a real user gesture DOES release', () => {
        expect(shouldReleaseAutoFollowOnScroll({
            ...base,
            programmatic: false,
        })).toBe(true);
    });
});

// ─── Scroll oscillation regression — HALF 1 ───────────────────────────────────
// These tests directly encode the two halves of the oscillation bug fix.
// Each assertion would produce the WRONG result if the corresponding production
// guard were removed.
// ──────────────────────────────────────────────────────────────────────────────
describe('scroll oscillation regression — HALF 1 (maxScroll-decrease clamp guard)', () => {
    // (a) Content shrink: pending-subagent placeholder collapses.
    // maxScroll drops by a large amount -> scrollTop is clamped down by the browser.
    // The guard MUST keep state 'following' (not release).
    // Regression: if the guard is removed, this returns true (bug reintroduced).
    test('(a) large maxScroll decrease keeps auto-follow state following', () => {
        expect(shouldReleaseAutoFollowOnScroll({
            state: 'following',
            currentTop: 500,   // clamped down from 1000
            previousTop: 1000,
            maxScrollNow: 500,  // scrollHeight shrank -> maxScroll dropped 1500px
            maxScrollPrev: 2000,
            programmatic: false,
        })).toBe(false);
    });

    // (a) Boundary: maxScroll decreases by exactly 1px — still a content-driven clamp.
    test('(a) minimal maxScroll decrease (1px) still suppresses release', () => {
        expect(shouldReleaseAutoFollowOnScroll({
            state: 'following',
            currentTop: 999,
            previousTop: 1000,
            maxScrollNow: 1999,  // decreased by 1
            maxScrollPrev: 2000,
            programmatic: false,
        })).toBe(false);
    });

    // (a) clientHeight growth also decreases maxScroll (scrollHeight - clientHeight).
    // This is another content-driven clamp that must NOT release.
    test('(a) clientHeight growth causing maxScroll decrease does not release', () => {
        // e.g. viewport expanded (clientHeight grew 200px), scrollHeight unchanged
        // -> maxScroll = scrollHeight - clientHeight dropped by 200
        expect(shouldReleaseAutoFollowOnScroll({
            state: 'following',
            currentTop: 800,
            previousTop: 1000,
            maxScrollNow: 1800,  // clientHeight grew 200px
            maxScrollPrev: 2000,
            programmatic: false,
        })).toBe(false);
    });

    // (b) Genuine scroll-up: user scrolled up while content was stable.
    // maxScroll is UNCHANGED -> this is a real user gesture -> MUST release.
    // Regression: if the guard is over-broad (always suppresses), this returns false (bug).
    test('(b) genuine scroll-up with unchanged maxScroll releases auto-follow', () => {
        expect(shouldReleaseAutoFollowOnScroll({
            state: 'following',
            currentTop: 500,
            previousTop: 1000,
            maxScrollNow: 2000,
            maxScrollPrev: 2000,
            programmatic: false,
        })).toBe(true);
    });

    // (b) Genuine scroll-up while content grew: user scrolled up against streaming growth.
    // maxScroll INCREASED (content grew) but user moved up -> real gesture -> MUST release.
    test('(b) genuine scroll-up against growing content releases auto-follow', () => {
        expect(shouldReleaseAutoFollowOnScroll({
            state: 'following',
            currentTop: 800,
            previousTop: 1000,
            maxScrollNow: 2500,  // content grew
            maxScrollPrev: 2000,
            programmatic: false,
        })).toBe(true);
    });

    // Guard is inactive when state is already 'released' — no double-release.
    test('released state is never re-released (idempotent)', () => {
        expect(shouldReleaseAutoFollowOnScroll({
            state: 'released',
            currentTop: 500,
            previousTop: 1000,
            maxScrollNow: 2000,
            maxScrollPrev: 2000,
            programmatic: false,
        })).toBe(false);
    });

    // Downward scroll (currentTop > previousTop) never releases regardless of maxScroll.
    test('downward scroll never releases even with stable maxScroll', () => {
        expect(shouldReleaseAutoFollowOnScroll({
            state: 'following',
            currentTop: 1100,
            previousTop: 1000,
            maxScrollNow: 2000,
            maxScrollPrev: 2000,
            programmatic: false,
        })).toBe(false);
    });

    // maxScroll decreased AND scroll moved down — content-driven clamp going down.
    // Must not release (no upward movement).
    test('downward clamp (maxScroll decreased, scroll moved down) does not release', () => {
        expect(shouldReleaseAutoFollowOnScroll({
            state: 'following',
            currentTop: 1100,
            previousTop: 1000,
            maxScrollNow: 1500,
            maxScrollPrev: 2000,
            programmatic: false,
        })).toBe(false);
    });
});

// ─── Scroll jitter regression — HALF 2 (streaming hard-snap follow step) ──────────
// Bug: during streaming, content grows every frame; tickFollow's old else-branch
// eased toward the bottom with LERP<1 and perpetually trailed the moving target
// (visible "jump up, ease down, jump up" oscillation). Fix: nextFollowTop hard-snaps
// to the exact bottom WHILE streaming, and keeps the LERP catch-up ONLY when not
// streaming (preserving goToBottom('smooth')). These exact-toBe assertions distinguish
// the two branches: each one reds under a specific production mutation.
// LERP is the module-private 0.18 follow-easing constant in useChatAutoFollow.ts
// (not exported); the literal 0.18 below mirrors that source constant.
// ──────────────────────────────────────────────────────────────────────────────
describe('nextFollowTop — HALF 2 (content-growth hard-snap)', () => {
    // Streaming MUST return the FULL bottom target = Math.max(0, scrollHeight - clientHeight).
    // Mutation check: flipping `if (isStreaming) return target` to the LERP branch turns
    // this expected 1200 into 500 + (1200-500)*0.18 = 626, reddening this assertion —
    // proving the test pins the streaming hard-snap, not just "some value".
    test('streaming hard-snaps to the exact bottom target', () => {
        expect(nextFollowTop({ scrollHeight: 2000, clientHeight: 800, scrollTop: 500, isStreaming: true })).toBe(1200);
    });

    // Non-streaming MUST preserve the eased LERP catch-up: scrollTop + (target-scrollTop)*0.18.
    // Mutation check: making the non-streaming branch hard-snap returns 1200 instead of 626,
    // reddening this assertion — guarding goToBottom('smooth') from regression.
    test('non-streaming preserves the LERP eased catch-up', () => {
        expect(nextFollowTop({ scrollHeight: 2000, clientHeight: 800, scrollTop: 500, isStreaming: false })).toBe(500 + (1200 - 500) * 0.18);
    });

    // The exact reported oscillation bug: with scrollTop far below a large target, streaming
    // returns the FULL target (9200), NOT a LERP fraction (0 + 9200*0.18 = 1656). A fractional
    // result here is the trailing-the-moving-target oscillation we are eliminating.
    test('streaming with scrollTop far from target returns the full target, not a fraction', () => {
        expect(nextFollowTop({ scrollHeight: 10000, clientHeight: 800, scrollTop: 0, isStreaming: true })).toBe(9200);
    });

    // Degenerate: content fits within the viewport -> Math.max(0, 500-800) clamps to 0.
    test('content shorter than viewport clamps the target to 0', () => {
        expect(nextFollowTop({ scrollHeight: 500, clientHeight: 800, scrollTop: 0, isStreaming: true })).toBe(0);
    });
});

// ─── Scroll-restore Step 3 — restore-target decision core ─────────────────────
// resolveRestoreTarget chooses which restore strategy restoreSnapshot uses,
// with no DOM dependency. Each assertion checks a SPECIFIC branch that would
// change if the corresponding production guard were removed.
// ──────────────────────────────────────────────────────────────────────────────
describe('resolveRestoreTarget', () => {
    test('D-J1: streaming-open always bottom-pins, even with a saved resolvable anchor', () => {
        expect(resolveRestoreTarget({
            streaming: true,
            hasSavedSnapshot: true,
            atBottom: false,
            hasMessageAnchor: true,
            hasValidScrollPosition: true,
        })).toBe('bottom');
    });

    test('no saved snapshot -> bottom (existing bottom-pin branch)', () => {
        expect(resolveRestoreTarget({
            streaming: false,
            hasSavedSnapshot: false,
            atBottom: false,
            hasMessageAnchor: false,
            hasValidScrollPosition: false,
        })).toBe('bottom');
    });

    test('saved-at-bottom -> bottom (existing bottom-pin branch)', () => {
        expect(resolveRestoreTarget({
            streaming: false,
            hasSavedSnapshot: true,
            atBottom: true,
            hasMessageAnchor: true,
            hasValidScrollPosition: true,
        })).toBe('bottom');
    });

    test('non-bottom with a real message anchor -> anchor', () => {
        expect(resolveRestoreTarget({
            streaming: false,
            hasSavedSnapshot: true,
            atBottom: false,
            hasMessageAnchor: true,
            hasValidScrollPosition: true,
        })).toBe('anchor');
    });

    test('non-bottom legacy snapshot (no message anchor) + valid scroll -> ratio fallback', () => {
        expect(resolveRestoreTarget({
            streaming: false,
            hasSavedSnapshot: true,
            atBottom: false,
            hasMessageAnchor: false,
            hasValidScrollPosition: true,
        })).toBe('ratio');
    });

    test('streaming wins over a legacy non-bottom snapshot too', () => {
        expect(resolveRestoreTarget({
            streaming: true,
            hasSavedSnapshot: true,
            atBottom: false,
            hasMessageAnchor: false,
            hasValidScrollPosition: true,
        })).toBe('bottom');
    });
});

// ─── Scroll-restore Step 4 — legacy-anchor healing (3-tier fallback) ───────────
// A legacy snapshot stores a stale numeric viewportAnchor and no messageAnchor.
// The deterministic tiers are real-anchor -> settled-ratio (valid scrollPosition)
// -> bottom. A legacy numeric anchor must NEVER position; an invalid/degenerate
// scrollPosition must heal to bottom, never collapse to top.
// ──────────────────────────────────────────────────────────────────────────────
describe('resolveRestoreTarget — legacy healing', () => {
    test('legacy snapshot (numeric anchor) + valid scrollPosition -> ratio (tier 2)', () => {
        expect(resolveRestoreTarget({
            streaming: false,
            hasSavedSnapshot: true,
            atBottom: false,
            hasMessageAnchor: false,
            hasValidScrollPosition: true,
        })).toBe('ratio');
    });

    test('legacy snapshot (numeric anchor) + invalid scrollPosition -> bottom (tier 3, no collapse-to-top)', () => {
        expect(resolveRestoreTarget({
            streaming: false,
            hasSavedSnapshot: true,
            atBottom: false,
            hasMessageAnchor: false,
            hasValidScrollPosition: false,
        })).toBe('bottom');
    });

    test('real anchor present wins over ratio (tier 1) even with valid scrollPosition', () => {
        expect(resolveRestoreTarget({
            streaming: false,
            hasSavedSnapshot: true,
            atBottom: false,
            hasMessageAnchor: true,
            hasValidScrollPosition: true,
        })).toBe('anchor');
    });
});

describe('isRealMessageAnchor', () => {
    test('true only for a real { messageId, offsetTop } object', () => {
        expect(isRealMessageAnchor({ messageId: 'm1', offsetTop: 42 })).toBe(true);
    });

    test('legacy numeric anchor is NOT a real anchor', () => {
        expect(isRealMessageAnchor(7)).toBe(false);
    });

    test('null and undefined are not real anchors', () => {
        expect(isRealMessageAnchor(null)).toBe(false);
        expect(isRealMessageAnchor(undefined)).toBe(false);
    });

    test('malformed objects are not real anchors', () => {
        expect(isRealMessageAnchor({ messageId: 'm1' })).toBe(false);
        expect(isRealMessageAnchor({ offsetTop: 42 })).toBe(false);
        expect(isRealMessageAnchor({ messageId: 1, offsetTop: 42 })).toBe(false);
        expect(isRealMessageAnchor({ messageId: 'm1', offsetTop: '42' })).toBe(false);
    });
});

// ─── Scroll-restore Step 5 — bounded content-growth re-correction lifecycle ───
// decideReCorrection drives the restore window: it re-corrects ONLY on content
// (scrollHeight) growth and STOPS permanently on handoff ('following'), user
// release, the first stable (non-growth) observation, or the correction cap. It
// has no DOM dependency, so each terminal/continue branch is asserted directly;
// the cap proves a continuous-growth stream is bounded, never infinite.
// ──────────────────────────────────────────────────────────────────────────────
describe('decideReCorrection', () => {
    const base = {
        prevContentHeight: 1000,
        currentContentHeight: 1000,
        state: 'released' as const,
        userReleased: false,
        correctionCount: 0,
    };

    test('content-height GROWTH -> re-correct', () => {
        expect(decideReCorrection({ ...base, currentContentHeight: 1200 })).toBe('re-correct');
    });

    test('stable height (no growth, current === prev) -> stop', () => {
        expect(decideReCorrection({ ...base, currentContentHeight: 1000 })).toBe('stop');
    });

    test('content SHRINK (current < prev) -> stop', () => {
        expect(decideReCorrection({ ...base, currentContentHeight: 800 })).toBe('stop');
    });

    test('user released -> stop (even with growth)', () => {
        expect(decideReCorrection({ ...base, currentContentHeight: 1200, userReleased: true })).toBe('stop');
    });

    test("follow handoff (state === 'following') -> stop (even with growth)", () => {
        expect(decideReCorrection({ ...base, currentContentHeight: 1200, state: 'following' })).toBe('stop');
    });

    test('clientHeight/viewport change with NO scrollHeight growth -> NOT re-correct (keyboard/resize)', () => {
        // The predicate only ever sees content (scrollHeight). A keyboard open that
        // shrinks clientHeight but leaves scrollHeight unchanged surfaces here as
        // currentContentHeight === prevContentHeight -> stop, never a re-correct.
        expect(decideReCorrection({ ...base, currentContentHeight: 1000 })).toBe('stop');
    });

    test('correction cap reached -> stop (even with growth)', () => {
        expect(decideReCorrection({
            ...base,
            currentContentHeight: 1200,
            correctionCount: MAX_RESTORE_RECORRECTIONS,
        })).toBe('stop');
    });

    test('continuous growth is BOUNDED: re-corrects up to the cap, then stops forever', () => {
        let count = 0;
        let height = 1000;
        let corrections = 0;
        // Simulate monotonic content growth with no handoff/release. Without the cap
        // this would loop forever; the cap guarantees termination.
        for (let i = 0; i < MAX_RESTORE_RECORRECTIONS + 50; i += 1) {
            const action = decideReCorrection({
                prevContentHeight: height,
                currentContentHeight: height + 100,
                state: 'released',
                userReleased: false,
                correctionCount: count,
            });
            if (action === 're-correct') {
                count += 1;
                corrections += 1;
                height += 100;
            } else {
                break;
            }
        }
        expect(corrections).toBe(MAX_RESTORE_RECORRECTIONS);
        // After the cap, it is terminal even if content keeps growing.
        expect(decideReCorrection({
            prevContentHeight: height,
            currentContentHeight: height + 100,
            state: 'released',
            userReleased: false,
            correctionCount: MAX_RESTORE_RECORRECTIONS,
        })).toBe('stop');
    });

    test('cap is a positive bound', () => {
        expect(MAX_RESTORE_RECORRECTIONS).toBeGreaterThan(0);
    });
});

// ─── Scroll-restore Step 7 — release signal that gates re-correction (D-J5) ───
// isReleasedSinceWindowOpen is the pure release-detection used by the restore
// observer: a manual user scroll stamps lastUserReleaseAt; if that stamp is
// strictly after the restore window opened, the user released DURING the window
// and the content-driven re-correction must stop. A stale/zero stamp (set by
// goToBottom and the bottom-pin restore handoff) means re-engaged, so correction
// continues. Each assertion goes red if the strict-after comparison is dropped,
// inverted, or weakened to >=.
describe('isReleasedSinceWindowOpen', () => {
    test('release stamped AFTER the window opened -> released (stops re-correction)', () => {
        expect(isReleasedSinceWindowOpen(500, 100)).toBe(true);
    });

    test('zero release stamp (goToBottom / bottom-pin handoff) -> NOT released (re-engaged)', () => {
        expect(isReleasedSinceWindowOpen(0, 100)).toBe(false);
    });

    test('release stamped BEFORE the window opened (prior window) -> NOT released', () => {
        expect(isReleasedSinceWindowOpen(50, 100)).toBe(false);
    });

    test('release stamp equal to window-open time -> NOT released (strict-after boundary)', () => {
        expect(isReleasedSinceWindowOpen(100, 100)).toBe(false);
    });
});

// ─── Scroll-restore Step 8 — renderable guard without deadlock (the far-up bug) ─
// decideRestoreGate decides whether the restore effect should skip (hash deeplink
// owns the scroll), wait (snapshot not renderable yet — must NOT mark the
// already-scrolled ref, so the effect re-runs once it becomes renderable), or
// restore (renderable — proceed and mark the ref AFTER). The far-up deadlock was
// caused by marking the ref before the renderable check; a 'wait' decision that
// leaves the ref unmarked is exactly what breaks that deadlock.
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

// ─── Scroll-restore Step 9 — heal a poisoned scrollPosition snapshot ──────────
// The old restore-time re-save could persist a top-collapsed scrollTop (0) with
// otherwise-valid dimensions; on the next open the ratio branch maps that to a 0
// target and the chat re-opens stuck at the top (self-reinforcing poison). Step 4
// only rejected degenerate dimensions (max <= 0); isHealthyScrollSnapshot also
// rejects a present-but-collapsed (scrollTop <= 0) snapshot so it heals to bottom
// via the resolver's tier-3 fallback instead of collapsing to the top.
describe('isHealthyScrollSnapshot', () => {
    test('healthy settled snapshot (positive extent + positive offset) -> true', () => {
        expect(isHealthyScrollSnapshot({ scrollTop: 500, scrollHeight: 3000, clientHeight: 1000 })).toBe(true);
    });

    test('poisoned top-collapse (scrollTop 0, valid dimensions) -> false (heals, not ratio->0)', () => {
        expect(isHealthyScrollSnapshot({ scrollTop: 0, scrollHeight: 3000, clientHeight: 1000 })).toBe(false);
    });

    test('degenerate dimensions (max scroll <= 0) -> false even with a positive offset', () => {
        expect(isHealthyScrollSnapshot({ scrollTop: 100, scrollHeight: 1000, clientHeight: 1000 })).toBe(false);
    });

    test('minimal healthy boundary (1px extent, 1px offset) -> true', () => {
        expect(isHealthyScrollSnapshot({ scrollTop: 1, scrollHeight: 1001, clientHeight: 1000 })).toBe(true);
    });
});

// ─── Scroll-restore Step 10 — isAtBottomSnapshot degenerate/unsettled max ─────
// A snapshot whose content has not grown past the viewport (scrollHeight <=
// clientHeight, so max scroll <= 0) is unsettled/degenerate. It MUST be treated
// as at-bottom (true) so the restore resolver bottom-pins instead of routing to
// a ratio target that would collapse the chat to the top. A naive
// "max <= 0 -> not at bottom" would re-introduce the collapse-to-top regression.
describe('isAtBottomSnapshot', () => {
    test('degenerate/unsettled max (scrollHeight <= clientHeight) -> at-bottom, NOT collapse-to-top', () => {
        expect(isAtBottomSnapshot({ scrollTop: 0, scrollHeight: 1000, clientHeight: 1000 }, false)).toBe(true);
    });

    test('settled snapshot parked at the bottom (scrollTop === max) -> at bottom', () => {
        expect(isAtBottomSnapshot({ scrollTop: 2000, scrollHeight: 3000, clientHeight: 1000 }, false)).toBe(true);
    });

    test('settled snapshot far above the bottom -> NOT at bottom (resolver may use ratio/anchor)', () => {
        expect(isAtBottomSnapshot({ scrollTop: 0, scrollHeight: 3000, clientHeight: 1000 }, false)).toBe(false);
    });
});

// ─── Deferred to .8.17 (Playwright real-layout E2E) ──────────────────────────
// (c) goToBottom re-pins: goToBottom() is a hook-internal closure that writes
//     scrollTop via writeScrollTopInstant and calls setStateValue('following').
//     It requires a live DOM container ref and React state — no pure seam exists.
//     Covered by Playwright task .8.17 AC4.
//
// (d) history-prepend anchor-restore: restoreViewportAnchor delegates to
//     messageListRef.current?.restoreViewportAnchor() — requires a live
//     virtualizer ref. No pure seam exists.
//     Covered by Playwright task .8.17 AC5.
// ─────────────────────────────────────────────────────────────────────────────
