import React from 'react';
import { useMessageQueueStore, isAutoSendEligible, type QueuedMessage } from '@/stores/messageQueueStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { useContextStore } from '@/stores/contextStore';
import { parseAgentMentions } from '@/lib/messages/agentMentions';
import { getSyncSessionStatus } from '@/sync/sync-refs';
import { useDirectorySync } from '@/sync/sync-context';

type SessionStatusType = 'idle' | 'busy' | 'retry';

const RECENT_ABORT_WINDOW_MS = 2000;

const hasRecentAbort = (sessionId: string): boolean => {
  const abortRecord = useSessionUIStore.getState().sessionAbortFlags.get(sessionId);
  if (!abortRecord) {
    return false;
  }
  return Date.now() - abortRecord.timestamp < RECENT_ABORT_WINDOW_MS;
};

export const buildQueuedAutoSendPayload = (queue: QueuedMessage[]) => {
  const queued = queue[0];
  if (!queued) {
    return null;
  }

  const agents = useConfigStore.getState().getVisibleAgents();
  const { sanitizedText, mention } = parseAgentMentions(queued.content, agents);

  return {
    queuedMessageId: queued.id,
    primaryText: sanitizedText,
    primaryAttachments: queued.attachments ?? [],
    agentMentionName: mention?.name,
    sendConfig: queued.sendConfig,
  };
};

type QueuedAutoSendPayload = NonNullable<ReturnType<typeof buildQueuedAutoSendPayload>>;
type ResolvedQueuedSendConfig = {
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
};

export const sendQueuedAutoSendPayload = (
  sessionId: string,
  payload: QueuedAutoSendPayload,
  resolved: ResolvedQueuedSendConfig,
) => {
  return useSessionUIStore.getState().sendMessage(
    payload.primaryText,
    resolved.providerID,
    resolved.modelID,
    resolved.agent,
    payload.primaryAttachments,
    payload.agentMentionName,
    undefined,
    resolved.variant,
    'normal',
    { sessionId },
  );
};

const resolveSessionSendConfig = (sessionId: string) => {
  const context = useContextStore.getState();
  const config = useConfigStore.getState();
  const selection = useSelectionStore.getState();

  const selectedAgent =
    context.getSessionAgentSelection(sessionId)
    ?? context.getCurrentAgent(sessionId)
    ?? config.currentAgentName
    ?? undefined;

  const sessionModel = context.getSessionModelSelection(sessionId);
  const agentModel = selectedAgent
    ? context.getAgentModelForSession(sessionId, selectedAgent)
    : null;

  const providerID =
    agentModel?.providerId
    ?? sessionModel?.providerId
    ?? config.currentProviderId
    ?? selection.lastUsedProvider?.providerID;
  const modelID =
    agentModel?.modelId
    ?? sessionModel?.modelId
    ?? config.currentModelId
    ?? selection.lastUsedProvider?.modelID;

  const variant =
    selectedAgent && providerID && modelID
      ? (selection.getAgentModelVariantForSession(sessionId, selectedAgent, providerID, modelID)
        ?? context.getAgentModelVariantForSession(sessionId, selectedAgent, providerID, modelID))
      : undefined;

  return {
    providerID,
    modelID,
    agent: selectedAgent,
    variant,
  };
};

export const shouldDispatchQueuedAutoSend = (
  previousStatusType: SessionStatusType | undefined,
  currentStatusType: SessionStatusType,
): boolean => {
  return (previousStatusType === 'busy' || previousStatusType === 'retry')
    && currentStatusType === 'idle';
};

export const QUEUED_AUTO_SEND_BUDGET = 3;

export type DispatchQueuedResult = 'sent' | 'not-eligible' | 'not-claimed' | 'requeued';

export interface DispatchQueuedCoreDeps {
  sessionId: string;
  front: QueuedMessage;
  isEligible: (message: QueuedMessage, now: number) => boolean;
  claimFront: (sessionId: string, expectedId: string) => QueuedMessage | null;
  requeueToFront: (sessionId: string, message: QueuedMessage) => void;
  send: (claimed: QueuedMessage) => Promise<void>;
  now: () => number;
  budget: number;
}

