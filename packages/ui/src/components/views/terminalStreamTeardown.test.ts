import { describe, expect, test } from 'bun:test';

import { shouldTeardownStreamOnCleanup } from './terminalStreamTeardown';

describe('shouldTeardownStreamOnCleanup', () => {
    test('tears down when no stream context exists (unmount / never-subscribed)', () => {
        expect(shouldTeardownStreamOnCleanup(null, '/proj-a', 'tab-1', null)).toBe(true);
        expect(shouldTeardownStreamOnCleanup(null, '/proj-a', 'tab-1', 'sess-x')).toBe(true);
    });

    test('keeps the live stream on a same-context re-run (sessionId churn within same dir+tab)', () => {
        const ctx = { directory: '/proj-a', tabId: 'tab-1', terminalId: 'sess-x' };
        expect(shouldTeardownStreamOnCleanup(ctx, '/proj-a', 'tab-1', 'sess-x')).toBe(false);
    });

    test('tears down on a genuine directory switch', () => {
        const ctx = { directory: '/proj-a', tabId: 'tab-1', terminalId: 'sess-x' };
        expect(shouldTeardownStreamOnCleanup(ctx, '/proj-b', 'tab-1', 'sess-x')).toBe(true);
    });

    test('tears down on a genuine tab switch within the same directory', () => {
        const ctx = { directory: '/proj-a', tabId: 'tab-1', terminalId: 'sess-x' };
        expect(shouldTeardownStreamOnCleanup(ctx, '/proj-a', 'tab-2', 'sess-x')).toBe(true);
    });

    test('tears down when the active terminal no longer matches the stream context', () => {
        const ctx = { directory: '/proj-a', tabId: 'tab-1', terminalId: 'sess-x' };
        expect(shouldTeardownStreamOnCleanup(ctx, '/proj-a', 'tab-1', 'sess-y')).toBe(true);
        expect(shouldTeardownStreamOnCleanup(ctx, '/proj-a', 'tab-1', null)).toBe(true);
    });

    test('switching back and forth between two projects always re-evaluates teardown correctly', () => {
        const ctxA = { directory: '/proj-a', tabId: 'tab-1', terminalId: 'sess-a' };
        expect(shouldTeardownStreamOnCleanup(ctxA, '/proj-a', 'tab-1', 'sess-a')).toBe(false);
        expect(shouldTeardownStreamOnCleanup(ctxA, '/proj-b', 'tab-1', 'sess-a')).toBe(true);

        const ctxB = { directory: '/proj-b', tabId: 'tab-1', terminalId: 'sess-b' };
        expect(shouldTeardownStreamOnCleanup(ctxB, '/proj-b', 'tab-1', 'sess-b')).toBe(false);
        expect(shouldTeardownStreamOnCleanup(ctxB, '/proj-a', 'tab-1', 'sess-b')).toBe(true);
    });
});
