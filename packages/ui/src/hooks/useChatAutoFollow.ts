import React from 'react';

import { MessageFreshnessDetector } from '@/lib/messageFreshness';
import { createScrollSpy } from '@/components/chat/lib/scroll/scrollSpy';

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
    isSessionRenderable?: () => boolean;
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
    restoreSnapshot: () => void;
}

const BOTTOM_SPACER_DESKTOP_VH = 0.10;
const BOTTOM_SPACER_MOBILE_PX = 40;
const PROGRAMMATIC_WRITE_WINDOW_MS = 200;
const TOUCH_FINGER_DOWN_THRESHOLD = 2;

// Involuntary micro-corrections (virtua $fixScrollJump via useLayoutEffect,
// browser sub-pixel rounding) nudge scrollTop 1–4 px WITHOUT a
// markProgrammaticWrite() bracket. RELEASE_MIN_DELTA gates these out of the
// user-scroll release path: an intentional scroll-up is always ≥ 20 px, so an
// 8 px floor sits comfortably above the correction range.
export const RELEASE_MIN_DELTA = 8;

// A ResizeObserver fires on BOTH content-height growth (new messages/tokens) and
// viewport changes (e.g. mobile keyboard open shrinking clientHeight). Only genuine
// content growth should trigger a re-snap to the bottom — a viewport resize must not
// be treated as content growth (AGENTS.md). Returns true only when the scrollable
// content height has increased since the last observation.
export const shouldRekickFollowOnResize = (prevContentHeight: number, currentContentHeight: number): boolean =>
    currentContentHeight > prevContentHeight;

export type RestoreGateDecision = 'skip' | 'wait' | 'restore';

export interface RestoreGateInput {
    isRenderable: boolean;
    isHashDeeplink: boolean;
}

// Gate for the one-shot scroll restore. Hash deeplinks are handled by the hash
// scroll handler, so they short-circuit first (they are NOT force-snapped to the
// bottom). If the session snapshot is not renderable yet, return 'wait' so the
// caller does NOT mark the session as scrolled — that mark, set before the
// snapshot was renderable, is what caused the open-scrolled-far-up deadlock (the
// effect early-returned forever and never restored against the mounted
// container). Only 'restore' proceeds (always-bottom-on-open) and marks.
export const decideRestoreGate = ({
    isRenderable,
    isHashDeeplink,
}: RestoreGateInput): RestoreGateDecision => {
    if (isHashDeeplink) return 'skip';
    if (!isRenderable) return 'wait';
    return 'restore';
};

// ─── Two-threshold hysteresis pin/unpin predicates ───────────────────────────
// Release fires when the user has scrolled far enough up that the bottom zone is
// no longer visible (distanceFromBottom > releaseThreshold, supplied from
// computeBottomZoneThreshold by the call site). Re-pin fires only when truly back
// at the bottom (distanceFromBottom <= repinEpsilon). The zone between the two
// thresholds is sticky — neither predicate fires — which is the hysteresis that
// replaces the old release-grace timer.
//
// Content-clamp guard: a maxScroll SHRINK (placeholder collapse, tool-response
// reflow) clamps scrollTop downward and changes distanceFromBottom without any
// user gesture. isMaxScrollClamp lets the call site (WI-B engine) skip
// shouldReleaseAutoFollow when the content drove the distance change.
// ─────────────────────────────────────────────────────────────────────────────

// Small pixel epsilon for "truly back at the bottom". Remains below every
// practical releaseThreshold (≥ 40 px mobile, ≥ 48 px desktop).
export const REPIN_EPSILON_PX = 2;

// Release predicate: fires only when distanceFromBottom STRICTLY EXCEEDS the
// bottom-zone threshold. Supply computeBottomZoneThreshold(...) for
// releaseThreshold. The call site MUST gate with isMaxScrollClamp (skip when
// true) so a content collapse that clamps distanceFromBottom upward is never
// misread as a user scroll.
export const shouldReleaseAutoFollow = ({
    distanceFromBottom,
    releaseThreshold,
}: {
    distanceFromBottom: number;
    releaseThreshold: number;
}): boolean => distanceFromBottom > releaseThreshold;

