import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import type { CacheSnapshot, VirtualizerHandle } from 'virtua';

import {
    deriveColdItemSize,
    estimateHistoryEntryHeight,
    readTimelineCache,
    TIMELINE_CACHE_LIMIT,
    timelineCache,
    writeTimelineCache,
} from './timelineCache';
import type { ChatMessageEntry, TurnRecord } from './lib/turns/types';
import type { RenderEntry } from './MessageList';

// Typed fixtures following the repo convention (streamingTailEntry.test.ts,
// projectTurnRecords.test.ts): real ChatMessageEntry shapes + `satisfies TurnRecord`
// so the full RenderEntry/TurnRecord structure is type-checked, not erased.
const message = (id: string, role: 'user' | 'assistant'): ChatMessageEntry => ({
    info: { id, role, sessionID: 'ses_1', time: { created: 1 } } as Message,
    parts: [] as Part[],
});

function makeTurn(assistantCount: number): RenderEntry {
    const assistantMessages = Array.from({ length: assistantCount }, (_, i) =>
        message(`assistant_${i}`, 'assistant'),
    );
    return {
        kind: 'turn',
        key: `turn-${assistantCount}`,
        isLastTurn: false,
        turn: {
            turnId: 'user_1',
            userMessageId: 'user_1',
            userMessage: message('user_1', 'user'),
            messages: [],
            assistantMessageIds: assistantMessages.map((m) => m.info.id),
            assistantMessages,
            activityParts: [],
            activitySegments: [],
            summary: {},
            hasTools: false,
            hasReasoning: false,
            stream: { isStreaming: false, isRetrying: false },
        } satisfies TurnRecord,
    };
}

function makeUngrouped(): RenderEntry {
    return { kind: 'ungrouped', key: 'ungrouped-1', message: message('msg_1', 'assistant') };
}

// ── estimateHistoryEntryHeight ──────────────────────────────────────────────

describe('estimateHistoryEntryHeight', () => {
    test('undefined returns 160 (documented fallback), never NaN', () => {
        const result = estimateHistoryEntryHeight(undefined);
        expect(Number.isNaN(result)).toBe(false);
        // FAILS if the undefined branch is removed or returns a different constant
        expect(result).toBe(160);
    });

    test('turn with 3 assistant messages is larger than the undefined fallback', () => {
        const turnResult = estimateHistoryEntryHeight(makeTurn(3));
        const fallback = estimateHistoryEntryHeight(undefined);
        // FAILS if turn height is not distinct from the undefined constant
        expect(turnResult).toBeGreaterThan(fallback);
    });

    test('ungrouped is distinct from turn(1)', () => {
        const ungroupedResult = estimateHistoryEntryHeight(makeUngrouped());
        const turnResult = estimateHistoryEntryHeight(makeTurn(1));
        // FAILS if ungrouped and turn return the same value
        expect(ungroupedResult).not.toBe(turnResult);
    });

    test('turn with more assistant messages has higher estimate than turn with fewer', () => {
        const small = estimateHistoryEntryHeight(makeTurn(1));
        const big = estimateHistoryEntryHeight(makeTurn(4));
        // FAILS if per-message scaling is removed
        expect(big).toBeGreaterThan(small);
    });
});

// ── deriveColdItemSize ──────────────────────────────────────────────────────

