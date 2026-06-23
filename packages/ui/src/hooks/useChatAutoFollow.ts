import React from 'react';

import { MessageFreshnessDetector } from '@/lib/messageFreshness';
import { createScrollSpy } from '@/components/chat/lib/scroll/scrollSpy';
import { getViewportSessionMemory, useViewportStore, type MessageAnchor, type SessionMemoryState } from '@/sync/viewport-store';

export type AutoFollowState = 'following' | 'released';

export type ContentChangeReason = 'text' | 'structural' | 'permission';

export interface AnimationHandlers {
    onChunk: () => void;
    onComplete: () => void;
    onStreamingCandidate?: () => void;
    onAnimationStart?: () => void;
    onReservationCancelled?: () => void;
    onReasoningBlock?: () => void;
    onAnimatedHeightChange?: (height: number) => void;
}

interface UseChatAutoFollowOptions {
    currentSessionId: string | null;
    sessionMessageCount: number;
    sessionIsWorking: boolean;
    isMobile: boolean;
    onActiveTurnChange?: (turnId: string | null) => void;
    captureMessageAnchor?: () => MessageAnchor | null;
    restoreMessageAnchor?: (anchor: MessageAnchor) => boolean;
}

export interface UseChatAutoFollowResult {
    scrollRef: React.RefObject<HTMLDivElement | null>;
    state: AutoFollowState;
    isPinned: boolean;
    isOverflowing: boolean;
    isFollowingProgrammatically: boolean;
    showScrollButton: boolean;
    notifyContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    goToBottom: (mode?: 'instant' | 'smooth') => void;
    releaseAutoFollow: () => void;
    saveSnapshotNow: () => void;
    restoreSnapshot: () => Promise<boolean>;
}

const BOTTOM_SPACER_DESKTOP_VH = 0.10;
const BOTTOM_SPACER_MOBILE_PX = 40;
const PROGRAMMATIC_WRITE_WINDOW_MS = 200;
const SAVE_DEBOUNCE_MS = 150;
const LERP = 0.18;
const SETTLE_EPSILON = 0.5;
const SETTLE_FRAMES = 4;
const TOUCH_FINGER_DOWN_THRESHOLD = 2;
const SETTLE_BURST_DURATION_MS = 280;
const REPIN_GRACE_AFTER_RELEASE_MS = 1200;

export interface AutoFollowReleaseDecisionInput {
    state: AutoFollowState;
    currentTop: number;
    previousTop: number;
    maxScrollNow: number;
    maxScrollPrev: number;
    // True when this scroll change was triggered by a hook-side hard-snap
    // (a programmatic scrollTop write), not a real user gesture.
    programmatic: boolean;
}

// A pending-subagent placeholder can collapse, dropping scrollHeight and thus
// maxScroll (= scrollHeight - clientHeight); the browser then clamps scrollTop
// downward. That clamp looks identical to a user scroll-up (currentTop <
// previousTop) but is content-driven, so it must NOT release auto-follow.
// Release only on an upward move that is NOT explained by a maxScroll decrease.
// A programmatic restore write also moves scrollTop but is hook-driven, so it
// must NOT be misread as a manual release either (gap#5).
export const shouldReleaseAutoFollowOnScroll = ({
    state,
    currentTop,
    previousTop,
    maxScrollNow,
    maxScrollPrev,
    programmatic,
}: AutoFollowReleaseDecisionInput): boolean => {
    if (programmatic) return false;
    if (state !== 'following') return false;
    if (currentTop >= previousTop) return false;
    const isContentDrivenClamp = maxScrollNow < maxScrollPrev;
    return !isContentDrivenClamp;
};

export type RestoreTarget = 'bottom' | 'anchor' | 'ratio';

export interface RestoreTargetDecisionInput {
    streaming: boolean;
    hasSavedSnapshot: boolean;
    atBottom: boolean;
    hasMessageAnchor: boolean;
    hasValidScrollPosition: boolean;
}

// A persisted snapshot may carry a stale legacy numeric viewportAnchor that does
// not survive layout changes. isRealMessageAnchor gates the 'anchor' tier so only
// a genuine { messageId, offsetTop } object can position; a number heals instead.
export const isRealMessageAnchor = (value: unknown): value is MessageAnchor =>
    typeof value === 'object'
    && value !== null
    && typeof (value as { messageId?: unknown }).messageId === 'string'
    && typeof (value as { offsetTop?: unknown }).offsetTop === 'number';

