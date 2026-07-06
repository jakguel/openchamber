/**
 * Unit tests for the pure pan/zoom geometry (Story B, epic openchamber-f9d, task .15.2).
 *
 * These call the REAL production functions — no mocks. Each assertion changes result if the
 * math is wrong (e.g. dropping the +padding slack, or inverting wheel direction).
 *
 * Runs in isolation: `bun test packages/ui/src/components/chat/markdown/diagramPanZoom.test.ts`
 */
import { describe, expect, test } from 'bun:test';

import {
    DIAGRAM_MAX_SCALE,
    DIAGRAM_MIN_SCALE,
    clampPanOffset,
    computeFitScale,
    computePinchScale,
    computeWheelScale,
    isContentPannable,
    pointerDistance,
    zoomAboutPoint,
} from './diagramPanZoom';

describe('clampPanOffset', () => {
    test('diagram larger than viewport: max offset reveals edges plus padding slack', () => {
        // content 2000x1500, viewport 600x400, scale 1.
        // maxX = (2000 - 600)/2 + 100 = 800 ; maxY = (1500 - 400)/2 + 100 = 650
        const clamped = clampPanOffset({
            offsetX: 99999,
            offsetY: 99999,
            scale: 1,
            contentWidth: 2000,
            contentHeight: 1500,
            viewportWidth: 600,
            viewportHeight: 400,
        });
        expect(clamped.x).toBe(800);
        expect(clamped.y).toBe(650);
    });

    test('negative overshoot clamps to the mirror bound', () => {
        const clamped = clampPanOffset({
            offsetX: -99999,
            offsetY: -99999,
            scale: 1,
            contentWidth: 2000,
            contentHeight: 1500,
            viewportWidth: 600,
            viewportHeight: 400,
        });
        expect(clamped.x).toBe(-800);
        expect(clamped.y).toBe(-650);
    });

    test('bounds scale with zoom: larger scale => larger reachable offset', () => {
        const atOne = clampPanOffset({
            offsetX: 99999,
            offsetY: 0,
            scale: 1,
            contentWidth: 800,
            contentHeight: 600,
            viewportWidth: 600,
            viewportHeight: 400,
        });
        const atTwo = clampPanOffset({
            offsetX: 99999,
            offsetY: 0,
            scale: 2,
            contentWidth: 800,
            contentHeight: 600,
            viewportWidth: 600,
            viewportHeight: 400,
        });
        // scale 1: (800-600)/2 + 100 = 200 ; scale 2: (1600-600)/2 + 100 = 600
        expect(atOne.x).toBe(200);
        expect(atTwo.x).toBe(600);
        expect(atTwo.x).toBeGreaterThan(atOne.x);
    });

    test('diagram smaller than viewport re-centers both axes to 0 (per-axis, no nudge)', () => {
        const clamped = clampPanOffset({
            offsetX: 99999,
            offsetY: 99999,
            scale: 1,
            contentWidth: 100,
            contentHeight: 100,
            viewportWidth: 600,
            viewportHeight: 400,
        });
        // Both axes fit (scaledSize <= viewportSize) => forced to 0, not a padding nudge.
        expect(clamped.x).toBe(0);
        expect(clamped.y).toBe(0);
    });

    test('offset within bounds passes through unchanged', () => {
        const clamped = clampPanOffset({
            offsetX: 50,
            offsetY: -30,
            scale: 1,
            contentWidth: 2000,
            contentHeight: 1500,
            viewportWidth: 600,
            viewportHeight: 400,
        });
        expect(clamped.x).toBe(50);
        expect(clamped.y).toBe(-30);
    });

    test('custom padding is honored on an overflowing axis', () => {
        const clamped = clampPanOffset({
            offsetX: 99999,
            offsetY: 0,
            scale: 1,
            // X overflows (2000 > 600); Y does not (100 < 400).
            contentWidth: 2000,
            contentHeight: 100,
            viewportWidth: 600,
            viewportHeight: 400,
            padding: 25,
        });
        // Overflowing X: (2000 - 600)/2 + 25 = 725.
        expect(clamped.x).toBe(725);
        // Non-overflow Y is re-centered to 0 regardless of padding.
        expect(clamped.y).toBe(0);
    });

    test('per-axis: X overflows (bounded) while Y fits (forced to 0)', () => {
        const clamped = clampPanOffset({
            offsetX: 99999,
            offsetY: 99999,
            scale: 1,
            // X overflows: 2000 > 600. Y fits: 300 < 400.
            contentWidth: 2000,
            contentHeight: 300,
            viewportWidth: 600,
            viewportHeight: 400,
        });
        // X bounded: (2000 - 600)/2 + 100 = 800. Y forced to 0.
        expect(clamped.x).toBe(800);
        expect(clamped.y).toBe(0);
    });

    test('per-axis: Y overflows (bounded) while X fits (forced to 0)', () => {
        const clamped = clampPanOffset({
            offsetX: 99999,
            offsetY: 99999,
            scale: 1,
            // X fits: 500 < 600. Y overflows: 1500 > 400.
            contentWidth: 500,
            contentHeight: 1500,
            viewportWidth: 600,
            viewportHeight: 400,
        });
        // X forced to 0. Y bounded: (1500 - 400)/2 + 100 = 650.
        expect(clamped.x).toBe(0);
        expect(clamped.y).toBe(650);
    });

    test('exact-equal axis size does not overflow => forced to 0', () => {
        const clamped = clampPanOffset({
            offsetX: 99999,
            offsetY: 99999,
            scale: 1,
            // Both axes exactly equal the viewport (scaledSize == viewportSize, not > ).
            contentWidth: 600,
            contentHeight: 400,
            viewportWidth: 600,
            viewportHeight: 400,
        });
        expect(clamped.x).toBe(0);
        expect(clamped.y).toBe(0);
    });
});

