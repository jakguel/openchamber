import { create } from 'zustand';
import { devtools, persist, createJSONStorage } from 'zustand/middleware';
import { getSafeStorage } from './utils/safeStorage';
import type { AttachedFile } from './types/sessionTypes';
import { updateDesktopSettings } from '@/lib/persistence';

export interface QueuedMessage {
    id: string;
    content: string;
    attachments?: AttachedFile[];
    createdAt: number;
    /** Send config captured at queue time — used as-is when auto-sending */
    sendConfig?: {
        providerID: string;
        modelID: string;
        agent?: string;
        variant?: string;
    };
    /** Number of failed auto-send attempts (retry metadata, persisted) */
    attempts?: number;
    /** Timestamp (ms) of the most recent failed auto-send attempt */
    lastFailedAt?: number;
    /** When true, auto-send has permanently given up on this message */
    failedTerminally?: boolean;
    /** Earliest timestamp (ms) at which this message becomes auto-send eligible again */
    nextEligibleAt?: number;
}

interface MessageQueueState {
    queuedMessages: Record<string, QueuedMessage[]>; // sessionId → queue
    queueModeEnabled: boolean; // global toggle
}

interface MessageQueueActions {
    addToQueue: (sessionId: string, message: Omit<QueuedMessage, 'id' | 'createdAt'>) => void;
    removeFromQueue: (sessionId: string, messageId: string) => void;
    claimFront: (sessionId: string, expectedId?: string) => QueuedMessage | null;
    requeueToFront: (sessionId: string, message: QueuedMessage) => void;
    popToInput: (sessionId: string, messageId: string) => QueuedMessage | null;
    clearQueue: (sessionId: string) => void;
    clearAllQueues: () => void;
    setQueueMode: (enabled: boolean) => void;
    getQueueForSession: (sessionId: string) => QueuedMessage[];
}

type MessageQueueStore = MessageQueueState & MessageQueueActions;

export const isAutoSendEligible = (message: QueuedMessage, now: number): boolean => {
    if (message.failedTerminally === true) {
        return false;
    }
    if (message.nextEligibleAt !== undefined && now < message.nextEligibleAt) {
        return false;
    }
    return true;
};

export const useMessageQueueStore = create<MessageQueueStore>()(
    devtools(
        persist(
            (set, get) => ({
                queuedMessages: {},
                queueModeEnabled: true,

                addToQueue: (sessionId, message) => {
                    const id = `queued-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
                    const queuedMessage: QueuedMessage = {
                        id,
                        content: message.content,
                        attachments: message.attachments,
                        createdAt: Date.now(),
                        sendConfig: message.sendConfig,
                    };

                    set((state) => {
                        const currentQueue = state.queuedMessages[sessionId] ?? [];
                        return {
                            queuedMessages: {
                                ...state.queuedMessages,
                                [sessionId]: [...currentQueue, queuedMessage],
                            },
                        };
                    });
                },

                removeFromQueue: (sessionId, messageId) => {
                    set((state) => {
                        const currentQueue = state.queuedMessages[sessionId] ?? [];
                        const newQueue = currentQueue.filter((m) => m.id !== messageId);
                        
                        if (newQueue.length === 0) {
                            const { [sessionId]: _removed, ...rest } = state.queuedMessages;
                            void _removed;
                            return { queuedMessages: rest };
                        }
                        
                        return {
                            queuedMessages: {
                                ...state.queuedMessages,
                                [sessionId]: newQueue,
                            },
                        };
                    });
                },

                claimFront: (sessionId, expectedId) => {
                    const currentQueue = get().queuedMessages[sessionId] ?? [];
                    const front = currentQueue[0];

                    if (!front) {
                        return null;
                    }
                    if (expectedId !== undefined && front.id !== expectedId) {
                        return null;
                    }

                    set((state) => {
                        const queue = state.queuedMessages[sessionId] ?? [];
                        const newQueue = queue.slice(1);

                        if (newQueue.length === 0) {
                            const { [sessionId]: _removed, ...rest } = state.queuedMessages;
                            void _removed;
                            return { queuedMessages: rest };
                        }

                        return {
                            queuedMessages: {
                                ...state.queuedMessages,
                                [sessionId]: newQueue,
                            },
                        };
                    });

                    return front;
                },

                requeueToFront: (sessionId, message) => {
                    set((state) => {
                        const currentQueue = state.queuedMessages[sessionId] ?? [];
                        return {
                            queuedMessages: {
                                ...state.queuedMessages,
                                [sessionId]: [message, ...currentQueue],
                            },
                        };
                    });
                },

                popToInput: (sessionId, messageId) => {
                    const state = get();
                    const currentQueue = state.queuedMessages[sessionId] ?? [];
                    const message = currentQueue.find((m) => m.id === messageId);
                    
                    if (!message) {
                        return null;
                    }

                    // Remove from queue
                    set((prevState) => {
                        const queue = prevState.queuedMessages[sessionId] ?? [];
                        const newQueue = queue.filter((m) => m.id !== messageId);
                        
                        if (newQueue.length === 0) {
                            const { [sessionId]: _removed, ...rest } = prevState.queuedMessages;
                            void _removed;
                            return { queuedMessages: rest };
                        }
                        
                        return {
                            queuedMessages: {
                                ...prevState.queuedMessages,
                                [sessionId]: newQueue,
                            },
                        };
                    });

                    return message;
                },

                clearQueue: (sessionId) => {
                    set((state) => {
                        const { [sessionId]: _removed, ...rest } = state.queuedMessages;
                        void _removed;
                        return { queuedMessages: rest };
                    });
                },

                clearAllQueues: () => {
                    set({ queuedMessages: {} });
                },

                setQueueMode: (enabled) => {
                    set({ queueModeEnabled: enabled });
                    // Persist to settings.json (async, fire-and-forget)
                    void updateDesktopSettings({ queueModeEnabled: enabled });
                },

                getQueueForSession: (sessionId) => {
                    return get().queuedMessages[sessionId] ?? [];
                },
            }),
            {
                name: 'message-queue-store',
                storage: createJSONStorage(() => getSafeStorage()),
                partialize: (state) => ({
                    queuedMessages: state.queuedMessages,
                    queueModeEnabled: state.queueModeEnabled,
                }),
            }
        ),
        {
            name: 'message-queue-store',
        }
    )
);
