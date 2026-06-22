import { describe, expect, test } from 'bun:test';

import { resolveRestoreTarget, shouldReleaseAutoFollowOnScroll } from './useChatAutoFollow';

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
        })).toBe(false);
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
        })).toBe('bottom');
    });

    test('no saved snapshot -> bottom (existing bottom-pin branch)', () => {
        expect(resolveRestoreTarget({
            streaming: false,
            hasSavedSnapshot: false,
            atBottom: false,
            hasMessageAnchor: false,
        })).toBe('bottom');
    });

    test('saved-at-bottom -> bottom (existing bottom-pin branch)', () => {
        expect(resolveRestoreTarget({
            streaming: false,
            hasSavedSnapshot: true,
            atBottom: true,
            hasMessageAnchor: true,
        })).toBe('bottom');
    });

    test('non-bottom with a real message anchor -> anchor', () => {
        expect(resolveRestoreTarget({
            streaming: false,
            hasSavedSnapshot: true,
            atBottom: false,
            hasMessageAnchor: true,
        })).toBe('anchor');
    });

    test('non-bottom legacy snapshot (no message anchor) -> ratio fallback', () => {
        expect(resolveRestoreTarget({
            streaming: false,
            hasSavedSnapshot: true,
            atBottom: false,
            hasMessageAnchor: false,
        })).toBe('ratio');
    });

    test('streaming wins over a legacy non-bottom snapshot too', () => {
        expect(resolveRestoreTarget({
            streaming: true,
            hasSavedSnapshot: true,
            atBottom: false,
            hasMessageAnchor: false,
        })).toBe('bottom');
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