// Re-pin predicate: fires only when truly back at the bottom (within epsilon).
// Use REPIN_EPSILON_PX as repinEpsilon. Invariant: repinEpsilon < releaseThreshold.
export const shouldRepinAutoFollow = ({
    distanceFromBottom,
    repinEpsilon,
}: {
    distanceFromBottom: number;
    repinEpsilon: number;
}): boolean => distanceFromBottom <= repinEpsilon;

// Content-clamp guard: true when a maxScroll DECREASE (content collapsed,
// browser clamped scrollTop) caused the distanceFromBottom change — not a user
// gesture. The WI-B call site checks this BEFORE calling shouldReleaseAutoFollow
// to avoid false releases during placeholder / tool-response height churn.
export const isMaxScrollClamp = ({
    maxScrollNow,
    maxScrollPrev,
}: {
    maxScrollNow: number;
    maxScrollPrev: number;
}): boolean => maxScrollNow < maxScrollPrev;

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

export const useChatAutoFollow = ({
    currentSessionId,
    sessionMessageCount,
    sessionIsWorking,
    isMobile,
    onActiveTurnChange,
    isSessionRenderable,
}: UseChatAutoFollowOptions): UseChatAutoFollowResult => {
    const scrollRef = React.useRef<HTMLDivElement | null>(null);
    const [containerEl, setContainerEl] = React.useState<HTMLDivElement | null>(null);
    const lastSeenContainerRef = React.useRef<HTMLDivElement | null>(null);

    const [state, setState] = React.useState<AutoFollowState>('following');
    const [isOverflowing, setIsOverflowing] = React.useState(false);
    const [showScrollButton, setShowScrollButton] = React.useState(false);

    const stateRef = React.useRef<AutoFollowState>('following');
    const sessionMessageCountRef = React.useRef(sessionMessageCount);
    sessionMessageCountRef.current = sessionMessageCount;
    const currentSessionIdRef = React.useRef(currentSessionId);
    currentSessionIdRef.current = currentSessionId;
    const sessionIsWorkingRef = React.useRef(sessionIsWorking);
    sessionIsWorkingRef.current = sessionIsWorking;
    const isSessionRenderableRef = React.useRef(isSessionRenderable);
    isSessionRenderableRef.current = isSessionRenderable;

    const lastSessionIdRef = React.useRef<string | null>(null);
    const programmaticWriteUntilRef = React.useRef(0);
    const lastScrollTopRef = React.useRef(0);
    const lastMaxScrollRef = React.useRef(0);
    // Last scrollHeight seen by the follow-loop ResizeObserver; gates the re-snap
    // to genuine content growth so a viewport (clientHeight) resize cannot
    // masquerade as it.
    const lastObservedContentHeightRef = React.useRef(0);
    // Session whose open snap has already been handed off to the PRIMARY layout
    // effect. The first commit for a session is owned by restoreSnapshot (which is
    // hash-deeplink-aware via decideRestoreGate), so the layout snap skips it.
    const layoutSnapSessionRef = React.useRef<string | null>(null);
    // When restoreSnapshot is invoked while ChatViewport is still hydrating
    // (skeleton rendered, no scroll container yet), we record the session here
    // so a follow-up effect can replay the bottom snap once the container mounts.
    const pendingInitialRestoreRef = React.useRef<string | null>(null);

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

    // The single programmatic scroll writer. Instant O(1) read+write to the exact
    // bottom — no rAF, no LERP, no settle burst, no timer. Idempotent: a no-op when
    // already pinned at the bottom, so redundant triggers (layout effect +
    // ResizeObserver + animation kicks firing for the same growth) collapse to one
    // write and never fight each other (this is what removed the two-writer
    // session-open oscillation). NO array scans — safe on the ~60/sec streaming hot
    // path. Every write is bracketed by markProgrammaticWrite() so handleScrollEvent
    // never misreads the snap as a user scroll.
    const snapToBottomIfPinned = React.useCallback(() => {
        if (stateRef.current !== 'following') return;
        const container = scrollRef.current;
        if (!container) return;
        const target = Math.max(0, container.scrollHeight - container.clientHeight);
        if (container.scrollTop === target) return;
        markProgrammaticWrite();
        container.scrollTop = target;
        lastScrollTopRef.current = target;
    }, [markProgrammaticWrite]);

    const releaseAutoFollow = React.useCallback(() => {
        setStateValue('released');
    }, [setStateValue]);

    // The ONLY mid-stream user escape: during streaming the continuous
    // programmatic-write window masks scroll events, so the positional release in
    // handleScrollEvent cannot fire. These intent gestures (wheel/touch/keydown/
    // scrollbar) release regardless of the programmatic window.
    const releaseFromUserIntent = React.useCallback(() => {
        if (stateRef.current !== 'following') return;
        setStateValue('released');
    }, [setStateValue]);

    // FAB / CHAT_FORCE_SCROLL_BOTTOM_EVENT / resume-to-latest entry point. The
    // 'smooth' mode is retired — there is exactly one instant snap writer, so both
    // modes hard-snap to the bottom.
    const goToBottom = React.useCallback((_mode: 'instant' | 'smooth' = 'instant') => {
        void _mode;
        setStateValue('following');
        snapToBottomIfPinned();
    }, [setStateValue, snapToBottomIfPinned]);

    // Always-bottom-on-open. Cross-session scroll memory was removed by design; a
    // session open pins to the bottom. Hash-deeplink opens are exempted upstream by
    // decideRestoreGate ('skip' → releaseAutoFollow), so this only runs for normal
    // opens. When the container is not mounted / the snapshot is not renderable yet,
    // the request is deferred and replayed by the container-attach effect below.
    const restoreSnapshot = React.useCallback((): void => {
        const sessionId = currentSessionIdRef.current;
        if (!sessionId) return;
        const container = scrollRef.current;
        const renderable = isSessionRenderableRef.current
            ? isSessionRenderableRef.current()
            : true;
        setStateValue('following');
        if (!container || !renderable) {
            pendingInitialRestoreRef.current = sessionId;
            return;
        }
        pendingInitialRestoreRef.current = null;
        snapToBottomIfPinned();
    }, [setStateValue, snapToBottomIfPinned]);

    React.useEffect(() => {
        if (!currentSessionId || currentSessionId === lastSessionIdRef.current) {
            return;
        }
        lastSessionIdRef.current = currentSessionId;
        MessageFreshnessDetector.getInstance().recordSessionStart(currentSessionId);
        markProgrammaticWrite();
        // Drop any pending restore request inherited from a different session.
        if (pendingInitialRestoreRef.current && pendingInitialRestoreRef.current !== currentSessionId) {
            pendingInitialRestoreRef.current = null;
        }
    }, [currentSessionId, markProgrammaticWrite]);

    React.useEffect(() => {
        if (sessionIsWorking && stateRef.current === 'following') {
            snapToBottomIfPinned();
        }
    }, [sessionIsWorking, snapToBottomIfPinned]);

    // Replay a deferred always-bottom open once ChatViewport mounts.
    React.useEffect(() => {
        if (!containerEl) return;
        if (pendingInitialRestoreRef.current && pendingInitialRestoreRef.current === currentSessionId) {
            restoreSnapshot();
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

        // Our own snap dispatched this event — never treat a programmatic write as
        // user intent. During streaming the snap keeps this window continuously
        // open, so the positional release below is masked mid-stream: the intent
        // listeners (wheel/touch/keydown/scrollbar) are the only user escape then.
        if (programmatic) {
            return;
        }

        const dist = distanceFromBottom(container);
        const releaseThreshold = computeBottomZoneThreshold(isMobile, container);

        if (stateRef.current === 'following') {
            // Content-driven clamp guard: a maxScroll SHRINK clamps scrollTop and
            // shifts distanceFromBottom without a user gesture — not a release.
            const clamp = isMaxScrollClamp({ maxScrollNow, maxScrollPrev });
            // Micro-correction guard: sub-threshold involuntary upward nudges
            // (virtua $fixScrollJump, browser rounding) must not release.
            const upwardDelta = previousTop - currentTop;
            const microCorrection = upwardDelta > 0 && upwardDelta < RELEASE_MIN_DELTA;
            if (!clamp && !microCorrection && shouldReleaseAutoFollow({ distanceFromBottom: dist, releaseThreshold })) {
                setStateValue('released');
            }
        } else if (shouldRepinAutoFollow({ distanceFromBottom: dist, repinEpsilon: REPIN_EPSILON_PX })) {
            setStateValue('following');
            snapToBottomIfPinned();
        }
    }, [
        isInProgrammaticWindow,
        isMobile,
        setStateValue,
        snapToBottomIfPinned,
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

    // SECONDARY snap trigger. The ResizeObserver observes the container AND its
    // first child so intra-message height growth (streaming tokens, lazy images,
    // tool-output expansion) that does not change the React-driven message count is
    // caught here and re-snapped via the SAME idempotent writer. The layout effect
    // below is the PRIMARY per-commit trigger.
    React.useEffect(() => {
        const container = containerEl;
        if (!container || typeof ResizeObserver === 'undefined') return;

        lastObservedContentHeightRef.current = container.scrollHeight;
        const observer = new ResizeObserver(() => {
            updateOverflowAndButton();
            const currentContentHeight = container.scrollHeight;
            const grew = shouldRekickFollowOnResize(lastObservedContentHeightRef.current, currentContentHeight);
            lastObservedContentHeightRef.current = currentContentHeight;
            if (grew) {
                snapToBottomIfPinned();
            }
        });
        observer.observe(container);
        const inner = container.firstElementChild;
        if (inner instanceof Element) {
            observer.observe(inner);
        }
        return () => observer.disconnect();
    }, [containerEl, snapToBottomIfPinned, updateOverflowAndButton]);

    // PRIMARY snap seam. On each content commit (message-count change / session
    // switch) snap to the bottom synchronously before paint if pinned. The first
    // commit for a session is skipped because the open is owned by restoreSnapshot
    // (hash-deeplink-aware via decideRestoreGate), so a hash open is never
    // force-snapped to the bottom here. O(1) single read+write, idempotent, no
    // array scans — hot-path safe.
    React.useLayoutEffect(() => {
        const firstCommitForSession = layoutSnapSessionRef.current !== currentSessionId;
        layoutSnapSessionRef.current = currentSessionId;
        if (firstCommitForSession) return;
        snapToBottomIfPinned();
    }, [currentSessionId, sessionMessageCount, snapToBottomIfPinned]);

    React.useEffect(() => {
        updateOverflowAndButton();
    }, [sessionMessageCount, updateOverflowAndButton]);

    const notifyContentChange = React.useCallback((_reason?: ContentChangeReason) => {
        void _reason;
        updateOverflowAndButton();
        snapToBottomIfPinned();
    }, [snapToBottomIfPinned, updateOverflowAndButton]);

    const animationHandlersRef = React.useRef<Map<string, AnimationHandlers>>(new Map());

    const getAnimationHandlers = React.useCallback((messageId: string): AnimationHandlers => {
        const cached = animationHandlersRef.current.get(messageId);
        if (cached) return cached;

        const kick = () => {
            snapToBottomIfPinned();
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
    }, [snapToBottomIfPinned, updateOverflowAndButton]);

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

    // True while pinned AND content is actively growing (session working) — the
    // only window in which we programmatically snap. Feeds OverlayScrollbar
    // suppressVisibility so auto-snaps don't flash the scrollbar as a user scroll.
    const isFollowingProgrammatically = state === 'following' && sessionIsWorking;

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
        restoreSnapshot,
    };
};
