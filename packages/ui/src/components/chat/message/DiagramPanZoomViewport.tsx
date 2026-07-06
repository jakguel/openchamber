/**
 * Renderer-agnostic fullscreen pan/zoom viewport (Story B, epic openchamber-f9d, task .15.2).
 *
 * Replaces the old scroll-in-a-box fullscreen viewer with a true CSS-transform surface:
 *  - PAN: pointer drag translates the content, bounded to the viewport + 100px slack.
 *  - ZOOM: wheel (desktop) and two-finger pinch (touch) scale the content.
 *
 * It owns NO renderer specifics and NO app context (no i18n / theme / stores), so mermaid
 * (today) and plantuml (Story D) both wrap their rendered diagram in this same component.
 *
 * The transform is applied inline (`translate(x,y) scale(s)`) so the movement is driven by
 * the transform, not by overflow scrolling — the container clips (overflow hidden) and the
 * content moves within it.
 */
import * as React from 'react';

import { cn } from '@/lib/utils';
import {
    DIAGRAM_MAX_SCALE,
    DIAGRAM_MIN_SCALE,
    DIAGRAM_PINCH_WHEEL_STEP,
    clampPanOffset,
    computeFitScale,
    computePinchScale,
    computeWheelScale,
    isContentPannable,
    pointerDistance,
    zoomAboutPoint,
} from '../markdown/diagramPanZoom';

/**
 * Synthetic wheel delta a single +/- button press feeds into `computeWheelScale`, so the
 * button zoom reuses the EXACT same multiplicative step + clamp as the wheel path — one press
 * ≈ a 28% zoom change (exp(250 * DIAGRAM_WHEEL_STEP)). Zoom-in feeds a negative delta (wheel-up
 * semantics), zoom-out a positive one.
 */
const DIAGRAM_BUTTON_ZOOM_DELTA = 250;

/** Tolerance for treating a scale as "at the clamp" when reporting can-zoom state. */
const ZOOM_CLAMP_EPSILON = 1e-3;

/**
 * Imperative API exposed via ref so an app-context owner (the dialog, which has i18n/theme)
 * can drive the context-free viewport's zoom with its own +/- buttons. `zoomIn`/`zoomOut`
 * zoom about the VIEWPORT CENTER (focal d=0); `resetFit` re-runs the contain-fit.
 */
export interface DiagramPanZoomHandle {
    zoomIn: () => void;
    zoomOut: () => void;
    resetFit: () => void;
}

/** Zoom-state snapshot pushed to `onZoomStateChange` so the dialog can disable buttons at clamp. */
export interface DiagramZoomState {
    canZoomIn: boolean;
    canZoomOut: boolean;
}

interface DiagramPanZoomViewportProps {
    children: React.ReactNode;
    className?: string;
    /** Changing this resets pan/zoom (e.g. a new diagram source or a fresh popup open). */
    resetKey?: string;
    /**
     * Fired whenever the zoom scale changes (wheel/pinch/button) AND once after the initial
     * contain-fit, so an owner can reflect the [min,max] clamp in its button `disabled` state.
     */
    onZoomStateChange?: (state: DiagramZoomState) => void;
    'data-testid'?: string;
}

interface Offset {
    x: number;
    y: number;
}

/**
 * Combined pan/zoom view. Scale and offset live in ONE state object so the wheel handler can
 * commit a focal zoom (new scale + cursor-anchored offset) as a single atomic update derived
 * from one base snapshot — never as two racing setState calls.
 */
interface ViewState {
    scale: number;
    offset: Offset;
}

const IDENTITY_OFFSET: Offset = { x: 0, y: 0 };
const IDENTITY_VIEW: ViewState = { scale: 1, offset: IDENTITY_OFFSET };