// Invariant: the front is claimed (removed) before the network call. A
// rejected send flips status busy->idle (an edge that would otherwise
// re-dispatch the same item); with the item already claimed, that edge finds a
// different or ineligible front and cannot loop. On rejection the exact item is
// requeued with attempts+1, and at budget marked failedTerminally so
// isAutoSendEligible excludes it. A rejected send never reached the server
// (optimisticSend rolls back + rethrows), making re-enqueue duplicate-safe.
export async function dispatchQueuedCore(deps: DispatchQueuedCoreDeps): Promise<DispatchQueuedResult> {
  const { sessionId, front, isEligible, claimFront, requeueToFront, send, now, budget } = deps;

  if (!isEligible(front, now())) {
    return 'not-eligible';
  }

  const claimed = claimFront(sessionId, front.id);
  if (!claimed) {
    return 'not-claimed';
  }

  try {
    await send(claimed);
    return 'sent';
  } catch {
    const attempts = (claimed.attempts ?? 0) + 1;
    requeueToFront(sessionId, {
      ...claimed,
      attempts,
      lastFailedAt: now(),
      failedTerminally: attempts >= budget,
    });
    return 'requeued';
  }
}

export function useQueuedMessageAutoSend(enabledOrOptions?: boolean | { enabled?: boolean }) {
  const enabled = typeof enabledOrOptions === 'boolean' ? enabledOrOptions : (enabledOrOptions?.enabled ?? true);
  const queuedMessages = useMessageQueueStore((state) => state.queuedMessages);
  const sessionStatusRecord = useDirectorySync((state) => state.session_status);

  const inFlightSessionsRef = React.useRef<Set<string>>(new Set());
  const previousStatusRef = React.useRef<Map<string, SessionStatusType>>(new Map());

  React.useEffect(() => {
    if (!enabled) {
      return;
    }

    const dispatchSessionQueue = async (sessionId: string, queueSnapshot: QueuedMessage[]) => {
      if (queueSnapshot.length === 0) {
        return;
      }
      if (inFlightSessionsRef.current.has(sessionId)) {
        return;
      }
      if (hasRecentAbort(sessionId)) {
        return;
      }

      const currentStatus = getSyncSessionStatus(sessionId)?.type ?? 'idle';
      if (currentStatus !== 'idle') {
        return;
      }

      const front = useMessageQueueStore.getState().getQueueForSession(sessionId)[0];
      if (!front) {
        return;
      }

      const payload = buildQueuedAutoSendPayload([front]);
      if (!payload) {
        return;
      }
      if (!payload.primaryText && payload.primaryAttachments.length === 0) {
        return;
      }

      const captured = payload.sendConfig;
      const resolved = captured?.providerID && captured?.modelID
        ? captured
        : resolveSessionSendConfig(sessionId);
      if (!resolved.providerID || !resolved.modelID) {
        return;
      }

      inFlightSessionsRef.current.add(sessionId);

      try {
        const store = useMessageQueueStore.getState();
        await dispatchQueuedCore({
          sessionId,
          front,
          isEligible: isAutoSendEligible,
          claimFront: store.claimFront,
          requeueToFront: store.requeueToFront,
          send: (claimed) => {
            const claimedPayload = buildQueuedAutoSendPayload([claimed]);
            if (!claimedPayload) {
              return Promise.reject(new Error('[queue] claimed message produced no payload'));
            }
            const claimedCaptured = claimedPayload.sendConfig;
            const claimedResolved = claimedCaptured?.providerID && claimedCaptured?.modelID
              ? claimedCaptured
              : resolveSessionSendConfig(sessionId);
            if (!claimedResolved.providerID || !claimedResolved.modelID) {
              return Promise.reject(new Error('[queue] claimed message has no resolved send config'));
            }
            return sendQueuedAutoSendPayload(sessionId, claimedPayload, {
              providerID: claimedResolved.providerID,
              modelID: claimedResolved.modelID,
              agent: claimedResolved.agent,
              variant: claimedResolved.variant,
            });
          },
          now: Date.now,
          budget: QUEUED_AUTO_SEND_BUDGET,
        });
      } catch (error) {
        console.warn('[queue] queued auto-send failed:', error);
      } finally {
        inFlightSessionsRef.current.delete(sessionId);
      }
    };

    const statusRecord = sessionStatusRecord ?? {};
    const nextStatusMap = new Map(previousStatusRef.current);
    for (const [sessionId, status] of Object.entries(statusRecord)) {
      if (status) {
        nextStatusMap.set(sessionId, status.type as SessionStatusType);
      }
    }

    const queueEntries = Object.entries(queuedMessages);
    queueEntries.forEach(([sessionId, queue]) => {
      const currentStatusType = (statusRecord[sessionId]?.type ?? 'idle') as SessionStatusType;
      const previousStatusType = previousStatusRef.current.get(sessionId);

      if (queue.length > 0 && shouldDispatchQueuedAutoSend(previousStatusType, currentStatusType)) {
        void dispatchSessionQueue(sessionId, queue);
      }

      nextStatusMap.set(sessionId, currentStatusType);
    });

    previousStatusRef.current = nextStatusMap;
  }, [enabled, queuedMessages, sessionStatusRecord]);
}
