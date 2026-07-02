/**
 * Pure pan/zoom math for the fullscreen diagram viewer (Story B, epic openchamber-f9d).
 *
 * This module owns the geometry only — no DOM, no React — so it can be unit-tested without
 * a browser. `DiagramPanZoomViewport` wires these functions to real wheel/pointer events.
 *
 * Renderer-agnostic: mermaid uses it today, plantuml (Story D) reuses it unchanged.
 */

/** Extra slack (px) the diagram may be panned beyond the viewport edge on each axis. */
export const DIAGRAM_PAN_PADDING = 100;

/** Zoom scale clamps — keeps a diagram from vanishing or exploding past usable bounds. */
export const DIAGRAM_MIN_SCALE = 0.25;
export const DIAGRAM_MAX_SCALE = 8;

/**
 * Per-unit wheel sensitivity. A typical wheel notch delivers deltaY ≈ ±100, so this yields
 * roughly a 10% zoom step per notch (multiplicative, so zoom feels linear in perception).
 */
export const DIAGRAM_WHEEL_STEP = 0.001;

export interface PanClampInput {
    offsetX: number;
    offsetY: number;
    /** Current zoom scale applied to the content. */
    scale: number;
    /** Untransformed (layout) size of the diagram content. */
    contentWidth: number;
    contentHeight: number;
    /** Visible viewport size the content pans within. */
    viewportWidth: number;
    viewportHeight: number;
    /** Slack beyond the viewport edge (defaults to DIAGRAM_PAN_PADDING). */
    padding?: number;
}

/**
 * Clamp a pan offset so the (scaled) diagram stays within the viewport plus `padding` slack.
 *
 * The content is centered (transform-origin: center), so at offset 0 it sits centered in the
 * viewport. The maximum absolute offset on an axis is:
 *
 *   max(0, (scaledSize - viewportSize) / 2) + padding
 *
 * - When the scaled diagram is LARGER than the viewport, you can pan far enough to reveal
 *   every edge, plus `padding` extra slack.
 * - When it is smaller, you can still nudge it up to `padding` from center.
 */
export function clampPanOffset(input: PanClampInput): { x: number; y: number } {
    const padding = input.padding ?? DIAGRAM_PAN_PADDING;
    const scaledWidth = input.contentWidth * input.scale;
    const scaledHeight = input.contentHeight * input.scale;

    const maxX = Math.max(0, (scaledWidth - input.viewportWidth) / 2) + padding;
    const maxY = Math.max(0, (scaledHeight - input.viewportHeight) / 2) + padding;

    return {
        x: clamp(input.offsetX, -maxX, maxX),
        y: clamp(input.offsetY, -maxY, maxY),
    };
}

/**
 * Multiplicative wheel zoom: scrolling up (deltaY < 0) zooms in, down zooms out. The result
 * is clamped to [min, max].
 */
export function computeWheelScale(
    currentScale: number,
    deltaY: number,
    options?: { min?: number; max?: number; step?: number },
): number {
    const min = options?.min ?? DIAGRAM_MIN_SCALE;
    const max = options?.max ?? DIAGRAM_MAX_SCALE;
    const step = options?.step ?? DIAGRAM_WHEEL_STEP;
    // deltaY > 0 (scroll down) should shrink; factor < 1 when deltaY > 0.
    const factor = Math.exp(-deltaY * step);
    return clamp(currentScale * factor, min, max);
}

/**
 * Scale for a pinch gesture from a base scale and the ratio of current/initial finger
 * distance. Clamped to [min, max].
 */
export function computePinchScale(
    baseScale: number,
    distanceRatio: number,
    options?: { min?: number; max?: number },
): number {
    const min = options?.min ?? DIAGRAM_MIN_SCALE;
    const max = options?.max ?? DIAGRAM_MAX_SCALE;
    if (!Number.isFinite(distanceRatio) || distanceRatio <= 0) {
        return clamp(baseScale, min, max);
    }
    return clamp(baseScale * distanceRatio, min, max);
}

export function clamp(value: number, min: number, max: number): number {
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

/** Euclidean distance between two pointer positions (used for pinch). */
export function pointerDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
}