export const DiagramPanZoomViewport = React.forwardRef<DiagramPanZoomHandle, DiagramPanZoomViewportProps>(function DiagramPanZoomViewport(
    { children, className, resetKey, onZoomStateChange, ...rest },
    ref,
) {
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const contentRef = React.useRef<HTMLDivElement | null>(null);

    const [view, setView] = React.useState<ViewState>(IDENTITY_VIEW);
    const { scale, offset } = view;
    const [isPanning, setIsPanning] = React.useState(false);
    // Whether the (scaled) content currently overflows the viewport — gates pan + cursor.
    const [canPan, setCanPan] = React.useState(false);

    // Drag state (single pointer pan).
    const dragRef = React.useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
    // Active pointers for pinch detection.
    const pointersRef = React.useRef<Map<number, { x: number; y: number }>>(new Map());
    // Pinch gesture baseline.
    const pinchRef = React.useRef<{ baseScale: number; baseDistance: number } | null>(null);

    // Keep the latest scale readable inside imperative handlers without re-binding them.
    const scaleRef = React.useRef(scale);
    scaleRef.current = scale;

    // Latest zoom-state callback kept in a ref so the scale-watch effect can fire it without
    // re-subscribing on every render (the dialog re-creates the callback freely).
    const onZoomStateChangeRef = React.useRef(onZoomStateChange);
    onZoomStateChangeRef.current = onZoomStateChange;

    // Auto-fit-until-interaction lifecycle. A cold @plantuml/core WASM SVG can settle to its final
    // intrinsic layout a few frames AFTER the first fit lands, so we keep re-fitting on every
    // content-box change UNTIL the user takes manual control. `userInteractedRef` is a synchronous
    // ref (not state) so an interaction firing in the same tick as a pending auto-fit frame reliably
    // suppresses it; the reset effect publishes its cancel + (re)fit hooks below for the handlers.
    const userInteractedRef = React.useRef(false);
    const cancelAutoFitFrameRef = React.useRef<() => void>(() => {});
    const scheduleAutoFitRef = React.useRef<((retryUntilReady?: boolean) => void) | null>(null);
    const markUserInteracted = React.useCallback(() => {
        userInteractedRef.current = true;
        cancelAutoFitFrameRef.current();
    }, []);

    const clampWithGeometry = React.useCallback((next: Offset, atScale: number): Offset => {
        const container = containerRef.current;
        const content = contentRef.current;
        if (!container || !content) {
            return next;
        }
        return clampPanOffset({
            offsetX: next.x,
            offsetY: next.y,
            scale: atScale,
            contentWidth: content.offsetWidth,
            contentHeight: content.offsetHeight,
            viewportWidth: container.clientWidth,
            viewportHeight: container.clientHeight,
        });
    }, []);

    // True when the (scaled) content overflows the viewport on either axis — the only state in
    // which panning reveals hidden content. Under fit-to-viewport the initial scale is often > 1
    // while the content still exactly fits, so overflow (not scale) is the correct pan signal.
    const isPannableAtScale = React.useCallback((atScale: number): boolean => {
        const container = containerRef.current;
        const content = contentRef.current;
        if (!container || !content) {
            return false;
        }
        return isContentPannable(
            content.offsetWidth * atScale,
            content.offsetHeight * atScale,
            container.clientWidth,
            container.clientHeight,
        );
    }, []);

    // Measure the content + viewport NOW and apply the contain-fit (scale + recentered offset).
    // Returns false when layout isn't ready yet (0-size), so the reset effect can keep polling.
    // Shared by the mount/resetKey fit and the imperative `resetFit` so both use one code path.
    const fitToViewport = React.useCallback((): boolean => {
        const container = containerRef.current;
        const content = contentRef.current;
        if (!container || !content) {
            return false;
        }
        const contentWidth = content.offsetWidth;
        const contentHeight = content.offsetHeight;
        const viewportWidth = container.clientWidth;
        const viewportHeight = container.clientHeight;
        // Wait for real layout — offsetWidth/clientWidth are 0 before the diagram paints.
        if (contentWidth <= 0 || contentHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
            return false;
        }
        const fitScale = computeFitScale(contentWidth, contentHeight, viewportWidth, viewportHeight);
        setView({ scale: fitScale, offset: IDENTITY_OFFSET });
        setCanPan(isContentPannable(contentWidth * fitScale, contentHeight * fitScale, viewportWidth, viewportHeight));
        return true;
    }, []);

    // Zoom about the viewport CENTER by feeding a synthetic wheel delta through the same
    // `computeWheelScale` + `zoomAboutPoint` + per-axis clamp the wheel path uses. Passing the
    // same anchor for cursor and viewportCenter makes the focal distance d = 0 (center zoom),
    // committed as ONE atomic {scale, offset} update. At a clamp the scale is unchanged (no-op).
    const applyButtonZoom = React.useCallback((deltaY: number) => {
        const container = containerRef.current;
        const content = contentRef.current;
        if (!container || !content) {
            return;
        }
        const contentWidth = content.offsetWidth;
        const contentHeight = content.offsetHeight;
        const viewportWidth = container.clientWidth;
        const viewportHeight = container.clientHeight;
        markUserInteracted();
        setView((base) => {
            const nextScale = computeWheelScale(base.scale, deltaY);
            const focal = zoomAboutPoint(base.offset, base.scale, nextScale, IDENTITY_OFFSET, IDENTITY_OFFSET);
            const nextOffset = clampPanOffset({
                offsetX: focal.x,
                offsetY: focal.y,
                scale: nextScale,
                contentWidth,
                contentHeight,
                viewportWidth,
                viewportHeight,
            });
            return { scale: nextScale, offset: nextOffset };
        });
    }, [markUserInteracted]);

    // Bridge the context-free viewport to an app-context owner (the dialog with i18n/theme):
    // expose zoomIn/zoomOut (center focal) + resetFit through a ref so the dialog's +/- buttons
    // drive this viewport without the viewport importing any app context.
    React.useImperativeHandle(ref, () => ({
        zoomIn: () => applyButtonZoom(-DIAGRAM_BUTTON_ZOOM_DELTA),
        zoomOut: () => applyButtonZoom(DIAGRAM_BUTTON_ZOOM_DELTA),
        resetFit: () => {
            userInteractedRef.current = false;
            if (!fitToViewport()) {
                scheduleAutoFitRef.current?.(true);
            }
        },
    }), [applyButtonZoom, fitToViewport]);

    // Report can-zoom state on every scale change AND after the initial fit (fit sets scale,
    // re-running this) so the dialog can disable each button at the [min, max] clamp.
    React.useEffect(() => {
        onZoomStateChangeRef.current?.({
            canZoomIn: scale < DIAGRAM_MAX_SCALE - ZOOM_CLAMP_EPSILON,
            canZoomOut: scale > DIAGRAM_MIN_SCALE + ZOOM_CLAMP_EPSILON,
        });
    }, [scale]);

    // Reset when the diagram identity changes, then fit the content to the viewport and KEEP
    // re-fitting on late layout settle until the first user interaction. A cold @plantuml/core SVG
    // can grow ~4% a few frames after the first fit, so a fit-once latch would leave it over-fit;
    // instead the ResizeObserver stays connected and re-fits (rAF-coalesced) until the user zooms/
    // pans. Transform-only scaling never changes the observed layout box, so this cannot self-loop.
    React.useEffect(() => {
        userInteractedRef.current = false;
        setView(IDENTITY_VIEW);
        setCanPan(false);
        dragRef.current = null;
        pinchRef.current = null;
        pointersRef.current.clear();
        setIsPanning(false);

        const container = containerRef.current;
        const content = contentRef.current;
        if (!container || !content) {
            return;
        }

        let disposed = false;
        let rafId = 0;
        let observer: ResizeObserver | null = null;

        const cancelFrame = () => {
            if (rafId) {
                cancelAnimationFrame(rafId);
                rafId = 0;
            }
        };

        const scheduleAutoFit = (retryUntilReady = false) => {
            if (disposed || userInteractedRef.current || rafId) {
                return;
            }
            rafId = requestAnimationFrame(() => {
                rafId = 0;
                if (disposed || userInteractedRef.current) {
                    return;
                }
                const didFit = fitToViewport();
                if (!didFit && retryUntilReady && !userInteractedRef.current) {
                    scheduleAutoFit(true);
                }
            });
        };

        cancelAutoFitFrameRef.current = cancelFrame;
        scheduleAutoFitRef.current = scheduleAutoFit;

        // Cold-open pump: retry across frames until the content has a measurable layout size.
        scheduleAutoFit(true);

        if (typeof ResizeObserver !== 'undefined') {
            // Late (cold-WASM) intrinsic layout growth lands here and re-fits, UNTIL the user takes
            // manual control. A transform-only scale never changes the observed layout box -> no loop.
            observer = new ResizeObserver(() => {
                scheduleAutoFit(false);
            });
            observer.observe(content);
        }

        return () => {
            disposed = true;
            cancelFrame();
            observer?.disconnect();
            observer = null;
            cancelAutoFitFrameRef.current = () => {};
            if (scheduleAutoFitRef.current === scheduleAutoFit) {
                scheduleAutoFitRef.current = null;
            }
        };
    }, [resetKey, fitToViewport]);

    // Keep the cursor/pannability state in sync as the scale changes (wheel/pinch zoom).
    React.useEffect(() => {
        setCanPan(isPannableAtScale(scale));
    }, [scale, isPannableAtScale]);

    // Wheel zoom must be a non-passive listener so it can preventDefault the page scroll.
    React.useEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            const content = contentRef.current;
            if (!content) {
                return;
            }
            // macOS trackpad pinch arrives as a wheel event with ctrlKey=true. Both the desktop
            // wheel and the trackpad-pinch path zoom FOCALLY about the cursor; pinch just uses a
            // larger step so it feels responsive instead of crawling.
            const pinchOpts = event.ctrlKey ? { step: DIAGRAM_PINCH_WHEEL_STEP } : undefined;
            const rect = container.getBoundingClientRect();
            const cursor = { x: event.clientX, y: event.clientY };
            const viewportCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            const contentWidth = content.offsetWidth;
            const contentHeight = content.offsetHeight;
            const viewportWidth = container.clientWidth;
            const viewportHeight = container.clientHeight;
            markUserInteracted();
            // ONE atomic update: derive nextScale AND the focal, per-axis-clamped nextOffset from
            // the SAME base snapshot. Never split into racing setScale + setOffset — a functional
            // update also lets rapid wheel events accumulate correctly off the true prior view.
            setView((base) => {
                const nextScale = computeWheelScale(base.scale, event.deltaY, pinchOpts);
                const focal = zoomAboutPoint(base.offset, base.scale, nextScale, cursor, viewportCenter);
                const nextOffset = clampPanOffset({
                    offsetX: focal.x,
                    offsetY: focal.y,
                    scale: nextScale,
                    contentWidth,
                    contentHeight,
                    viewportWidth,
                    viewportHeight,
                });
                return { scale: nextScale, offset: nextOffset };
            });
        };
        container.addEventListener('wheel', onWheel, { passive: false });
        return () => container.removeEventListener('wheel', onWheel);
    }, [markUserInteracted]);

    const handlePointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        event.currentTarget.setPointerCapture?.(event.pointerId);

        if (pointersRef.current.size === 2) {
            // Enter pinch: capture baseline distance + scale, cancel any single-pointer drag.
            markUserInteracted();
            const [a, b] = Array.from(pointersRef.current.values());
            pinchRef.current = { baseScale: scaleRef.current, baseDistance: pointerDistance(a, b) };
            dragRef.current = null;
            setIsPanning(false);
            return;
        }

        // Pan only when the content overflows the viewport — at the fitted, non-overflowing
        // state a drag must not move the diagram.
        if (!isPannableAtScale(scaleRef.current)) {
            return;
        }

        // A real pan starts here (past the pannability gate) — disable auto-fit so a late settle
        // cannot yank the view out from under the drag. A plain non-pannable click never reaches this.
        markUserInteracted();
        dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: offset.x,
            originY: offset.y,
        };
        setIsPanning(true);
    }, [offset.x, offset.y, isPannableAtScale, markUserInteracted]);

    const handlePointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (pointersRef.current.has(event.pointerId)) {
            pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        }

        // Pinch takes precedence when two pointers are down.
        if (pinchRef.current && pointersRef.current.size >= 2) {
            const [a, b] = Array.from(pointersRef.current.values());
            const distance = pointerDistance(a, b);
            const ratio = distance / pinchRef.current.baseDistance;
            const nextScale = computePinchScale(pinchRef.current.baseScale, ratio);
            setView((base) => ({
                scale: nextScale,
                offset: clampWithGeometry(base.offset, nextScale),
            }));
            return;
        }

        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) {
            return;
        }
        const nextOffset = clampWithGeometry(
            {
                x: drag.originX + (event.clientX - drag.startX),
                y: drag.originY + (event.clientY - drag.startY),
            },
            scaleRef.current,
        );
        setView((base) => ({ scale: base.scale, offset: nextOffset }));
    }, [clampWithGeometry]);

    const endPointer = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        pointersRef.current.delete(event.pointerId);
        event.currentTarget.releasePointerCapture?.(event.pointerId);

        if (pointersRef.current.size < 2) {
            pinchRef.current = null;
        }
        if (dragRef.current?.pointerId === event.pointerId) {
            dragRef.current = null;
            setIsPanning(false);
        }
    }, []);

    const transform = `translate(${offset.x}px, ${offset.y}px) scale(${scale})`;

    return (
        <div
            ref={containerRef}
            data-diagram-panzoom=""
            className={cn(className)}
            // Structural layout is inline (not utility classes) so the viewport measures and
            // centers correctly regardless of whether the Tailwind pipeline is present — this
            // is a self-contained reusable primitive (mermaid today, plantuml in Story D).
            style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                overflow: 'hidden',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                touchAction: 'none',
                cursor: canPan ? (isPanning ? 'grabbing' : 'grab') : 'default',
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endPointer}
            onPointerCancel={endPointer}
            onPointerLeave={endPointer}
            {...rest}
        >
            <div
                ref={contentRef}
                data-diagram-panzoom-content=""
                style={{
                    transform,
                    transformOrigin: 'center center',
                    willChange: 'transform',
                    flex: '0 0 auto',
                }}
            >
                {children}
            </div>
        </div>
    );
});

DiagramPanZoomViewport.displayName = 'DiagramPanZoomViewport';
