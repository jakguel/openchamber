import { describe, expect, test } from 'bun:test';

import { computeScrollTop, createCommitSignal } from './scrollToHeading';

// Pure container-relative scroll arithmetic. Explicit numbers so a regression in
// the formula (e.g. dropping currentScrollTop, or swapping the operands) flips a
// specific assertion. Real DOM geometry is exercised in the T7 Chromium e2e.
describe('computeScrollTop', () => {
  test('target below the fold: adds the element-vs-scroller gap to current scrollTop', () => {
    // Scroller top at 100, element top at 340 → 240px below the scroller top.
    // From a current scroll of 500 → 500 + (340 - 100) = 740.
    expect(computeScrollTop(500, 340, 100)).toBe(740);
  });

  test('element aligned with scroller top: scrollTop unchanged', () => {
    expect(computeScrollTop(500, 100, 100)).toBe(500);
  });

  test('target above current position: subtracts the upward gap', () => {
    // Element 80px above the scroller top → 500 + (20 - 100) = 420.
    expect(computeScrollTop(500, 20, 100)).toBe(420);
  });

  test('clamps at zero (never negative scrollTop)', () => {
    // 10 + (0 - 100) = -90 → clamped to 0.
    expect(computeScrollTop(10, 0, 100)).toBe(0);
  });

  test('fresh scroller at top with a distant target', () => {
    expect(computeScrollTop(0, 1200, 0)).toBe(1200);
  });
});

// The click→scroll gate awaits ONE post-commit notification when the anchor id
// is not yet present. The bridge must resolve exactly the waiters outstanding at
// notify time and never resolve future waiters retroactively.
describe('createCommitSignal', () => {
  test('waitForCommit resolves on the next notify', async () => {
    const signal = createCommitSignal();
    let resolved = false;
    const pending = signal.waitForCommit().then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    signal.notify();
    await pending;
    expect(resolved).toBe(true);
  });

  test('a waiter registered after notify does not resolve on the earlier notify', async () => {
    const signal = createCommitSignal();
    signal.notify(); // no waiters yet — a no-op
    let resolved = false;
    const pending = signal.waitForCommit().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    signal.notify();
    await pending;
    expect(resolved).toBe(true);
  });
});
