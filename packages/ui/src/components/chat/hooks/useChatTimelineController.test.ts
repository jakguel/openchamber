import { describe, expect, test } from 'bun:test';

import {
    shouldAutoLoadEarlierForUnderfilledPinnedViewport,
    shouldFireAutoLoadEarlierWithPersistence,
    UNDERFILL_PERSIST_THRESHOLD,
} from './useChatTimelineController';

// ─── Regression context ────────────────────────────────────────────────────────
// Bug: pending-subagent ToolPart height churn transiently underfills the viewport.
// HALF 2 fix: shouldFireAutoLoadEarlierWithPersistence requires threshold=2
// consecutive underfill observations before auto-load-earlier fires.
// A single-frame transient collapse (count=1) is suppressed.
// A genuinely short/underfilled session stays underfilled and fires on count=2.
// These tests FAIL if the threshold guard is removed (bug reintroduced).
// ──────────────────────────────────────────────────────────────────────────────

const baseInput = {
    sessionId: 'ses_1',
    isPinned: true,
    canLoadEarlier: true,
    isLoadingOlder: false,
    pendingRevealWork: false,
    scrollHeight: 799,
    clientHeight: 800,
};

describe('shouldAutoLoadEarlierForUnderfilledPinnedViewport', () => {
    test('loads when pinned content does not fill the viewport', () => {
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport(baseInput)).toBe(true);
    });

    test('does not load when content already overflows', () => {
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
            ...baseInput,
            scrollHeight: 802,
        })).toBe(false);
    });

    test('does not load while user is away from bottom or history work is active', () => {
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
            ...baseInput,
            isPinned: false,
        })).toBe(false);
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
            ...baseInput,
            isLoadingOlder: true,
        })).toBe(false);
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
            ...baseInput,
            pendingRevealWork: true,
        })).toBe(false);
    });
});

describe('shouldFireAutoLoadEarlierWithPersistence', () => {
    // AC2: transient single-frame underfill (count=1) must NOT fire.
    test('returns false for a single-frame transient underfill (count below threshold)', () => {
        expect(shouldFireAutoLoadEarlierWithPersistence({
            underfilledNow: true,
            consecutiveUnderfillCount: 1,
            threshold: UNDERFILL_PERSIST_THRESHOLD,
        })).toBe(false);
    });

    // AC3: persistent underfill across the settle threshold MUST fire.
    test('returns true when underfill persists across the settle threshold', () => {
        expect(shouldFireAutoLoadEarlierWithPersistence({
            underfilledNow: true,
            consecutiveUnderfillCount: UNDERFILL_PERSIST_THRESHOLD,
            threshold: UNDERFILL_PERSIST_THRESHOLD,
        })).toBe(true);
    });

    test('returns true for counts exceeding the threshold (genuinely short session)', () => {
        expect(shouldFireAutoLoadEarlierWithPersistence({
            underfilledNow: true,
            consecutiveUnderfillCount: UNDERFILL_PERSIST_THRESHOLD + 5,
            threshold: UNDERFILL_PERSIST_THRESHOLD,
        })).toBe(true);
    });

    // AC4 (fill resets counter): when underfilledNow is false the predicate returns false
    // regardless of the accumulated count — the caller resets the counter on false, so the
    // next underfill observation starts from 1 again.
    test('returns false when not currently underfilled, even with a high accumulated count', () => {
        expect(shouldFireAutoLoadEarlierWithPersistence({
            underfilledNow: false,
            consecutiveUnderfillCount: 99,
            threshold: UNDERFILL_PERSIST_THRESHOLD,
        })).toBe(false);
    });

    // AC4 (same-frame coalescing): repeated calls with the same count in the same rAF tick
    // produce the same deterministic result — no side effects inside the pure predicate.
    test('is idempotent — repeated calls with the same inputs return the same result', () => {
        const args = { underfilledNow: true, consecutiveUnderfillCount: UNDERFILL_PERSIST_THRESHOLD, threshold: UNDERFILL_PERSIST_THRESHOLD };
        expect(shouldFireAutoLoadEarlierWithPersistence(args)).toBe(true);
        expect(shouldFireAutoLoadEarlierWithPersistence(args)).toBe(true);
    });

    // Verify the threshold constant itself is the expected value (2) so tests are not vacuous.
    test('UNDERFILL_PERSIST_THRESHOLD is 2 — single-frame collapse is exactly 1 below it', () => {
        expect(UNDERFILL_PERSIST_THRESHOLD).toBe(2);
    });

    // Regression: if production logic is reverted (threshold removed, always fires on underfilledNow),
    // the transient-single-frame test above would pass with count=1 -> this test would still fail.
    test('count=0 with underfilledNow=true does not fire (counter not yet incremented)', () => {
        expect(shouldFireAutoLoadEarlierWithPersistence({
            underfilledNow: true,
            consecutiveUnderfillCount: 0,
            threshold: UNDERFILL_PERSIST_THRESHOLD,
        })).toBe(false);
    });
});

