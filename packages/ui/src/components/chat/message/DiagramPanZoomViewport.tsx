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
    DIAGRAM_PINCH_WHEEL_STEP,
    clampPanOffset,
    computeFitScale,
    computePinchScale,
    computeWheelScale,
    isContentPannable,
    pointerDistance,
} from '../markdown/diagramPanZoom';

interface DiagramPanZoomViewportProps {
    children: React.ReactNode;
    className?: string;
    /** Changing this resets pan/zoom (e.g. a new diagram source or a fresh popup open). */
    resetKey?: string;
    'data-testid'?: string;
}

interface Offset {
    x: number;
    y: number;
}

const IDENTITY_OFFSET: Offset = { x: 0, y: 0 };

export const DiagramPanZoomViewport: React.FC<DiagramPanZoomViewportProps> = ({
    children,
    className,
    resetKey,
    ...rest
}) => {
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const contentRef = React.useRef<HTMLDivElement | null>(null);

    const [scale, setScale] = React.useState(1);
    const [offset, setOffset] = React.useState<Offset>(IDENTITY_OFFSET);
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

    // Reset when the diagram identity changes, then fit the content to the viewport. Because a
    // diagram (notably a PlantUML SVG) can paint AFTER mount, the fit is measured across frames
    // until the content has a non-zero layout size, and applied exactly ONCE per resetKey.
    React.useEffect(() => {
        setScale(1);
        setOffset(IDENTITY_OFFSET);
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

        let applied = false;
        let rafId = 0;
        let observer: ResizeObserver | null = null;

        const stop = () => {
            if (rafId) {
                cancelAnimationFrame(rafId);
                rafId = 0;
            }
            if (observer) {
                observer.disconnect();
                observer = null;
            }
        };

        const tryApplyFit = (): boolean => {
            if (applied) {
                return true;
            }
            const contentWidth = content.offsetWidth;
            const contentHeight = content.offsetHeight;
            const viewportWidth = container.clientWidth;
            const viewportHeight = container.clientHeight;
            // Wait for real layout — offsetWidth/clientWidth are 0 before the diagram paints.
            if (contentWidth <= 0 || contentHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
                return false;
            }
            applied = true;
            const fitScale = computeFitScale(contentWidth, contentHeight, viewportWidth, viewportHeight);
            setScale(fitScale);
            setOffset(IDENTITY_OFFSET);
            setCanPan(
                isContentPannable(
                    contentWidth * fitScale,
                    contentHeight * fitScale,
                    viewportWidth,
                    viewportHeight,
                ),
            );
            stop();
            return true;
        };

        // Poll across frames until the content lays out (handles async diagram paint).
        const pump = () => {
            if (tryApplyFit()) {
                return;
            }
            rafId = requestAnimationFrame(pump);
        };
        rafId = requestAnimationFrame(pump);

        // Backstop for very-late paint beyond the initial frames.
        if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(() => {
                tryApplyFit();
            });
            observer.observe(content);
        }

        return stop;
    }, [resetKey]);

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
            // macOS trackpad pinch arrives as a wheel event with ctrlKey=true.
            // Use a larger step so pinch feels responsive instead of crawling.
            const pinchOpts = event.ctrlKey ? { step: DIAGRAM_PINCH_WHEEL_STEP } : undefined;
            const nextScale = computeWheelScale(scaleRef.current, event.deltaY, pinchOpts);
            setScale(nextScale);
            setOffset((current) => clampWithGeometry(current, nextScale));
        };
        container.addEventListener('wheel', onWheel, { passive: false });
        return () => container.removeEventListener('wheel', onWheel);
    }, [clampWithGeometry]);

    const handlePointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        event.currentTarget.setPointerCapture?.(event.pointerId);

        if (pointersRef.current.size === 2) {
            // Enter pinch: capture baseline distance + scale, cancel any single-pointer drag.
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

        dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: offset.x,
            originY: offset.y,
        };
        setIsPanning(true);
    }, [offset.x, offset.y, isPannableAtScale]);

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
            setScale(nextScale);
            setOffset((current) => clampWithGeometry(current, nextScale));
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
        setOffset(nextOffset);
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
};

DiagramPanZoomViewport.displayName = 'DiagramPanZoomViewport';
