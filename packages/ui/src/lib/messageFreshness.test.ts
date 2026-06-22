import { beforeEach, describe, expect, test } from 'bun:test';
import type { AssistantMessage, Message } from '@opencode-ai/sdk/v2';

import { MessageFreshnessDetector } from './messageFreshness';

// ─── Regression context ─────────────────────────────────────────────────────
// Bug: switching BACK to a session re-animated its history like a fresh stream.
// Two root causes fixed in messageFreshness.ts:
//   - recordSessionStart is now SET-ONCE (a switch-back no longer resets the
//     fresh window). Reverting it to an unconditional set fails the set-once test.
//   - completed messages are recorded in seenMessageIds (markMessageAsAnimated),
//     so shouldAnimateMessage returns false for them on return. Removing that
//     marking fails the no-replay test.
//   - seenMessageIds is bounded (MAX_SEEN_MESSAGE_IDS=5000) with lockstep
//     oldest-first eviction. Removing the cap fails the retention test.
// These drive the REAL singleton detector — no mocks, no DOM.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_SEEN_MESSAGE_IDS = 5000;

const makeAssistantMessage = (
    overrides: { id: string; sessionID: string; created: number },
): Message => {
    const message: AssistantMessage = {
        id: overrides.id,
        sessionID: overrides.sessionID,
        role: 'assistant',
        time: { created: overrides.created },
        parentID: 'parent-1',
        modelID: 'model-1',
        providerID: 'provider-1',
        mode: 'build',
        agent: 'subagent',
        path: { cwd: '/tmp', root: '/tmp' },
        cost: 0,
        tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
        },
    };
    return message;
};

const detector = MessageFreshnessDetector.getInstance();

beforeEach(() => {
    detector.clearAll();
});

describe('MessageFreshnessDetector — no-replay on switch-back (a)', () => {
    test('a once-animated message stays NOT-animated after marking + a new recordSessionStart', () => {
        const sessionID = 'session-a';
        detector.recordSessionStart(sessionID);
        const start = detector.getSessionStartTime(sessionID)!;

        // Fresh message (created after the session start) animates on first reveal.
        const message = makeAssistantMessage({ id: 'msg-1', sessionID, created: start + 10 });
        expect(detector.shouldAnimateMessage(message, sessionID)).toBe(true);

        // Step 3 post-commit marking records it as seen.
        detector.markMessageAsAnimated(message.id, message.time.created);

        // Simulate switching back: ChatMessage/useChatAutoFollow call recordSessionStart again.
        detector.recordSessionStart(sessionID);

        // It must NOT re-animate — the seen guard blocks replay.
        expect(detector.shouldAnimateMessage(message, sessionID)).toBe(false);
    });
});

describe('MessageFreshnessDetector — set-once recordSessionStart (b)', () => {
    test('a second recordSessionStart does NOT change the recorded start time', () => {
        const sessionID = 'session-b';
        detector.recordSessionStart(sessionID);
        const first = detector.getSessionStartTime(sessionID);
        expect(typeof first).toBe('number');

        detector.recordSessionStart(sessionID);
        const second = detector.getSessionStartTime(sessionID);

        expect(second).toBe(first);
    });

    test('hasSessionTiming is true after the first call', () => {
        const sessionID = 'session-b2';
        expect(detector.hasSessionTiming(sessionID)).toBe(false);
        detector.recordSessionStart(sessionID);
        expect(detector.hasSessionTiming(sessionID)).toBe(true);
    });
});

describe('MessageFreshnessDetector — first reveal still animates (c)', () => {
    test('a never-seen assistant message inside the fresh window returns true', () => {
        const sessionID = 'session-c';
        detector.recordSessionStart(sessionID);
        const start = detector.getSessionStartTime(sessionID)!;

        // Inside the 5000ms window: created > start - 5000. Use start - 1000.
        const fresh = makeAssistantMessage({ id: 'fresh-1', sessionID, created: start - 1000 });
        expect(detector.shouldAnimateMessage(fresh, sessionID)).toBe(true);
    });

    test('a message older than the fresh window does NOT animate', () => {
        const sessionID = 'session-c2';
        detector.recordSessionStart(sessionID);
        const start = detector.getSessionStartTime(sessionID)!;

        // Outside the window: created <= start - 5000. Use start - 5001.
        const stale = makeAssistantMessage({ id: 'stale-1', sessionID, created: start - 5001 });
        expect(detector.shouldAnimateMessage(stale, sessionID)).toBe(false);
    });
});

describe('MessageFreshnessDetector — bounded retention (d)', () => {
    test('the seen cache evicts the oldest beyond MAX and retains the newest, in lockstep', () => {
        const sessionID = 'session-d';
        detector.recordSessionStart(sessionID);

        // Mark MAX + 1 distinct ids as seen, oldest first.
        const total = MAX_SEEN_MESSAGE_IDS + 1;
        for (let i = 0; i < total; i += 1) {
            detector.markMessageAsAnimated(`seen-${i}`, 1000 + i);
        }

        // The oldest id (seen-0) was evicted: it is no longer 'seen', so a fresh
        // assistant message with that id animates again. createdTime stays in
        // lockstep — there is no orphaned messageCreationTimes entry to assert,
        // but the behavioral signal is the eviction itself.
        const oldest = makeAssistantMessage({ id: 'seen-0', sessionID, created: Date.now() });
        expect(detector.hasBeenAnimated('seen-0')).toBe(false);
        expect(detector.shouldAnimateMessage(oldest, sessionID)).toBe(true);

        // The newest id (seen-5000) is retained — still 'seen'.
        expect(detector.hasBeenAnimated(`seen-${total - 1}`)).toBe(true);

        // The cache size is bounded at MAX (debug surface, public method).
        const debug = detector.getDebugInfo();
        expect(debug.seenMessageIds.size).toBe(MAX_SEEN_MESSAGE_IDS);
        // messageCreationTimes trimmed in lockstep — no orphan entries.
        expect(debug.messageCreationTimes.size).toBe(MAX_SEEN_MESSAGE_IDS);
    });
});