// ─── Scroll oscillation regression — HALF 2 ───────────────────────────────────
// These tests directly encode the HALF 2 oscillation bug fix.
// Each assertion would produce the WRONG result if the persistence guard were removed.
// ──────────────────────────────────────────────────────────────────────────────
describe('scroll oscillation regression — HALF 2 (persistence guard for auto-load-earlier)', () => {
    // (e) Transient single-frame collapse: pending-subagent height churn produces
    // exactly ONE underfill observation before the placeholder re-expands.
    // The persistence guard MUST suppress auto-load-earlier for count=1.
    // Regression: if threshold is removed (always fires on underfilledNow=true),
    // this returns true and history prepend + anchor-restore drives scrollTop to 0.
    test('(e) transient single-frame underfill (count=1) does NOT fire auto-load-earlier', () => {
        expect(shouldFireAutoLoadEarlierWithPersistence({
            underfilledNow: true,
            consecutiveUnderfillCount: 1,
            threshold: UNDERFILL_PERSIST_THRESHOLD,
        })).toBe(false);
    });

    // (e) Genuinely short session: content is truly underfilled across multiple
    // ResizeObserver callbacks. count reaches threshold -> MUST fire.
    // Regression: if threshold is raised too high, this returns false and short
    // sessions never auto-load-earlier (breaks legitimate use case).
    test('(e) persistent underfill (count >= threshold) fires auto-load-earlier', () => {
        expect(shouldFireAutoLoadEarlierWithPersistence({
            underfilledNow: true,
            consecutiveUnderfillCount: UNDERFILL_PERSIST_THRESHOLD,
            threshold: UNDERFILL_PERSIST_THRESHOLD,
        })).toBe(true);
    });

    // (e) Boundary: count exactly at threshold-1 (one below) must NOT fire.
    test('(e) count one below threshold does not fire (boundary)', () => {
        expect(shouldFireAutoLoadEarlierWithPersistence({
            underfilledNow: true,
            consecutiveUnderfillCount: UNDERFILL_PERSIST_THRESHOLD - 1,
            threshold: UNDERFILL_PERSIST_THRESHOLD,
        })).toBe(false);
    });

    // (e) Multiple concurrent pending subagents: same-frame coalescing.
    // The predicate is pure — repeated calls with the same count are idempotent.
    // Two ResizeObserver callbacks firing in the same frame both see count=1 -> both false.
    test('(e) same-frame coalescing: two calls with count=1 both return false', () => {
        const args = { underfilledNow: true, consecutiveUnderfillCount: 1, threshold: UNDERFILL_PERSIST_THRESHOLD };
        expect(shouldFireAutoLoadEarlierWithPersistence(args)).toBe(false);
        expect(shouldFireAutoLoadEarlierWithPersistence(args)).toBe(false);
    });

    // Point-in-time predicate: underfill detection boundary (scrollHeight <= clientHeight + 1).
    // At exactly clientHeight+1 -> underfilled (fires if count >= threshold).
    test('(e) scrollHeight exactly at clientHeight+1 is underfilled', () => {
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
            ...baseInput,
            scrollHeight: 801,  // clientHeight=800, 801 <= 801 -> true
            clientHeight: 800,
        })).toBe(true);
    });

    // At clientHeight+2 -> NOT underfilled (content fills viewport).
    test('(e) scrollHeight at clientHeight+2 is NOT underfilled', () => {
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
            ...baseInput,
            scrollHeight: 802,  // 802 > 801 -> false
            clientHeight: 800,
        })).toBe(false);
    });

    // Guard: canLoadEarlier=false prevents auto-load even when underfilled.
    // This ensures the guard does not fire when there is no history to load.
    test('(e) canLoadEarlier=false suppresses auto-load even when underfilled', () => {
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
            ...baseInput,
            canLoadEarlier: false,
            scrollHeight: 799,
            clientHeight: 800,
        })).toBe(false);
    });

    // Guard: sessionId=null suppresses auto-load (no active session).
    test('(e) null sessionId suppresses auto-load', () => {
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
            ...baseInput,
            sessionId: null,
            scrollHeight: 799,
            clientHeight: 800,
        })).toBe(false);
    });

    // Verify threshold constant is 2 — if someone changes it, tests become vacuous.
    test('UNDERFILL_PERSIST_THRESHOLD is exactly 2 (single-frame collapse = 1 = below threshold)', () => {
        expect(UNDERFILL_PERSIST_THRESHOLD).toBe(2);
    });
});

// ─── Deferred to .8.17 (Playwright real-layout E2E) ──────────────────────────
// (d) history-prepend anchor-restore: captureViewportAnchor / restoreViewportAnchor
//     delegate to messageListRef.current — requires a live virtualizer ref.
//     No pure seam exists for the DOM-write side.
//     Covered by Playwright task .8.17 AC5.
// ─────────────────────────────────────────────────────────────────────────────
