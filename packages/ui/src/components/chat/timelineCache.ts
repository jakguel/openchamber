import type { CacheSnapshot, VirtualizerHandle } from 'virtua';

import type { RenderEntry } from './MessageList';

export type { CacheSnapshot } from 'virtua';

export type TimelineCacheEntry = { keys: readonly string[]; cache: CacheSnapshot };

export const TIMELINE_CACHE_LIMIT = 16;

export const estimateHistoryEntryHeight = (entry: RenderEntry | undefined): number => {
    if (!entry) {
        // Safe fallback used by the cold-path default.
        return 160;
    }

    if (entry.kind === 'turn') {
        // Base height for the user bubble + assistant response overhead,
        // plus a per-message estimate (uncapped — deriveColdItemSize clamps).
        return 200 + entry.turn.assistantMessages.length * 150;
    }

    // 'ungrouped': a single message without a full turn wrapper.
    return 120;
};;

/** Minimum and maximum allowed cold itemSize scalar. */
const COLD_ITEM_MIN = 100;
const COLD_ITEM_MAX = 600;

/**
 * Aggregate per-entry height estimates into a single scalar for the Virtualizer
 * `itemSize` cold branch. Uses the median to resist outlier turns (very long
 * multi-assistant exchanges) from skewing the estimate.
 *
 * Returns `160` (the undefined-entry fallback) when the array is empty so
 * callers never receive `NaN` or `0`.
 */
export function deriveColdItemSize(entries: readonly RenderEntry[]): number {
    if (entries.length === 0) return 160;

    const sorted = entries.map(estimateHistoryEntryHeight).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
        sorted.length % 2 === 1
            ? sorted[mid]
            : (sorted[mid - 1] + sorted[mid]) / 2;

    return Math.max(COLD_ITEM_MIN, Math.min(COLD_ITEM_MAX, median));
}

const sameKeys = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    return a.every((key, index) => key === b[index]);
};

export const timelineCache = new Map<string, TimelineCacheEntry>();

export const readTimelineCache = (sessionKey: string, keys: readonly string[]): CacheSnapshot | undefined => {
    const entry = timelineCache.get(sessionKey);
    if (!entry) return undefined;
    if (sameKeys(entry.keys, keys)) return entry.cache;
    timelineCache.delete(sessionKey);
    return undefined;
};

export const writeTimelineCache = (
    sessionKey: string,
    keys: readonly string[],
    handle: VirtualizerHandle | null | undefined,
): void => {
    if (!handle || keys.length === 0) return;
    timelineCache.delete(sessionKey);
    timelineCache.set(sessionKey, { keys: keys.slice(), cache: handle.cache });
    while (timelineCache.size > TIMELINE_CACHE_LIMIT) {
        const oldest = timelineCache.keys().next().value;
        if (typeof oldest !== 'string') break;
        timelineCache.delete(oldest);
    }
};
