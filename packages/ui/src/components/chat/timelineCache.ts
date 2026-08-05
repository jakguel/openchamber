import type { CacheSnapshot, VirtualizerHandle } from 'virtua';

import type { RenderEntry } from './MessageList';

export const TIMELINE_CACHE_LIMIT = 16;

export const estimateHistoryEntryHeight = (entry: RenderEntry | undefined): number => {
    if (!entry) {
        return 160;
    }

    if (entry.kind === 'turn') {
        return 180 + Math.min(entry.turn.assistantMessages.length, 4) * 100;
    }

    return 140;
};

const sameKeys = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    return a.every((key, index) => key === b[index]);
};

export const timelineCache = new Map<string, { keys: readonly string[]; cache: CacheSnapshot }>();

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