// Deterministic 3-tier restore fallback: real anchor -> settled ratio (valid
// scrollPosition only) -> bottom. D-J1 streaming and missing/at-bottom both pin
// bottom; a legacy numeric anchor never reaches 'anchor', and an invalid
// scrollPosition heals to bottom instead of collapsing to the top.
export const resolveRestoreTarget = ({
    streaming,
    hasSavedSnapshot,
    atBottom,
    hasMessageAnchor,
    hasValidScrollPosition,
}: RestoreTargetDecisionInput): RestoreTarget => {
    if (streaming) return 'bottom';
    if (!hasSavedSnapshot || atBottom) return 'bottom';
    if (hasMessageAnchor) return 'anchor';
    if (hasValidScrollPosition) return 'ratio';
    return 'bottom';
};

// Upper bound on how many times the restore window may hard-snap during content
// growth. Real growth (lazy images, virtualized measurement) is finite; the cap
// guarantees termination even under pathological continuous growth.
export const MAX_RESTORE_RECORRECTIONS = 20;

export type ReCorrectionAction = 're-correct' | 'stop';

export interface ReCorrectionDecisionInput {
    prevContentHeight: number;
    currentContentHeight: number;
    state: AutoFollowState;
    userReleased: boolean;
    correctionCount: number;
}

// Bounded restore-window lifecycle: after a non-bottom restore, re-apply the same
// target while content (scrollHeight) keeps growing, and stop permanently on the
// first stable/shrink observation, on follow handoff, on user release, or at the
// correction cap. Only scrollHeight growth re-corrects — a clientHeight/viewport
// change (keyboard, resize) surfaces as no growth and therefore stops.
export const decideReCorrection = ({
    prevContentHeight,
    currentContentHeight,
    state,
    userReleased,
    correctionCount,
}: ReCorrectionDecisionInput): ReCorrectionAction => {
    if (state === 'following') return 'stop';
    if (userReleased) return 'stop';
    if (correctionCount >= MAX_RESTORE_RECORRECTIONS) return 'stop';
    if (currentContentHeight > prevContentHeight) return 're-correct';
    return 'stop';
};

// A manual user scroll stamps lastUserReleaseAt. The release counts against the
// CURRENT restore window only if it happened strictly after the window opened;
// a stale stamp from a prior window — or the zero stamp written by goToBottom and
// the bottom-pin handoff — means the user re-engaged, so re-correction continues.
export const isReleasedSinceWindowOpen = (
    lastReleaseAt: number,
    windowOpenedAt: number,
): boolean => lastReleaseAt > windowOpenedAt;

// The bottom of the chat has an empty spacer (10vh on desktop, 40px on mobile)
// — its height is exactly how far above scrollHeight the user can be while still
// looking at "empty" space. We use that same value as the threshold for both
// re-pinning auto-follow and showing the scroll-to-bottom button.
const computeBottomZoneThreshold = (isMobile: boolean, container?: HTMLElement | null): number => {
    if (isMobile) return BOTTOM_SPACER_MOBILE_PX;
    const height = container?.clientHeight ?? 0;
    if (height <= 0) return 96;
    return Math.max(48, height * BOTTOM_SPACER_DESKTOP_VH);
};

const distanceFromBottom = (el: HTMLElement): number => {
    return el.scrollHeight - el.scrollTop - el.clientHeight;
};

const isNearBottom = (el: HTMLElement, isMobile: boolean): boolean => {
    return distanceFromBottom(el) <= computeBottomZoneThreshold(isMobile, el);
};

const isReleaseKey = (event: KeyboardEvent): boolean => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
        return false;
    }
    switch (event.key) {
        case 'ArrowUp':
        case 'PageUp':
        case 'Home':
            return true;
        default:
            return false;
    }
};

const nestedScrollableTarget = (root: HTMLElement, target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null;
    const nested = target.closest('[data-scrollable]');
    if (!nested || nested === root || !(nested instanceof HTMLElement)) return null;
    return nested;
};

const nestedScrollableCanConsumeUp = (root: HTMLElement, target: EventTarget | null): boolean => {
    const nested = nestedScrollableTarget(root, target);
    if (!nested) return false;
    return nested.scrollTop > 0;
};

