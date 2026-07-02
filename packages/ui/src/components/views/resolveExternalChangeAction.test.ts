import { describe, expect, test } from 'bun:test';
import {
  hasExternalStatChange,
  resolveExternalChangeAction,
  runGuardedWrite,
  shouldSurfaceConflict,
  type ExternalChangeStat,
} from './resolveExternalChangeAction';

const loaded: ExternalChangeStat = { path: '/a.txt', size: 100, mtimeMs: 1000 };

describe('resolveExternalChangeAction', () => {
  test('returns write when the on-disk stat is unchanged', () => {
    expect(
      resolveExternalChangeAction({
        currentStat: { path: '/a.txt', size: 100, mtimeMs: 1000 },
        loadedStat: loaded,
        isDirty: false,
      }),
    ).toBe('write');
  });

  test('returns write for an unchanged stat even with unsaved edits (normal save)', () => {
    expect(
      resolveExternalChangeAction({
        currentStat: { path: '/a.txt', size: 100, mtimeMs: 1000 },
        loadedStat: loaded,
        isDirty: true,
      }),
    ).toBe('write');
  });

  test('returns refuse-safe-path when the disk changed and the user has unsaved edits', () => {
    expect(
      resolveExternalChangeAction({
        currentStat: { path: '/a.txt', size: 100, mtimeMs: 2000 },
        loadedStat: loaded,
        isDirty: true,
      }),
    ).toBe('refuse-safe-path');
  });

  test('returns live-apply for a pure external change (size differs, no unsaved edits)', () => {
    expect(
      resolveExternalChangeAction({
        currentStat: { path: '/a.txt', size: 250, mtimeMs: 1000 },
        loadedStat: loaded,
        isDirty: false,
      }),
    ).toBe('live-apply');
  });

  test('returns write when either stat is missing (no positive evidence of a conflict)', () => {
    expect(
      resolveExternalChangeAction({ currentStat: null, loadedStat: loaded, isDirty: true }),
    ).toBe('write');
    expect(
      resolveExternalChangeAction({ currentStat: loaded, loadedStat: null, isDirty: true }),
    ).toBe('write');
  });

  test('returns write when the stat describes a different file identity', () => {
    expect(
      resolveExternalChangeAction({
        currentStat: { path: '/b.txt', size: 9999, mtimeMs: 9999 },
        loadedStat: loaded,
        isDirty: true,
      }),
    ).toBe('write');
  });
});

describe('hasExternalStatChange', () => {
  test('detects an mtime-only change', () => {
    expect(
      hasExternalStatChange({ path: '/a.txt', size: 100, mtimeMs: 2000 }, loaded),
    ).toBe(true);
  });

  test('detects a size-only change', () => {
    expect(
      hasExternalStatChange({ path: '/a.txt', size: 101, mtimeMs: 1000 }, loaded),
    ).toBe(true);
  });

  test('reports no change when size and mtime match', () => {
    expect(
      hasExternalStatChange({ path: '/a.txt', size: 100, mtimeMs: 1000 }, loaded),
    ).toBe(false);
  });
});

describe('shouldSurfaceConflict (poll anti-spam)', () => {
  test('surfaces when nothing has been surfaced yet', () => {
    expect(shouldSurfaceConflict({ path: '/a.txt', size: 200, mtimeMs: 2000 }, null)).toBe(true);
  });

  test('does NOT re-surface the same already-surfaced stat', () => {
    const surfaced: ExternalChangeStat = { path: '/a.txt', size: 200, mtimeMs: 2000 };
    expect(shouldSurfaceConflict({ path: '/a.txt', size: 200, mtimeMs: 2000 }, surfaced)).toBe(false);
  });

  test('re-surfaces when the on-disk stat changes again', () => {
    const surfaced: ExternalChangeStat = { path: '/a.txt', size: 200, mtimeMs: 2000 };
    expect(shouldSurfaceConflict({ path: '/a.txt', size: 300, mtimeMs: 3000 }, surfaced)).toBe(true);
  });
});

type WiringSpies = {
  writeCalls: number;
  refuseCalls: number;
  statReads: number;
  // Asserts the read-before-decide sequence, not just final call counts.
  order: Array<'stat' | 'refuse' | 'write'>;
};

const makeWiring = (overrides: {
  forceOverwrite: boolean;
  isDirty: boolean;
  currentStat: ExternalChangeStat;
}) => {
  const spies: WiringSpies = { writeCalls: 0, refuseCalls: 0, statReads: 0, order: [] };
  const run = () =>
    runGuardedWrite({
      forceOverwrite: overrides.forceOverwrite,
      isDirty: overrides.isDirty,
      loadedStat: loaded,
      readCurrentStat: async () => {
        spies.statReads += 1;
        spies.order.push('stat');
        return overrides.currentStat;
      },
      onRefuse: () => {
        spies.refuseCalls += 1;
        spies.order.push('refuse');
      },
      write: async () => {
        spies.writeCalls += 1;
        spies.order.push('write');
        return true;
      },
    });
  return { spies, run };
};

describe('runGuardedWrite (saveDraft write-refusal wiring)', () => {
  test('refuses the write and opens the dialog on a dirty external conflict', async () => {
    const { spies, run } = makeWiring({
      forceOverwrite: false,
      isDirty: true,
      currentStat: { path: '/a.txt', size: 250, mtimeMs: 5000 },
    });

    const result = await run();

    expect(result).toBe(false);
    expect(spies.writeCalls).toBe(0);
    expect(spies.refuseCalls).toBe(1);
    expect(spies.statReads).toBe(1);
    expect(spies.order).toEqual(['stat', 'refuse']);
  });

  test('proceeds with the write when the on-disk stat is unchanged', async () => {
    const { spies, run } = makeWiring({
      forceOverwrite: false,
      isDirty: true,
      currentStat: { path: '/a.txt', size: 100, mtimeMs: 1000 },
    });

    const result = await run();

    expect(result).toBe(true);
    expect(spies.writeCalls).toBe(1);
    expect(spies.refuseCalls).toBe(0);
    expect(spies.statReads).toBe(1);
    expect(spies.order).toEqual(['stat', 'write']);
  });

  test('forceOverwrite writes without a stat check (explicit overwrite from the dialog)', async () => {
    const { spies, run } = makeWiring({
      forceOverwrite: true,
      isDirty: true,
      currentStat: { path: '/a.txt', size: 999, mtimeMs: 9000 },
    });

    const result = await run();

    expect(result).toBe(true);
    expect(spies.statReads).toBe(0);
    expect(spies.writeCalls).toBe(1);
    expect(spies.refuseCalls).toBe(0);
    expect(spies.order).toEqual(['write']);
  });
});
