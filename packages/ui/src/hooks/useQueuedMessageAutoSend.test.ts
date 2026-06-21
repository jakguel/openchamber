import { beforeEach, describe, expect, test } from 'bun:test';
import type { Agent } from '@opencode-ai/sdk/v2';

import {
    isAutoSendEligible,
    useMessageQueueStore,
    type QueuedMessage,
} from '../stores/messageQueueStore';
import { useConfigStore } from '../stores/useConfigStore';
import {
    buildQueuedAutoSendPayload,
    dispatchQueuedCore,
    shouldDispatchQueuedAutoSend,
    QUEUED_AUTO_SEND_BUDGET,
    QUEUED_AUTO_SEND_BACKOFF_MS,
    type DispatchQueuedResult,
} from './useQueuedMessageAutoSend';

// ─── Regression context ─────────────────────────────────────────────────────
// Original bug: dispatchSessionQueue removed queue[0] only AFTER `await send`,
// and a rejected send flipped status busy->idle (an edge), so the persisted
// queue[0] was re-sent on every later idle edge => infinite resend. The fix
// claims the front BEFORE the send (dispatchQueuedCore) and, on rejection,
// requeues with attempts+1 + nextEligibleAt backoff (and failedTerminally at
// BUDGET) so isAutoSendEligible turns the item off. These tests drive the REAL
// useMessageQueueStore + the pure dispatchQueuedCore, injecting ONLY the send
// boundary + a clock — no internal-module mocks, no DOM.
// ─────────────────────────────────────────────────────────────────────────────

const SESSION = 'session-1';

const makeMessage = (overrides: Partial<QueuedMessage> = {}): QueuedMessage => ({
    id: overrides.id ?? 'm1',
    content: overrides.content ?? 'hello',
    createdAt: overrides.createdAt ?? 1,
    ...overrides,
});

interface SendStub {
    fn: (claimed: QueuedMessage) => Promise<void>;
    calls: QueuedMessage[];
}

const resolvingSend = (): SendStub => {
    const calls: QueuedMessage[] = [];
    return {
        calls,
        fn: (claimed) => {
            calls.push(claimed);
            return Promise.resolve();
        },
    };
};

const rejectingSend = (): SendStub => {
    const calls: QueuedMessage[] = [];
    return {
        calls,
        fn: (claimed) => {
            calls.push(claimed);
            return Promise.reject(new Error('send failed'));
        },
    };
};

const runCore = (
    front: QueuedMessage,
    send: SendStub,
    now: () => number,
): Promise<DispatchQueuedResult> => {
    const store = useMessageQueueStore.getState();
    return dispatchQueuedCore({
        sessionId: SESSION,
        front,
        isEligible: isAutoSendEligible,
        claimFront: store.claimFront,
        requeueToFront: store.requeueToFront,
        send: send.fn,
        now,
        budget: QUEUED_AUTO_SEND_BUDGET,
        backoffMs: QUEUED_AUTO_SEND_BACKOFF_MS,
    });
};

beforeEach(() => {
    useMessageQueueStore.setState({ queuedMessages: {} });
});

describe('dispatchQueuedCore — success path (a)', () => {
    test('claims and removes the front, sends exactly once, queue empty, returns sent', async () => {
        const m1 = makeMessage({ id: 'm1', content: 'first' });
        useMessageQueueStore.setState({ queuedMessages: { [SESSION]: [m1] } });
        const send = resolvingSend();

        const result = await runCore(m1, send, () => 1000);

        expect(result).toBe('sent');
        expect(send.calls.length).toBe(1);
        expect(send.calls[0]?.id).toBe('m1');
        expect(useMessageQueueStore.getState().getQueueForSession(SESSION)).toEqual([]);
    });
});