const isAtBottomSnapshot = (snapshot: NonNullable<SessionMemoryState['scrollPosition']>, isMobile: boolean): boolean => {
    const max = Math.max(0, snapshot.scrollHeight - snapshot.clientHeight);
    if (max <= 0) return true;
    const threshold = computeBottomZoneThreshold(isMobile, null);
    return max - snapshot.scrollTop <= threshold;
};

export const useChatAutoFollow = ({
    currentSessionId,
    sessionMessageCount,
    sessionIsWorking,
    isMobile,
    onActiveTurnChange,
    captureMessageAnchor,
    restoreMessageAnchor,
}: UseChatAutoFollowOptions): UseChatAutoFollowResult => {
    const scrollRef = React.useRef<HTMLDivElement | null>(null);
    const [containerEl, setContainerEl] = React.useState<HTMLDivElement | null>(null);
    const lastSeenContainerRef = React.useRef<HTMLDivElement | null>(null);

    const [state, setState] = React.useState<AutoFollowState>('following');
    const [isOverflowing, setIsOverflowing] = React.useState(false);
    const [showScrollButton, setShowScrollButton] = React.useState(false);
    const [isFollowingProgrammatically, setIsFollowingProgrammatically] = React.useState(false);

    const stateRef = React.useRef<AutoFollowState>('following');
    const sessionMessageCountRef = React.useRef(sessionMessageCount);
    sessionMessageCountRef.current = sessionMessageCount;
    const currentSessionIdRef = React.useRef(currentSessionId);
    currentSessionIdRef.current = currentSessionId;
    const sessionIsWorkingRef = React.useRef(sessionIsWorking);
    sessionIsWorkingRef.current = sessionIsWorking;
    const captureMessageAnchorRef = React.useRef(captureMessageAnchor);
    captureMessageAnchorRef.current = captureMessageAnchor;
    const restoreMessageAnchorRef = React.useRef(restoreMessageAnchor);
    restoreMessageAnchorRef.current = restoreMessageAnchor;

    const lastSessionIdRef = React.useRef<string | null>(null);
    const programmaticWriteUntilRef = React.useRef(0);
    const followRafRef = React.useRef<number | null>(null);
    const settledFramesRef = React.useRef(0);
    const lastScrollTopRef = React.useRef(0);
    const lastMaxScrollRef = React.useRef(0);
    const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingSaveRef = React.useRef<{ sessionId: string; anchor: number; messageAnchor: MessageAnchor | null } | null>(null);
    const settleBurstRafRef = React.useRef<number | null>(null);
    const lastUserReleaseAtRef = React.useRef(0);
    // When restoreSnapshot is invoked while ChatViewport is still hydrating
    // (skeleton rendered, no scroll container yet), we record the session here
    // so a follow-up effect can replay the restore once the container mounts.
    const pendingInitialRestoreRef = React.useRef<string | null>(null);
    // Active bounded re-correction window opened by a non-bottom restore. While set,
    // a ResizeObserver hard-snaps `applyTarget` on content-height growth until the
    // lifecycle predicate says stop. `null` means no window (bottom restore / idle).
    const restoreWindowRef = React.useRef<{
        applyTarget: () => void;
        prevContentHeight: number;
        correctionCount: number;
        openedAt: number;
    } | null>(null);
    const [restoreWindowVersion, setRestoreWindowVersion] = React.useState(0);

    const updateViewportAnchor = useViewportStore((s) => s.updateViewportAnchor);

    // Detect when the scroll container DOM element changes (mount, unmount, remount).
    // Without this, listener-attach effects would only ever bind to the element that
    // existed at the hook's first render, missing later mounts (e.g. after first send
    // promotes a draft session to a real chat with messages).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    React.useLayoutEffect(() => {
        if (scrollRef.current !== lastSeenContainerRef.current) {
            lastSeenContainerRef.current = scrollRef.current;
            setContainerEl(scrollRef.current);
        }
    });

    const setStateValue = React.useCallback((next: AutoFollowState) => {
        if (stateRef.current === next) return;
        stateRef.current = next;
        setState(next);
    }, []);

    const markProgrammaticWrite = React.useCallback(() => {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        programmaticWriteUntilRef.current = now + PROGRAMMATIC_WRITE_WINDOW_MS;
    }, []);

    const isInProgrammaticWindow = React.useCallback(() => {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        return now < programmaticWriteUntilRef.current;
    }, []);

    const stopFollowLoop = React.useCallback(() => {
        if (followRafRef.current !== null && typeof window !== 'undefined') {
            window.cancelAnimationFrame(followRafRef.current);
        }
        followRafRef.current = null;
        settledFramesRef.current = 0;
        setIsFollowingProgrammatically(false);
    }, []);

    const tickFollow = React.useCallback(() => {
        followRafRef.current = null;
        const container = scrollRef.current;
        if (!container) {
            stopFollowLoop();
            return;
        }
        if (stateRef.current !== 'following') {
            stopFollowLoop();
            return;
        }

        const target = Math.max(0, container.scrollHeight - container.clientHeight);
        const current = container.scrollTop;
        const delta = target - current;

        if (Math.abs(delta) <= SETTLE_EPSILON) {
            if (current !== target) {
                markProgrammaticWrite();
                container.scrollTop = target;
                lastScrollTopRef.current = target;
            }
            settledFramesRef.current += 1;
            if (settledFramesRef.current >= SETTLE_FRAMES) {
                stopFollowLoop();
                return;
            }
            followRafRef.current = window.requestAnimationFrame(tickFollow);
            return;
        }

        settledFramesRef.current = 0;
        const next = current + delta * LERP;
        markProgrammaticWrite();
        container.scrollTop = next;
        lastScrollTopRef.current = container.scrollTop;
        followRafRef.current = window.requestAnimationFrame(tickFollow);
    }, [markProgrammaticWrite, stopFollowLoop]);

    const startFollowLoop = React.useCallback(() => {
        if (typeof window === 'undefined') return;
        if (followRafRef.current !== null) return;
        if (stateRef.current !== 'following') return;
        settledFramesRef.current = 0;
        setIsFollowingProgrammatically(true);
        followRafRef.current = window.requestAnimationFrame(tickFollow);
    }, [tickFollow]);

    const writeScrollTopInstant = React.useCallback((target: number) => {
        const container = scrollRef.current;
        if (!container) return;
        const max = Math.max(0, container.scrollHeight - container.clientHeight);
        const clamped = Math.max(0, Math.min(target, max));
        markProgrammaticWrite();
        container.scrollTop = clamped;
        lastScrollTopRef.current = container.scrollTop;
    }, [markProgrammaticWrite]);

    const stopSettleBurst = React.useCallback(() => {
        if (settleBurstRafRef.current !== null && typeof window !== 'undefined') {
            window.cancelAnimationFrame(settleBurstRafRef.current);
        }
        settleBurstRafRef.current = null;
    }, []);

    const startSettleBurst = React.useCallback(() => {
        if (typeof window === 'undefined') return;
        stopSettleBurst();
        const until = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + SETTLE_BURST_DURATION_MS;
        const tick = () => {
            settleBurstRafRef.current = null;
            if (stateRef.current !== 'following') return;
            const c = scrollRef.current;
            if (!c) return;
            const target = Math.max(0, c.scrollHeight - c.clientHeight);
            if (Math.abs(c.scrollTop - target) > SETTLE_EPSILON) {
                markProgrammaticWrite();
                c.scrollTop = target;
                lastScrollTopRef.current = target;
            }
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            if (now < until) {
                settleBurstRafRef.current = window.requestAnimationFrame(tick);
            }
        };
        settleBurstRafRef.current = window.requestAnimationFrame(tick);
    }, [markProgrammaticWrite, stopSettleBurst]);

    const releaseAutoFollow = React.useCallback(() => {
        stopFollowLoop();
        stopSettleBurst();
        lastUserReleaseAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
        setStateValue('released');
    }, [setStateValue, stopFollowLoop, stopSettleBurst]);

    const releaseFromUserIntent = React.useCallback(() => {
        if (stateRef.current === 'following') {
            stopFollowLoop();
            stopSettleBurst();
            lastUserReleaseAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
            setStateValue('released');
        } else {
            lastUserReleaseAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
        }
    }, [setStateValue, stopFollowLoop, stopSettleBurst]);

    const goToBottom = React.useCallback((mode: 'instant' | 'smooth' = 'instant') => {
        const container = scrollRef.current;
        setStateValue('following');
        lastUserReleaseAtRef.current = 0;
        if (!container) return;
        if (mode === 'smooth') {
            startFollowLoop();
            return;
        }
        const target = Math.max(0, container.scrollHeight - container.clientHeight);
        writeScrollTopInstant(target);
        startSettleBurst();
    }, [setStateValue, startFollowLoop, startSettleBurst, writeScrollTopInstant]);

    const flushSave = React.useCallback(() => {
        if (saveTimerRef.current !== null) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
        }
        const pending = pendingSaveRef.current;
        if (!pending) return;
        const container = scrollRef.current;
        if (!container) {
            pendingSaveRef.current = null;
            return;
        }
        updateViewportAnchor(pending.sessionId, pending.anchor, {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
        }, pending.messageAnchor ?? undefined);
        pendingSaveRef.current = null;
    }, [updateViewportAnchor]);

    const queueSave = React.useCallback(() => {
        const sessionId = currentSessionIdRef.current;
        if (!sessionId) return;
        const container = scrollRef.current;
        if (!container) return;

        const { scrollTop, scrollHeight, clientHeight } = container;
        const anchorRatio = scrollHeight > 0
            ? (scrollTop + clientHeight / 2) / scrollHeight
            : 0;
        const anchor = Math.floor(anchorRatio * sessionMessageCountRef.current);
        const messageAnchor = captureMessageAnchorRef.current?.() ?? null;

        pendingSaveRef.current = { sessionId, anchor, messageAnchor };
        if (saveTimerRef.current !== null) return;
        saveTimerRef.current = setTimeout(() => {
            saveTimerRef.current = null;
            flushSave();
        }, SAVE_DEBOUNCE_MS);
    }, [flushSave]);

    const saveSnapshotNow = React.useCallback(() => {
        flushSave();
    }, [flushSave]);

    const openRestoreWindow = React.useCallback((applyTarget: () => void) => {
        const container = scrollRef.current;
        restoreWindowRef.current = {
            applyTarget,
            prevContentHeight: container ? container.scrollHeight : 0,
            correctionCount: 0,
            openedAt: typeof performance !== 'undefined' ? performance.now() : Date.now(),
        };
        setRestoreWindowVersion((v) => v + 1);
    }, []);

    const closeRestoreWindow = React.useCallback(() => {
        if (restoreWindowRef.current) {
            restoreWindowRef.current = null;
            setRestoreWindowVersion((v) => v + 1);
        }
    }, []);

    const restoreSnapshot = React.useCallback(async (): Promise<boolean> => {
        const sessionId = currentSessionIdRef.current;
        if (!sessionId) return false;

        const container = scrollRef.current;
        if (!container) {
            // ChatViewport not mounted yet (e.g., session still hydrating).
            // Record the request so the container-attach effect can replay it.
            pendingInitialRestoreRef.current = sessionId;
            setStateValue('following');
            return false;
        }
        pendingInitialRestoreRef.current = null;

        const memState = getViewportSessionMemory(sessionId);
        const saved = memState?.scrollPosition;
        const messageAnchor = isRealMessageAnchor(memState?.messageAnchor) ? memState.messageAnchor : undefined;

        const target = resolveRestoreTarget({
            streaming: sessionIsWorkingRef.current,
            hasSavedSnapshot: Boolean(saved),
            atBottom: saved ? isAtBottomSnapshot(saved, isMobile) : false,
            hasMessageAnchor: Boolean(messageAnchor),
            hasValidScrollPosition: saved ? saved.scrollHeight - saved.clientHeight > 0 : false,
        });

        if (target === 'bottom') {
            closeRestoreWindow();
            setStateValue('following');
            lastUserReleaseAtRef.current = 0;
            const bottom = Math.max(0, container.scrollHeight - container.clientHeight);
            writeScrollTopInstant(bottom);
            startFollowLoop();
            startSettleBurst();
            return false;
        }

        if (target === 'anchor' && messageAnchor) {
            const applyAnchor = () => {
                if (stateRef.current === 'following') return false;
                markProgrammaticWrite();
                return restoreMessageAnchorRef.current?.(messageAnchor) ?? false;
            };
            setStateValue('released');
            if (applyAnchor()) {
                lastScrollTopRef.current = container.scrollTop;
                // Re-pin to the same message while late content growth shifts it.
                openRestoreWindow(() => { applyAnchor(); });
                return true;
            }
        }

        // Legacy fallback: no real anchor (or it was unresolvable). Re-position by
        // the saved scroll ratio; Step 4 heals these legacy entries.
        const savedScroll = saved ?? { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
        const savedMaxScroll = Math.max(0, savedScroll.scrollHeight - savedScroll.clientHeight);
        const ratio = savedMaxScroll > 0 ? savedScroll.scrollTop / savedMaxScroll : 0;
        const applyRatio = () => {
            if (stateRef.current === 'following') return;
            const c = scrollRef.current;
            if (!c) return;
            const cur = Math.max(0, c.scrollHeight - c.clientHeight);
            writeScrollTopInstant(Math.round(ratio * cur));
        };

        setStateValue('released');
        applyRatio();
        // Re-apply the ratio target while late content growth shifts it.
        openRestoreWindow(applyRatio);

        updateViewportAnchor(sessionId, memState?.viewportAnchor ?? 0, {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
        }, messageAnchor ?? undefined);

        return true;
    }, [closeRestoreWindow, isMobile, markProgrammaticWrite, openRestoreWindow, setStateValue, startFollowLoop, startSettleBurst, updateViewportAnchor, writeScrollTopInstant]);

    React.useEffect(() => {
        if (!currentSessionId || currentSessionId === lastSessionIdRef.current) {
            return;
        }
        lastSessionIdRef.current = currentSessionId;
        MessageFreshnessDetector.getInstance().recordSessionStart(currentSessionId);
        flushSave();
        stopFollowLoop();
        stopSettleBurst();
        closeRestoreWindow();
        markProgrammaticWrite();
        // Drop any pending restore request inherited from a different session.
        if (pendingInitialRestoreRef.current && pendingInitialRestoreRef.current !== currentSessionId) {
            pendingInitialRestoreRef.current = null;
        }
    }, [closeRestoreWindow, currentSessionId, flushSave, markProgrammaticWrite, stopFollowLoop, stopSettleBurst]);

    React.useEffect(() => {
        if (sessionIsWorking && stateRef.current === 'following') {
            startFollowLoop();
        }
    }, [sessionIsWorking, startFollowLoop]);

    // Replay a deferred restoreSnapshot once ChatViewport mounts.
    React.useEffect(() => {
        if (!containerEl) return;
        if (pendingInitialRestoreRef.current && pendingInitialRestoreRef.current === currentSessionId) {
            void restoreSnapshot();
        }
    }, [containerEl, currentSessionId, restoreSnapshot]);

    const updateOverflowAndButton = React.useCallback(() => {
        const container = scrollRef.current;
        if (!container) {
            setIsOverflowing(false);
            setShowScrollButton(false);
            return;
        }
        const overflowing = container.scrollHeight > container.clientHeight + 1;
        setIsOverflowing(overflowing);
        if (!overflowing) {
            setShowScrollButton(false);
            return;
        }
        const showButton = stateRef.current === 'released' && !isNearBottom(container, isMobile);
        setShowScrollButton(showButton);
    }, [isMobile]);

    const handleScrollEvent = React.useCallback(() => {
        const container = scrollRef.current;
        if (!container) return;

        const programmatic = isInProgrammaticWindow();
        const currentTop = container.scrollTop;
        const previousTop = lastScrollTopRef.current;
        lastScrollTopRef.current = currentTop;

        const maxScrollNow = container.scrollHeight - container.clientHeight;
        const maxScrollPrev = lastMaxScrollRef.current;
        lastMaxScrollRef.current = maxScrollNow;

        updateOverflowAndButton();

        if (programmatic) {
            return;
        }

        if (shouldReleaseAutoFollowOnScroll({
            state: stateRef.current,
            currentTop,
            previousTop,
            maxScrollNow,
            maxScrollPrev,
            programmatic,
        })) {
            stopFollowLoop();
            stopSettleBurst();
            lastUserReleaseAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
            setStateValue('released');
        }

        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const inGrace = (now - lastUserReleaseAtRef.current) < REPIN_GRACE_AFTER_RELEASE_MS;
        if (stateRef.current === 'released' && isNearBottom(container, isMobile) && !inGrace) {
            setStateValue('following');
            startFollowLoop();
        }

        queueSave();
    }, [
        isInProgrammaticWindow,
        isMobile,
        queueSave,
        setStateValue,
        startFollowLoop,
        stopFollowLoop,
        stopSettleBurst,
        updateOverflowAndButton,
    ]);

    React.useEffect(() => {
        const container = containerEl;
        if (!container) return;

        const handleWheel = (event: WheelEvent) => {
            if (event.deltaY >= 0) return;
            if (nestedScrollableCanConsumeUp(container, event.target)) return;
            releaseFromUserIntent();
        };

        let touchLastY: number | null = null;
        const handleTouchStart = (event: TouchEvent) => {
            const touch = event.touches.item(0);
            touchLastY = touch ? touch.clientY : null;
        };
        const handleTouchMove = (event: TouchEvent) => {
            const touch = event.touches.item(0);
            if (!touch) {
                touchLastY = null;
                return;
            }
            const previousY = touchLastY;
            touchLastY = touch.clientY;
            if (previousY === null) return;
            const fingerDelta = touch.clientY - previousY;
            if (fingerDelta <= TOUCH_FINGER_DOWN_THRESHOLD) return;
            if (nestedScrollableCanConsumeUp(container, event.target)) return;
            releaseFromUserIntent();
        };
        const handleTouchEnd = () => {
            touchLastY = null;
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (!isReleaseKey(event)) return;
            releaseFromUserIntent();
        };

        const handlePointerDownIntent = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (!target.closest('[data-overlay-scrollbar-thumb]')) return;
            releaseFromUserIntent();
        };

        container.addEventListener('scroll', handleScrollEvent, { passive: true });
        container.addEventListener('wheel', handleWheel, { passive: true });
        container.addEventListener('touchstart', handleTouchStart, { passive: true });
        container.addEventListener('touchmove', handleTouchMove, { passive: true });
        container.addEventListener('touchend', handleTouchEnd, { passive: true });
        container.addEventListener('touchcancel', handleTouchEnd, { passive: true });
        container.addEventListener('keydown', handleKeyDown);
        if (typeof window !== 'undefined') {
            window.addEventListener('pointerdown', handlePointerDownIntent, true);
        }

        return () => {
            container.removeEventListener('scroll', handleScrollEvent);
            container.removeEventListener('wheel', handleWheel);
            container.removeEventListener('touchstart', handleTouchStart);
            container.removeEventListener('touchmove', handleTouchMove);
            container.removeEventListener('touchend', handleTouchEnd);
            container.removeEventListener('touchcancel', handleTouchEnd);
            container.removeEventListener('keydown', handleKeyDown);
            if (typeof window !== 'undefined') {
                window.removeEventListener('pointerdown', handlePointerDownIntent, true);
            }
        };
    }, [containerEl, handleScrollEvent, releaseFromUserIntent]);

    React.useEffect(() => {
        const container = containerEl;
        if (!container || typeof ResizeObserver === 'undefined') return;

        const observer = new ResizeObserver(() => {
            updateOverflowAndButton();
            if (stateRef.current === 'following') {
                startFollowLoop();
            }
        });
        observer.observe(container);
        const inner = container.firstElementChild;
        if (inner instanceof Element) {
            observer.observe(inner);
        }
        return () => observer.disconnect();
    }, [containerEl, startFollowLoop, updateOverflowAndButton]);

    // Bounded content-growth re-correction. While a non-bottom restore window is
    // open, a ResizeObserver hard-snaps back to the resolved target each time the
    // content (scrollHeight) grows, until the lifecycle predicate says stop. Setup
    // is synchronous (useLayoutEffect, before paint); the observer disconnects on
    // stop, unmount, session change, and window close — no leak, no infinite loop.
    React.useLayoutEffect(() => {
        // restoreWindowVersion is the re-run trigger: open/closeRestoreWindow bump it
        // so this effect re-subscribes when the ref-held window changes.
        void restoreWindowVersion;
        const container = containerEl;
        const win = restoreWindowRef.current;
        if (!container || !win || typeof ResizeObserver === 'undefined') return;

        const stopWindow = () => {
            restoreWindowRef.current = null;
        };

        const observer = new ResizeObserver(() => {
            const active = restoreWindowRef.current;
            if (!active) {
                observer.disconnect();
                return;
            }
            const currentContentHeight = container.scrollHeight;
            const action = decideReCorrection({
                prevContentHeight: active.prevContentHeight,
                currentContentHeight,
                state: stateRef.current,
                userReleased: isReleasedSinceWindowOpen(lastUserReleaseAtRef.current, active.openedAt),
                correctionCount: active.correctionCount,
            });
            if (action === 're-correct') {
                active.applyTarget();
                active.correctionCount += 1;
                active.prevContentHeight = currentContentHeight;
                return;
            }
            stopWindow();
            observer.disconnect();
        });

        observer.observe(container);
        const inner = container.firstElementChild;
        if (inner instanceof Element) {
            observer.observe(inner);
        }
        return () => observer.disconnect();
    }, [containerEl, restoreWindowVersion]);

    React.useEffect(() => {
        updateOverflowAndButton();
    }, [sessionMessageCount, updateOverflowAndButton]);

    const notifyContentChange = React.useCallback((_reason?: ContentChangeReason) => {
        void _reason;
        updateOverflowAndButton();
        if (stateRef.current === 'following') {
            startFollowLoop();
        }
    }, [startFollowLoop, updateOverflowAndButton]);

    const animationHandlersRef = React.useRef<Map<string, AnimationHandlers>>(new Map());

    const getAnimationHandlers = React.useCallback((messageId: string): AnimationHandlers => {
        const cached = animationHandlersRef.current.get(messageId);
        if (cached) return cached;

        const kick = () => {
            if (stateRef.current === 'following') {
                startFollowLoop();
            }
        };

        const handlers: AnimationHandlers = {
            onChunk: kick,
            onComplete: () => {
                updateOverflowAndButton();
            },
            onStreamingCandidate: () => {},
            onAnimationStart: () => {},
            onAnimatedHeightChange: kick,
            onReservationCancelled: () => {},
            onReasoningBlock: () => {},
        };
        animationHandlersRef.current.set(messageId, handlers);
        return handlers;
    }, [startFollowLoop, updateOverflowAndButton]);

    React.useEffect(() => {
        return () => {
            stopFollowLoop();
            stopSettleBurst();
            flushSave();
            if (saveTimerRef.current !== null) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }
        };
    }, [flushSave, stopFollowLoop, stopSettleBurst]);

    React.useEffect(() => {
        if (!onActiveTurnChange) return;
        const container = containerEl;
        if (!container) return;

        let lastActiveTurnId: string | null = null;
        const spy = createScrollSpy({
            onActive: (turnId) => {
                if (turnId === lastActiveTurnId) return;
                lastActiveTurnId = turnId;
                onActiveTurnChange(turnId);
            },
        });
        spy.setContainer(container);

        const elementByTurnId = new Map<string, HTMLElement>();
        const registerTurnNode = (node: HTMLElement) => {
            const turnId = node.dataset.turnId;
            if (!turnId) return false;
            elementByTurnId.set(turnId, node);
            spy.register(node, turnId);
            return true;
        };
        const unregisterTurnNode = (node: HTMLElement) => {
            const turnId = node.dataset.turnId;
            if (!turnId) return false;
            if (elementByTurnId.get(turnId) !== node) return false;
            elementByTurnId.delete(turnId);
            spy.unregister(turnId);
            return true;
        };
        const collectTurnNodes = (node: Node): HTMLElement[] => {
            if (!(node instanceof HTMLElement)) return [];
            const collected: HTMLElement[] = [];
            if (node.matches('[data-turn-id]')) collected.push(node);
            node.querySelectorAll<HTMLElement>('[data-turn-id]').forEach((el) => collected.push(el));
            return collected;
        };

        container.querySelectorAll<HTMLElement>('[data-turn-id]').forEach(registerTurnNode);
        spy.markDirty();

        const mutationObserver = new MutationObserver((records) => {
            let changed = false;
            records.forEach((record) => {
                record.removedNodes.forEach((node) => {
                    collectTurnNodes(node).forEach((turnNode) => {
                        if (unregisterTurnNode(turnNode)) changed = true;
                    });
                });
                record.addedNodes.forEach((node) => {
                    collectTurnNodes(node).forEach((turnNode) => {
                        if (registerTurnNode(turnNode)) changed = true;
                    });
                });
            });
            if (changed) spy.markDirty();
        });
        mutationObserver.observe(container, { subtree: true, childList: true });

        const onScroll = () => spy.onScroll();
        container.addEventListener('scroll', onScroll, { passive: true });

        return () => {
            container.removeEventListener('scroll', onScroll);
            mutationObserver.disconnect();
            spy.destroy();
        };
    }, [containerEl, onActiveTurnChange]);

    return {
        scrollRef,
        state,
        isPinned: state === 'following',
        isOverflowing,
        isFollowingProgrammatically,
        showScrollButton,
        notifyContentChange,
        getAnimationHandlers,
        goToBottom,
        releaseAutoFollow,
        saveSnapshotNow,
        restoreSnapshot,
    };
};