describe('computeWheelScale', () => {
    test('scroll up (negative deltaY) zooms in', () => {
        const next = computeWheelScale(1, -100);
        expect(next).toBeGreaterThan(1);
    });

    test('scroll down (positive deltaY) zooms out', () => {
        const next = computeWheelScale(1, 100);
        expect(next).toBeLessThan(1);
    });

    test('clamps to max scale', () => {
        const next = computeWheelScale(DIAGRAM_MAX_SCALE, -100000);
        expect(next).toBe(DIAGRAM_MAX_SCALE);
    });

    test('large negative deltaY with default step clamps to max (8)', () => {
        expect(computeWheelScale(1, -100000)).toBe(DIAGRAM_MAX_SCALE);
        expect(DIAGRAM_MAX_SCALE).toBe(8);
    });

    test('large positive deltaY with default step clamps to min (0.25)', () => {
        expect(computeWheelScale(1, 100000)).toBe(DIAGRAM_MIN_SCALE);
        expect(DIAGRAM_MIN_SCALE).toBe(0.25);
    });

    test('clamps to min scale', () => {
        const next = computeWheelScale(DIAGRAM_MIN_SCALE, 100000);
        expect(next).toBe(DIAGRAM_MIN_SCALE);
    });

    test('zero delta leaves scale unchanged', () => {
        // Math.exp(0) === 1, so the scale is returned exactly.
        expect(computeWheelScale(1.5, 0)).toBe(1.5);
    });

    test('ctrlKey pinch step (0.02) zooms faster than default step for same deltaY', () => {
        // Proves the trackpad-pinch path (ctrlKey=true) produces a larger scale change.
        const defaultScale = computeWheelScale(1, -100);
        const pinchScale = computeWheelScale(1, -100, { step: 0.02 });
        // Both zoom in (scale > 1), but pinch step yields a bigger result.
        expect(pinchScale).toBeGreaterThan(defaultScale);
        expect(pinchScale).toBeGreaterThan(1);
    });

    test('ctrlKey pinch step also clamps to max scale for extreme deltaY', () => {
        expect(computeWheelScale(1, -100000, { step: 0.02 })).toBe(DIAGRAM_MAX_SCALE);
    });

    test('ctrlKey pinch step also clamps to min scale for extreme positive deltaY', () => {
        expect(computeWheelScale(1, 100000, { step: 0.02 })).toBe(DIAGRAM_MIN_SCALE);
    });
});

describe('computePinchScale', () => {
    test('spreading fingers (ratio > 1) zooms in', () => {
        expect(computePinchScale(1, 2)).toBe(2);
    });

    test('pinching fingers (ratio < 1) zooms out', () => {
        expect(computePinchScale(2, 0.5)).toBe(1);
    });

    test('clamps to max', () => {
        expect(computePinchScale(4, 100)).toBe(DIAGRAM_MAX_SCALE);
    });

    test('invalid ratio falls back to clamped base', () => {
        expect(computePinchScale(2, 0)).toBe(2);
        expect(computePinchScale(2, Number.NaN)).toBe(2);
    });
});