describe('dispatchQueuedCore — reject requeues to front, no re-send (b)', () => {
    test('reject requeues SAME id to front with attempts incremented', async () => {
        const m1 = makeMessage({ id: 'm1' });
        useMessageQueueStore.setState({ queuedMessages: { [SESSION]: [m1] } });
        const send = rejectingSend();

        const result = await runCore(m1, send, () => 1000);

        expect(result).toBe('requeued');
        expect(send.calls.length).toBe(1);
        const queue = useMessageQueueStore.getState().getQueueForSession(SESSION);
        expect(queue.length).toBe(1);
        expect(queue[0]?.id).toBe('m1');
        expect(queue[0]?.attempts).toBe(1);
        expect(queue[0]?.lastFailedAt).toBe(1000);
        expect(queue[0]?.nextEligibleAt).toBe(1000 + QUEUED_AUTO_SEND_BACKOFF_MS);
        expect(queue[0]?.failedTerminally).toBe(false);
    });

    test('a second dispatch within the backoff window is NOT re-sent (send count stays 1)', async () => {
        // This is the core regression for the original infinite-resend bug:
        // after a failed send the item is back at the front, but the next idle
        // attempt must find it ineligible (backoff) and NOT re-send it.
        const m1 = makeMessage({ id: 'm1' });
        useMessageQueueStore.setState({ queuedMessages: { [SESSION]: [m1] } });
        const send = rejectingSend();

        await runCore(m1, send, () => 1000);
        const requeued = useMessageQueueStore.getState().getQueueForSession(SESSION)[0]!;

        // Second attempt 100ms later — still inside the 5000ms backoff window.
        const second = await runCore(requeued, send, () => 1100);

        expect(second).toBe('not-eligible');
        expect(send.calls.length).toBe(1);
        const queue = useMessageQueueStore.getState().getQueueForSession(SESSION);
        expect(queue.length).toBe(1);
        expect(queue[0]?.attempts).toBe(1);
    });

    test('after the backoff window elapses the item is eligible and is re-sent', async () => {
        const m1 = makeMessage({ id: 'm1' });
        useMessageQueueStore.setState({ queuedMessages: { [SESSION]: [m1] } });

        await runCore(m1, rejectingSend(), () => 1000);
        const requeued = useMessageQueueStore.getState().getQueueForSession(SESSION)[0]!;

        const retrySend = resolvingSend();
        const after = await runCore(requeued, retrySend, () => 1000 + QUEUED_AUTO_SEND_BACKOFF_MS);

        expect(after).toBe('sent');
        expect(retrySend.calls.length).toBe(1);
        expect(useMessageQueueStore.getState().getQueueForSession(SESSION)).toEqual([]);
    });
});

describe('dispatchQueuedCore — terminal after BUDGET (c)', () => {
    test('after BUDGET failures the item is failedTerminally and never eligible again', async () => {
        const m1 = makeMessage({ id: 'm1' });
        useMessageQueueStore.setState({ queuedMessages: { [SESSION]: [m1] } });

        let clock = 1000;
        const advance = () => clock;

        // Fail BUDGET times, advancing the clock past each backoff window.
        for (let attempt = 1; attempt <= QUEUED_AUTO_SEND_BUDGET; attempt += 1) {
            const front = useMessageQueueStore.getState().getQueueForSession(SESSION)[0]!;
            const result = await runCore(front, rejectingSend(), advance);
            expect(result).toBe('requeued');
            clock += QUEUED_AUTO_SEND_BACKOFF_MS + 1;
        }

        const terminal = useMessageQueueStore.getState().getQueueForSession(SESSION)[0]!;
        expect(terminal.attempts).toBe(QUEUED_AUTO_SEND_BUDGET);
        expect(terminal.failedTerminally).toBe(true);
        // Eligibility is false forever, even far beyond any backoff window.
        expect(isAutoSendEligible(terminal, clock + 1_000_000)).toBe(false);

        // A further dispatch attempt is rejected by the eligibility gate — no send.
        const send = resolvingSend();
        const result = await runCore(terminal, send, () => clock + 1_000_000);
        expect(result).toBe('not-eligible');
        expect(send.calls.length).toBe(0);
    });
});

describe('dispatchQueuedCore — order preserved on reject (d)', () => {
    test('[m1, m2] with m1 reject keeps m1 at index 0 and m2 at index 1', async () => {
        const m1 = makeMessage({ id: 'm1', content: 'first' });
        const m2 = makeMessage({ id: 'm2', content: 'second', createdAt: 2 });
        useMessageQueueStore.setState({ queuedMessages: { [SESSION]: [m1, m2] } });

        const result = await runCore(m1, rejectingSend(), () => 1000);

        expect(result).toBe('requeued');
        const queue = useMessageQueueStore.getState().getQueueForSession(SESSION);
        expect(queue.map((m) => m.id)).toEqual(['m1', 'm2']);
        expect(queue[0]?.attempts).toBe(1);
        expect(queue[1]?.attempts).toBe(undefined);
    });
});

