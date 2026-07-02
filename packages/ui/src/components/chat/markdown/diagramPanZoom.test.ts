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
    computePinchScale,
    computeWheelScale,
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

    test('clamps to min scale', () => {
        const next = computeWheelScale(DIAGRAM_MIN_SCALE, 100000);
        expect(next).toBe(DIAGRAM_MIN_SCALE);
    });

    test('zero delta leaves scale unchanged', () => {
        // Math.exp(0) === 1, so the scale is returned exactly.
        expect(computeWheelScale(1.5, 0)).toBe(1.5);
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
