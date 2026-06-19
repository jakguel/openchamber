import { describe, expect, test } from 'bun:test';

import {
    shouldAutoLoadEarlierForUnderfilledPinnedViewport,
    shouldFireAutoLoadEarlierWithPersistence,
    UNDERFILL_PERSIST_THRESHOLD,
} from './useChatTimelineController';

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
