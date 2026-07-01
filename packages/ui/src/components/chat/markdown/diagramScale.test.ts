import { describe, expect, test } from 'bun:test';
import { DIAGRAM_SCALE_MAX, DIAGRAM_SCALE_MIN, scaleForBodyText } from './diagramScale';

describe('scaleForBodyText', () => {
  test('exact match returns 1.0', () => {
    expect(scaleForBodyText(14, 14)).toBe(1);
  });

  test('mid-range shrink is proportional (fails if ratio inverted)', () => {
    expect(scaleForBodyText(16, 14)).toBe(14 / 16);
  });

  test('mid-range enlarge is proportional', () => {
    expect(scaleForBodyText(12, 14)).toBe(14 / 12);
  });

  test('huge intrinsic clamps to min (fails if clamp missing)', () => {
    expect(scaleForBodyText(100, 14)).toBe(DIAGRAM_SCALE_MIN);
  });

  test('tiny intrinsic clamps to max (fails if clamp missing)', () => {
    expect(scaleForBodyText(4, 14)).toBe(DIAGRAM_SCALE_MAX);
  });

  test('ratio exactly at min bound is kept, not over-clamped', () => {
    expect(scaleForBodyText(20, 12)).toBe(DIAGRAM_SCALE_MIN);
  });

  test('ratio exactly at max bound is kept', () => {
    expect(scaleForBodyText(10, 14)).toBe(DIAGRAM_SCALE_MAX);
  });

  test('non-positive intrinsic is a no-op (returns 1, no divide-by-zero)', () => {
    expect(scaleForBodyText(0, 14)).toBe(1);
    expect(scaleForBodyText(-16, 14)).toBe(1);
  });

  test('non-positive target is a no-op', () => {
    expect(scaleForBodyText(16, 0)).toBe(1);
    expect(scaleForBodyText(16, -14)).toBe(1);
  });

  test('non-finite inputs are a no-op', () => {
    expect(scaleForBodyText(Number.NaN, 14)).toBe(1);
    expect(scaleForBodyText(16, Number.NaN)).toBe(1);
    expect(scaleForBodyText(Number.POSITIVE_INFINITY, 14)).toBe(1);
    expect(scaleForBodyText(16, Number.POSITIVE_INFINITY)).toBe(1);
  });

  test('clamp bounds are ordered and sane', () => {
    expect(DIAGRAM_SCALE_MIN).toBeLessThan(1);
    expect(DIAGRAM_SCALE_MAX).toBeGreaterThan(1);
  });
});
