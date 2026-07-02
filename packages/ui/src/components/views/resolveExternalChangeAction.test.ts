import { describe, expect, test } from 'bun:test';
import {
  hasExternalStatChange,
  resolveExternalChangeAction,
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