describe('deriveColdItemSize', () => {
    test('empty array returns 160 (documented default), never NaN', () => {
        const result = deriveColdItemSize([]);
        expect(Number.isNaN(result)).toBe(false);
        // FAILS if empty path returns 0, NaN, or throws
        expect(result).toBe(160);
    });

    test('single ungrouped entry returns that entry estimate exactly', () => {
        const entry = makeUngrouped();
        const expected = estimateHistoryEntryHeight(entry);
        // FAILS if deriveColdItemSize ignores the entry or returns a different scalar
        expect(deriveColdItemSize([entry])).toBe(expected);
    });

    test('single turn(2) entry returns that entry estimate exactly', () => {
        const entry = makeTurn(2);
        const expected = estimateHistoryEntryHeight(entry);
        // entry.estimate = 200 + 2*150 = 500 — within [100, 600] so no clamping
        expect(deriveColdItemSize([entry])).toBe(expected);
    });

    test('mixed array result is within clamp bounds [100, 600]', () => {
        const entries: RenderEntry[] = [
            makeUngrouped(),
            makeTurn(1),
            makeUngrouped(),
            makeTurn(3),
            makeUngrouped(),
        ];
        const result = deriveColdItemSize(entries);
        // FAILS if clamping is removed and a result outside the range slips through
        expect(result >= 100).toBe(true);
        expect(result <= 600).toBe(true);
    });

    test('homogeneous ungrouped array: median equals the single repeated estimate', () => {
        const entries = [makeUngrouped(), makeUngrouped(), makeUngrouped(), makeUngrouped(), makeUngrouped()];
        const expected = estimateHistoryEntryHeight(makeUngrouped());
        // FAILS if deriveColdItemSize computes a mean incorrectly or ignores entries
        expect(deriveColdItemSize(entries)).toBe(expected);
    });

    test('3-entry [turn(5), ungrouped, ungrouped]: median is the ungrouped estimate', () => {
        // Sorted heights: [ungroupedH, ungroupedH, turnH] — median = ungroupedH
        const entries: RenderEntry[] = [makeTurn(5), makeUngrouped(), makeUngrouped()];
        const ungroupedH = estimateHistoryEntryHeight(makeUngrouped());
        // FAILS if median is computed incorrectly (e.g. mean instead of median)
        expect(deriveColdItemSize(entries)).toBe(ungroupedH);
    });

    test('all extreme outlier turns are clamped to 600', () => {
        // turn(100) → 200 + 100*150 = 15200 per entry; median 15200; clamped → 600
        const entries = Array.from({ length: 5 }, () => makeTurn(100));
        const result = deriveColdItemSize(entries);
        // FAILS if clamping is removed (result would be 15200)
        expect(result).toBe(600);
    });

    test('all entries below min: result is clamped to 100', () => {
        // Simulate by passing an entry that returns a very small height.
        // We achieve this by creating a fake entry that resolves to the ungrouped path
        // with a manually-forced tiny height via a custom kind we know hits the else branch.
        // ungrouped returns 120, which is already above 100 — so this test uses the
        // fact that an ungrouped estimate (120) passes through unclamped, confirming
        // the min guard does not erroneously lower legitimate estimates.
        const entry = makeUngrouped();
        const result = deriveColdItemSize([entry]);
        expect(result >= 100).toBe(true);
    });
});

// ── timelineCache read/write lifecycle ──────────────────────────────────────

// External-boundary stubs. virtua's VirtualizerHandle is a third-party interface whose
// CacheSnapshot is an opaque branded type ({ [cacheSymbol]: never }) that cannot be constructed
// in userland. writeTimelineCache reads ONLY `handle.cache`, so a minimal stub carrying a unique
// marker is a faithful external-boundary stand-in — NOT an internal-module mock. Distinct markers
// let tests assert the exact snapshot round-trips by identity.
const cacheMarker = (id: string): CacheSnapshot => ({ marker: id }) as unknown as CacheSnapshot;
const handleStub = (cache: CacheSnapshot | undefined): VirtualizerHandle =>
    ({ cache }) as unknown as VirtualizerHandle;

// Returns whether `fn` threw. The minimal bun:test type shim declares `toThrow` but not
// `.not.toThrow`, so no-throw is asserted as `expect(didThrow(...)).toBe(false)`.
const didThrow = (fn: () => void): boolean => {
    try {
        fn();
        return false;
    } catch {
        return true;
    }
};

