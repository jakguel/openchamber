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

/**
 * Wheel sensitivity for Mac trackpad pinch (wheel events with ctrlKey=true).
 * macOS reports pinch as synthetic wheel events with ctrlKey set; deltaY values are similar
 * in magnitude to a scroll notch, so we use a larger step to make pinch feel responsive.
 * 0.015 → ~150% zoom change per 100-unit deltaY vs ~10% for regular scroll.
 */
export const DIAGRAM_PINCH_WHEEL_STEP = 0.015;

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
 * Clamp a single axis pan offset.
 *
 * - When the scaled content OVERFLOWS the viewport on this axis (scaledSize > viewportSize),
 *   the offset is bounded to ±((scaledSize - viewportSize) / 2 + padding): you can pan far
 *   enough to reveal every edge, plus `padding` extra slack.
 * - When it does NOT overflow (scaledSize <= viewportSize), the content fits on this axis and
 *   must stay centered, so the offset is FORCED to 0 (re-center). This is what re-centers an
 *   axis after a focal zoom shrinks the content back inside the viewport.
 */
function clampPanAxis(offset: number, scaledSize: number, viewportSize: number, padding: number): number {
    if (scaledSize <= viewportSize) {
        return 0;
    }
    const max = (scaledSize - viewportSize) / 2 + padding;
    return clamp(offset, -max, max);
}

/**
 * Clamp a pan offset so the (scaled) diagram stays within the viewport plus `padding` slack,
 * PER AXIS and independently. The content is centered (transform-origin: center), so at offset
 * 0 it sits centered in the viewport.
 *
 * Each axis is clamped on its own:
 * - Overflowing axis  → bounded to ±((scaledSize - viewportSize) / 2 + padding).
 * - Non-overflow axis → forced to 0 (the content fits, so it re-centers).
 *
 * A focal zoom can leave one axis overflowing and the other fitting; this keeps the fitting
 * axis centered while still allowing full pan on the overflowing one.
 */
export function clampPanOffset(input: PanClampInput): { x: number; y: number } {
    const padding = input.padding ?? DIAGRAM_PAN_PADDING;
    const scaledWidth = input.contentWidth * input.scale;
    const scaledHeight = input.contentHeight * input.scale;

    return {
        x: clampPanAxis(input.offsetX, scaledWidth, input.viewportWidth, padding),
        y: clampPanAxis(input.offsetY, scaledHeight, input.viewportHeight, padding),
    };
}

/**
 * Focal (zoom-to-cursor) pan offset: scaling the content from `scale` to `nextScale` while
 * keeping the content point currently under `cursor` fixed on screen.
 *
 * With a center-origin transform (`translate(offset) scale(s)`, transform-origin center), the
 * offset that keeps the cursor's content point stationary is:
 *
 *   offset' = offset * (s'/s) + d * (1 - s'/s),   d = cursor - viewportCenter
 *
 * where `s'` is the CLAMPED next scale (clamped to [DIAGRAM_MIN_SCALE, DIAGRAM_MAX_SCALE]).
 * Clamping the scale here is what keeps the focal point fixed even at the zoom bounds — using
 * the raw (unclamped) next scale would drift the cursor point once a bound is hit.
 *
 * `d` and the returned offset are in the same screen-pixel units as the applied translate.
 * When the effective scale is unchanged (ratio 1) the offset passes through unchanged, and a
 * non-finite / non-positive current scale returns the offset untouched (never NaN).
 */
export function zoomAboutPoint(
    offset: { x: number; y: number },
    scale: number,
    nextScale: number,
    cursor: { x: number; y: number },
    viewportCenter: { x: number; y: number },
): { x: number; y: number } {
    if (!Number.isFinite(scale) || scale <= 0) {
        return { x: offset.x, y: offset.y };
    }
    const clampedNext = clamp(nextScale, DIAGRAM_MIN_SCALE, DIAGRAM_MAX_SCALE);
    const ratio = clampedNext / scale;
    const dx = cursor.x - viewportCenter.x;
    const dy = cursor.y - viewportCenter.y;
    return {
        x: offset.x * ratio + dx * (1 - ratio),
        y: offset.y * ratio + dy * (1 - ratio),
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


/**
 * Largest uniform scale that fits `content` inside `viewport` = min(vw/cw, vh/ch), clamped to
 * [DIAGRAM_MIN_SCALE, DIAGRAM_MAX_SCALE]. Used to seed the fullscreen fit-to-viewport scale so
 * a diagram fills the popup edge-to-edge instead of painting at inline/intrinsic size.
 *
 * Every argument is guarded before dividing: a 0, negative, NaN, or Infinity input returns 1
 * (safe fallback), never emitting 0, Infinity, or NaN.
 */
export function computeFitScale(
    contentWidth: number,
    contentHeight: number,
    viewportWidth: number,
    viewportHeight: number,
): number {
    const args = [contentWidth, contentHeight, viewportWidth, viewportHeight];
    for (const value of args) {
        if (!Number.isFinite(value) || value <= 0) return 1;
    }
    const fit = Math.min(viewportWidth / contentWidth, viewportHeight / contentHeight);
    return clamp(fit, DIAGRAM_MIN_SCALE, DIAGRAM_MAX_SCALE);
}

/**
 * True iff the scaled content overflows the viewport on either axis (strictly greater). Gates
 * pointer-drag panning: panning is only allowed when there is off-screen content to reveal.
 */
export function isContentPannable(
    scaledWidth: number,
    scaledHeight: number,
    viewportWidth: number,
    viewportHeight: number,
): boolean {
    return scaledWidth > viewportWidth || scaledHeight > viewportHeight;
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
