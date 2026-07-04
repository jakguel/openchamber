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
    DIAGRAM_PAN_PADDING,
    clampPanOffset,
    computeFitScale,
    computePinchScale,
    computeWheelScale,
    isContentPannable,
    pointerDistance,
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

    test('diagram smaller than viewport still allows padding-sized nudge from center', () => {
        const clamped = clampPanOffset({
            offsetX: 99999,
            offsetY: 99999,
            scale: 1,
            contentWidth: 100,
            contentHeight: 100,
            viewportWidth: 600,
            viewportHeight: 400,
        });
        // scaled smaller than viewport => max offset is exactly the padding.
        expect(clamped.x).toBe(DIAGRAM_PAN_PADDING);
        expect(clamped.y).toBe(DIAGRAM_PAN_PADDING);
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

    test('custom padding is honored', () => {
        const clamped = clampPanOffset({
            offsetX: 99999,
            offsetY: 0,
            scale: 1,
            contentWidth: 100,
            contentHeight: 100,
            viewportWidth: 600,
            viewportHeight: 400,
            padding: 25,
        });
        expect(clamped.x).toBe(25);
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