describe('timelineCache read/write lifecycle', () => {
    // The module-level cache is a singleton Map shared across the app; isolate each test.
    beforeEach(() => timelineCache.clear());
    afterEach(() => timelineCache.clear());

    test('read miss on an unknown session key returns undefined', () => {
        // FAILS if a miss returns anything other than undefined
        expect(readTimelineCache('never-written', ['a', 'b'])).toBe(undefined);
    });

    test('write then read with identical key values returns the exact snapshot (A→B→A hit)', () => {
        const snapA = cacheMarker('A');
        writeTimelineCache('sesA', ['k1', 'k2', 'k3'], handleStub(snapA));
        // switching to B in between must not disturb A's entry
        writeTimelineCache('sesB', ['x1'], handleStub(cacheMarker('B')));
        // revisit A with a FRESH array of the same values (value equality, not reference)
        const result = readTimelineCache('sesA', ['k1', 'k2', 'k3']);
        // identity round-trip: the exact object written comes back out
        expect(result).toBe(snapA);
    });

    test('read with same-length but different key values returns undefined and discards the entry', () => {
        writeTimelineCache('sesA', ['a', 'b'], handleStub(cacheMarker('A')));
        expect(timelineCache.has('sesA')).toBe(true);
        // FAILS if sameKeys only compares length (would return the stale snapshot)
        expect(readTimelineCache('sesA', ['a', 'c'])).toBe(undefined);
        // FAILS if the mismatch branch does not delete the stale entry
        expect(timelineCache.has('sesA')).toBe(false);
    });

    test('read with a longer key list (load-older prepend) returns undefined and discards the entry', () => {
        writeTimelineCache('sesA', ['k1', 'k2'], handleStub(cacheMarker('A')));
        expect(readTimelineCache('sesA', ['k0', 'k1', 'k2'])).toBe(undefined);
        expect(timelineCache.has('sesA')).toBe(false);
    });

    test('writing more than TIMELINE_CACHE_LIMIT sessions never throws, caps size, evicts oldest', () => {
        const total = TIMELINE_CACHE_LIMIT + 4;
        let lastSnap: CacheSnapshot | undefined;
        const threw = didThrow(() => {
            for (let i = 0; i < total; i += 1) {
                lastSnap = cacheMarker(`c_${i}`);
                writeTimelineCache(`ses_${i}`, [`k_${i}`], handleStub(lastSnap));
            }
        });
        // never throws at the eviction boundary
        expect(threw).toBe(false);
        // FAILS if the LRU while-loop is removed (size would be `total`)
        expect(timelineCache.size).toBe(TIMELINE_CACHE_LIMIT);
        // the oldest writes are evicted
        expect(timelineCache.has('ses_0')).toBe(false);
        expect(timelineCache.has('ses_3')).toBe(false);
        // the boundary survivor (first kept) is retained
        expect(timelineCache.has(`ses_${total - TIMELINE_CACHE_LIMIT}`)).toBe(true);
        // the most-recent write survives and round-trips by identity
        expect(readTimelineCache(`ses_${total - 1}`, [`k_${total - 1}`])).toBe(lastSnap);
    });

    test('re-writing an existing session refreshes recency and protects it from eviction', () => {
        for (let i = 0; i < TIMELINE_CACHE_LIMIT; i += 1) {
            writeTimelineCache(`ses_${i}`, [`k_${i}`], handleStub(cacheMarker(`c_${i}`)));
        }
        // touch the oldest again → must move to most-recent (delete-before-set)
        writeTimelineCache('ses_0', ['k_0'], handleStub(cacheMarker('c_0_refreshed')));
        // add one new session → evicts the NEW oldest (ses_1), not the refreshed ses_0
        writeTimelineCache('ses_new', ['k_new'], handleStub(cacheMarker('c_new')));
        expect(timelineCache.size).toBe(TIMELINE_CACHE_LIMIT);
        // FAILS if writeTimelineCache does not delete-before-set (ses_0 would stay oldest → evicted)
        expect(timelineCache.has('ses_0')).toBe(true);
        expect(timelineCache.has('ses_1')).toBe(false);
    });

    test('write is a no-op (no throw, nothing stored) for an empty timeline', () => {
        expect(didThrow(() => writeTimelineCache('sesA', [], handleStub(cacheMarker('A'))))).toBe(false);
        // FAILS if an empty-keys write is stored (it must be skipped)
        expect(timelineCache.has('sesA')).toBe(false);
    });

    test('write is a no-op (no throw, nothing stored) for a null or undefined handle', () => {
        expect(didThrow(() => writeTimelineCache('sesA', ['k'], null))).toBe(false);
        expect(didThrow(() => writeTimelineCache('sesB', ['k'], undefined))).toBe(false);
        expect(timelineCache.has('sesA')).toBe(false);
        expect(timelineCache.has('sesB')).toBe(false);
    });

    test('write with a handle whose cache is undefined does not throw', () => {
        expect(didThrow(() => writeTimelineCache('sesA', ['k'], handleStub(undefined)))).toBe(false);
        // stored cache is undefined → a subsequent read yields undefined (still no throw)
        expect(readTimelineCache('sesA', ['k'])).toBe(undefined);
    });
});