describe('enqueue-while-idle gate (e)', () => {
    test('an eligible front dispatches (sent); the unified gate uses isAutoSendEligible', async () => {
        const fresh = makeMessage({ id: 'm1' });
        useMessageQueueStore.setState({ queuedMessages: { [SESSION]: [fresh] } });

        expect(isAutoSendEligible(fresh, 1000)).toBe(true);
        const result = await runCore(fresh, resolvingSend(), () => 1000);
        expect(result).toBe('sent');
    });

    test('a failedTerminally front does NOT dispatch (not-eligible, no send)', async () => {
        const terminal = makeMessage({ id: 'm1', failedTerminally: true });
        useMessageQueueStore.setState({ queuedMessages: { [SESSION]: [terminal] } });
        const send = resolvingSend();

        expect(isAutoSendEligible(terminal, 1000)).toBe(false);
        const result = await runCore(terminal, send, () => 1000);

        expect(result).toBe('not-eligible');
        expect(send.calls.length).toBe(0);
        expect(useMessageQueueStore.getState().getQueueForSession(SESSION)[0]?.id).toBe('m1');
    });

    test('a within-backoff front does NOT dispatch (not-eligible, no send)', async () => {
        const backedOff = makeMessage({ id: 'm1', nextEligibleAt: 6000 });
        useMessageQueueStore.setState({ queuedMessages: { [SESSION]: [backedOff] } });
        const send = resolvingSend();

        expect(isAutoSendEligible(backedOff, 5999)).toBe(false);
        const result = await runCore(backedOff, send, () => 5999);

        expect(result).toBe('not-eligible');
        expect(send.calls.length).toBe(0);
    });

    test('the busy/retry->idle edge predicate is unchanged and distinct from idle dispatch', () => {
        // The trigger fires on (edge OR idle) AND eligible front; the edge
        // predicate itself is the existing contract and must be preserved.
        expect(shouldDispatchQueuedAutoSend('busy', 'idle')).toBe(true);
        expect(shouldDispatchQueuedAutoSend('retry', 'idle')).toBe(true);
        expect(shouldDispatchQueuedAutoSend('idle', 'idle')).toBe(false);
        expect(shouldDispatchQueuedAutoSend(undefined, 'idle')).toBe(false);
    });
});

describe('claimFront TOCTOU (g)', () => {
    test('when the live front changed, claimFront(expectedId) returns null and no send happens', async () => {
        // The effect captured `stale` as the front, but by dispatch time the
        // live front is a different message. claimFront(sessionId, stale.id)
        // must refuse to claim, so dispatchQueuedCore returns not-claimed.
        const live = makeMessage({ id: 'm2', content: 'newer front' });
        useMessageQueueStore.setState({ queuedMessages: { [SESSION]: [live] } });
        const stale = makeMessage({ id: 'm1', content: 'captured earlier' });
        const send = resolvingSend();

        const result = await runCore(stale, send, () => 1000);

        expect(result).toBe('not-claimed');
        expect(send.calls.length).toBe(0);
        expect(useMessageQueueStore.getState().getQueueForSession(SESSION)).toEqual([live]);
    });
});

describe('buildQueuedAutoSendPayload (real config store, no internal mocks)', () => {
    beforeEach(() => {
        useConfigStore.setState({ agents: [] });
    });

    test('returns the first queued message for auto-send', () => {
        const queue: QueuedMessage[] = [
            { id: 'queued-1', content: 'first queued message', createdAt: 1 },
            { id: 'queued-2', content: 'second queued message', createdAt: 2 },
        ];

        const payload = buildQueuedAutoSendPayload(queue);

        expect(payload).not.toBeNull();
        expect(payload?.queuedMessageId).toBe('queued-1');
        expect(payload?.primaryText).toBe('first queued message');
        expect(payload?.primaryAttachments).toEqual([]);
    });

    test('parses an agent mention against the REAL visible-agents config', () => {
        useConfigStore.setState({
            agents: [
                {
                    name: 'Builder',
                    mode: 'subagent',
                    permission: [],
                    options: {},
                } as Agent,
            ],
        });

        const payload = buildQueuedAutoSendPayload([
            { id: 'queued-mention', content: '@Builder please take this', createdAt: 1 },
        ]);

        expect(payload).not.toBeNull();
        expect(payload?.agentMentionName).toBe('Builder');
        expect(payload?.primaryText).toBe('@Builder please take this');
    });

    test('does not resolve a mention when the agent is not in the visible config', () => {
        const payload = buildQueuedAutoSendPayload([
            { id: 'queued-mention', content: '@Builder please take this', createdAt: 1 },
        ]);

        expect(payload).not.toBeNull();
        expect(payload?.agentMentionName).toBe(undefined);
    });

    test('preserves attachment-only queued messages as sendable payloads', () => {
        const payload = buildQueuedAutoSendPayload([
            {
                id: 'queued-attachments',
                content: '',
                createdAt: 1,
                attachments: [
                    {
                        id: 'file-1',
                        filename: 'notes.txt',
                        mimeType: 'text/plain',
                        size: 5,
                        source: 'local',
                        file: new File(['hello'], 'notes.txt', { type: 'text/plain' }),
                        dataUrl: 'data:text/plain;base64,aGVsbG8=',
                    },
                ],
            },
        ]);

        expect(payload).not.toBeNull();
        expect(payload?.queuedMessageId).toBe('queued-attachments');
        expect(payload?.primaryText).toBe('');
        expect(payload?.primaryAttachments).toHaveLength(1);
        expect(payload?.primaryAttachments[0]?.filename).toBe('notes.txt');
    });
});