describe('pointerDistance', () => {
    test('computes euclidean distance', () => {
        expect(pointerDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    });
});

describe('computeFitScale', () => {
    test('square fit: content smaller than viewport scales up to fill', () => {
        // min(1200/800, 900/600) = min(1.5, 1.5) = 1.5
        expect(computeFitScale(800, 600, 1200, 900)).toBe(1.5);
    });

    test('wide content: limiting axis (width) drives the fit scale', () => {
        // min(1000/2000, 900/600) = min(0.5, 1.5) = 0.5
        expect(computeFitScale(2000, 600, 1000, 900)).toBe(0.5);
    });

    test('small content scales up by the tighter axis', () => {
        // min(1200/400, 900/300) = min(3, 3) = 3
        expect(computeFitScale(400, 300, 1200, 900)).toBe(3);
    });

    test('clamps to DIAGRAM_MAX_SCALE when fit exceeds the ceiling', () => {
        // min(10000/10, 10000/10) = 1000 -> clamped to 8
        expect(computeFitScale(10, 10, 10000, 10000)).toBe(DIAGRAM_MAX_SCALE);
        expect(DIAGRAM_MAX_SCALE).toBe(8);
    });

    test('clamps to DIAGRAM_MIN_SCALE when fit falls below the floor', () => {
        // min(100/5000, 100/5000) = 0.02 -> clamped to 0.25
        expect(computeFitScale(5000, 5000, 100, 100)).toBe(DIAGRAM_MIN_SCALE);
        expect(DIAGRAM_MIN_SCALE).toBe(0.25);
    });

    test('zero content dimension returns safe fallback 1 (no division-by-zero)', () => {
        expect(computeFitScale(0, 600, 1200, 900)).toBe(1);
    });

    test('NaN content dimension returns safe fallback 1', () => {
        expect(computeFitScale(Number.NaN, 600, 1200, 900)).toBe(1);
    });

    test('Infinity viewport dimension returns safe fallback 1', () => {
        expect(computeFitScale(800, 600, Number.POSITIVE_INFINITY, 900)).toBe(1);
    });

    test('never emits 0, Infinity, or NaN for invalid inputs', () => {
        for (const result of [
            computeFitScale(0, 600, 1200, 900),
            computeFitScale(800, -1, 1200, 900),
            computeFitScale(800, 600, Number.NaN, 900),
            computeFitScale(800, 600, 1200, Number.POSITIVE_INFINITY),
        ]) {
            expect(Number.isFinite(result)).toBe(true);
            expect(result).toBe(1);
        }
    });
});

describe('isContentPannable', () => {
    test('content within viewport on both axes is not pannable', () => {
        expect(isContentPannable(500, 400, 1200, 900)).toBe(false);
    });

    test('overflow on width axis is pannable', () => {
        expect(isContentPannable(1400, 400, 1200, 900)).toBe(true);
    });

    test('overflow on height axis is pannable', () => {
        expect(isContentPannable(500, 1000, 1200, 900)).toBe(true);
    });

    test('exact-equal size is not pannable (strictly greater required)', () => {
        expect(isContentPannable(1200, 900, 1200, 900)).toBe(false);
    });
});

describe('zoomAboutPoint', () => {
    const EPS = 1e-9;

    /** Screen position of content-local point q under translate(offset) scale(s), origin=center. */
    const screenOf = (
        q: { x: number; y: number },
        offset: { x: number; y: number },
        scale: number,
        center: { x: number; y: number },
    ): { x: number; y: number } => ({
        x: center.x + offset.x + scale * q.x,
        y: center.y + offset.y + scale * q.y,
    });

    /** Content-local point currently under the cursor for a given view. */
    const pointUnderCursor = (
        cursor: { x: number; y: number },
        offset: { x: number; y: number },
        scale: number,
        center: { x: number; y: number },
    ): { x: number; y: number } => ({
        x: (cursor.x - center.x - offset.x) / scale,
        y: (cursor.y - center.y - offset.y) / scale,
    });

    test('content point under the cursor stays fixed on screen after zooming in', () => {
        const center = { x: 300, y: 200 };
        const offset = { x: 50, y: -20 };
        const scale = 1;
        const cursor = { x: 450, y: 260 };
        const nextScale = 2;

        const q = pointUnderCursor(cursor, offset, scale, center);
        const nextOffset = zoomAboutPoint(offset, scale, nextScale, cursor, center);

        // Exact focal-formula values: offset*r + d*(1-r), r=2, d={150,60}.
        expect(nextOffset.x).toBe(-50);
        expect(nextOffset.y).toBe(-100);

        // The SAME content point q now paints back under the cursor.
        const after = screenOf(q, nextOffset, nextScale, center);
        expect(Math.abs(after.x - cursor.x)).toBeLessThan(EPS);
        expect(Math.abs(after.y - cursor.y)).toBeLessThan(EPS);
    });

    test('content point under the cursor stays fixed on screen after zooming out', () => {
        const center = { x: 300, y: 200 };
        const offset = { x: -40, y: 30 };
        const scale = 2;
        const cursor = { x: 380, y: 150 };
        const nextScale = 0.75;

        const q = pointUnderCursor(cursor, offset, scale, center);
        const nextOffset = zoomAboutPoint(offset, scale, nextScale, cursor, center);
        const after = screenOf(q, nextOffset, nextScale, center);

        expect(Math.abs(after.x - cursor.x)).toBeLessThan(EPS);
        expect(Math.abs(after.y - cursor.y)).toBeLessThan(EPS);
    });

    test('at the MAX-scale clamp bound the CLAMPED scale is used (focal point uses 8, not raw 16)', () => {
        const center = { x: 300, y: 200 };
        const offset = { x: 0, y: 0 };
        const scale = 4;
        const cursor = { x: 500, y: 300 };
        const rawNextScale = 16; // exceeds DIAGRAM_MAX_SCALE (8)
        const appliedScale = DIAGRAM_MAX_SCALE; // 8

        const q = pointUnderCursor(cursor, offset, scale, center);
        const nextOffset = zoomAboutPoint(offset, scale, rawNextScale, cursor, center);

        // r = clamped(16)/4 = 8/4 = 2, d = {200,100} => offset' = {-200,-100}.
        // (An unclamped r=16/4=4 would give {-600,-300}; asserting -200 fails that bug.)
        expect(nextOffset.x).toBe(-200);
        expect(nextOffset.y).toBe(-100);

        // Fixed point holds against the APPLIED (clamped) scale of 8.
        const after = screenOf(q, nextOffset, appliedScale, center);
        expect(Math.abs(after.x - cursor.x)).toBeLessThan(EPS);
        expect(Math.abs(after.y - cursor.y)).toBeLessThan(EPS);
    });

    test('at the MIN-scale clamp bound the CLAMPED scale is used (0.25, not raw 0.1)', () => {
        const center = { x: 300, y: 200 };
        const offset = { x: 0, y: 0 };
        const scale = 1;
        const cursor = { x: 400, y: 200 };
        const rawNextScale = 0.1; // below DIAGRAM_MIN_SCALE (0.25)
        const appliedScale = DIAGRAM_MIN_SCALE; // 0.25

        const q = pointUnderCursor(cursor, offset, scale, center);
        const nextOffset = zoomAboutPoint(offset, scale, rawNextScale, cursor, center);

        // r = 0.25/1 = 0.25, d = {100,0} => offset'.x = 100*(1-0.25) = 75.
        // (Unclamped r=0.1 would give 90; asserting 75 fails that bug.)
        expect(nextOffset.x).toBe(75);
        expect(nextOffset.y).toBe(0);

        const after = screenOf(q, nextOffset, appliedScale, center);
        expect(Math.abs(after.x - cursor.x)).toBeLessThan(EPS);
        expect(Math.abs(after.y - cursor.y)).toBeLessThan(EPS);
    });

    test('cursor at viewport center (d=0) scales the offset about the center', () => {
        const center = { x: 300, y: 200 };
        const offset = { x: 40, y: -30 };
        // cursor === center => d = 0 => offset' = offset * (s'/s).
        const nextOffset = zoomAboutPoint(offset, 1, 3, center, center);
        // r=3: {120,-90}. (A ratio inverted to s/s' would give offset/3 ~ {13.3,-10}.)
        expect(nextOffset.x).toBe(120);
        expect(nextOffset.y).toBe(-90);
    });

    test('scale == nextScale leaves the offset unchanged (ratio 1, no NaN)', () => {
        const offset = { x: 12, y: 34 };
        const nextOffset = zoomAboutPoint(offset, 2, 2, { x: 999, y: -999 }, { x: 0, y: 0 });
        expect(nextOffset.x).toBe(12);
        expect(nextOffset.y).toBe(34);
        expect(Number.isFinite(nextOffset.x)).toBe(true);
        expect(Number.isFinite(nextOffset.y)).toBe(true);
    });

    test('non-positive current scale returns the offset untouched (guard against NaN/Infinity)', () => {
        // Without the guard, ratio = clampedNext/0 = Infinity => offset*Infinity = NaN.
        const nextOffset = zoomAboutPoint({ x: 5, y: 6 }, 0, 2, { x: 1, y: 1 }, { x: 0, y: 0 });
        expect(nextOffset.x).toBe(5);
        expect(nextOffset.y).toBe(6);
        expect(Number.isFinite(nextOffset.x)).toBe(true);
        expect(Number.isFinite(nextOffset.y)).toBe(true);
    });
});
