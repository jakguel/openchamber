import { beforeEach, describe, expect, test } from 'bun:test';

import {
    isAutoSendEligible,
    useMessageQueueStore,
    type QueuedMessage,
} from './messageQueueStore';

const makeMessage = (overrides: Partial<QueuedMessage> = {}): QueuedMessage => ({
    id: overrides.id ?? `id-${Math.random().toString(36).slice(2)}`,
    content: overrides.content ?? 'hello',
    createdAt: overrides.createdAt ?? 1000,
    ...overrides,
});

const seedQueue = (sessionId: string, messages: QueuedMessage[]): void => {
    useMessageQueueStore.setState((state) => ({
        queuedMessages: {
            ...state.queuedMessages,
            [sessionId]: messages,
        },
    }));
};

beforeEach(() => {
    useMessageQueueStore.setState({ queuedMessages: {} });
});

describe('claimFront', () => {
    test('returns and removes queue[0] when non-empty', () => {
        const front = makeMessage({ id: 'first', content: 'A' });
        const second = makeMessage({ id: 'second', content: 'B' });
        seedQueue('s1', [front, second]);

        const claimed = useMessageQueueStore.getState().claimFront('s1');

        expect(claimed).toBe(front);
        expect(useMessageQueueStore.getState().queuedMessages['s1']).toEqual([second]);
    });

    test('deletes the session key when the queue becomes empty', () => {
        const only = makeMessage({ id: 'only' });
        seedQueue('s1', [only]);

        const claimed = useMessageQueueStore.getState().claimFront('s1');

        expect(claimed).toBe(only);
        expect('s1' in useMessageQueueStore.getState().queuedMessages).toBe(false);
    });

    test('returns the EXACT front object reference, not a copy', () => {
        const front = makeMessage({ id: 'first', attempts: 2 });
        seedQueue('s1', [front, makeMessage({ id: 'second' })]);

        const claimed = useMessageQueueStore.getState().claimFront('s1');

        expect(claimed).toBe(front);
        expect(claimed?.attempts).toBe(2);
    });

    test('with matching expectedId removes and returns front', () => {
        const front = makeMessage({ id: 'first' });
        const second = makeMessage({ id: 'second' });
        seedQueue('s1', [front, second]);

        const claimed = useMessageQueueStore.getState().claimFront('s1', 'first');

        expect(claimed).toBe(front);
        expect(useMessageQueueStore.getState().queuedMessages['s1']).toEqual([second]);
    });

    test('with mismatched expectedId returns null and does NOT mutate', () => {
        const front = makeMessage({ id: 'first' });
        const second = makeMessage({ id: 'second' });
        const before = [front, second];
        seedQueue('s1', before);

        const claimed = useMessageQueueStore.getState().claimFront('s1', 'second');

        expect(claimed).toBeNull();
        expect(useMessageQueueStore.getState().queuedMessages['s1']).toBe(before);
    });

    test('on empty queue returns null and does NOT create a session key', () => {
        const claimed = useMessageQueueStore.getState().claimFront('missing');

        expect(claimed).toBeNull();
        expect('missing' in useMessageQueueStore.getState().queuedMessages).toBe(false);
    });

    test('preserves referential equality for untouched sessions', () => {
        const otherQueue = [makeMessage({ id: 'other' })];
        seedQueue('s1', [makeMessage({ id: 'first' })]);
        seedQueue('s2', otherQueue);

        useMessageQueueStore.getState().claimFront('s1');

        expect(useMessageQueueStore.getState().queuedMessages['s2']).toBe(otherQueue);
    });
});

describe('requeueToFront', () => {
    test('unshifts the EXACT message to index 0 preserving rest order', () => {
        const existing1 = makeMessage({ id: 'e1' });
        const existing2 = makeMessage({ id: 'e2' });
        seedQueue('s1', [existing1, existing2]);
        const rolled = makeMessage({ id: 'rolled', attempts: 1 });

        useMessageQueueStore.getState().requeueToFront('s1', rolled);

        const queue = useMessageQueueStore.getState().queuedMessages['s1'];
        expect(queue[0]).toBe(rolled);
        expect(queue.map((m) => m.id)).toEqual(['rolled', 'e1', 'e2']);
    });

    test('creates the session queue with [message] when the key does not exist', () => {
        const rolled = makeMessage({ id: 'rolled' });

        useMessageQueueStore.getState().requeueToFront('fresh', rolled);

        const queue = useMessageQueueStore.getState().queuedMessages['fresh'];
        expect(queue).toEqual([rolled]);
        expect(queue[0]).toBe(rolled);
    });
});

describe('isAutoSendEligible', () => {
    test('returns false when failedTerminally is true', () => {
        const message = makeMessage({ failedTerminally: true });
        expect(isAutoSendEligible(message, 5000)).toBe(false);
    });

    test('returns false when now < nextEligibleAt', () => {
        const message = makeMessage({ nextEligibleAt: 5000 });
        expect(isAutoSendEligible(message, 4999)).toBe(false);
    });

    test('returns true when now >= nextEligibleAt', () => {
        const message = makeMessage({ nextEligibleAt: 5000 });
        expect(isAutoSendEligible(message, 5000)).toBe(true);
    });

    test('returns true when retry fields are absent', () => {
        const message = makeMessage();
        expect(isAutoSendEligible(message, 5000)).toBe(true);
    });

    test('failedTerminally takes precedence over a satisfied backoff window', () => {
        const message = makeMessage({ failedTerminally: true, nextEligibleAt: 1000 });
        expect(isAutoSendEligible(message, 5000)).toBe(false);
    });
});
