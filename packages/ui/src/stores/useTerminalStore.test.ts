import { beforeEach, describe, expect, test } from 'bun:test';

import { useTerminalStore } from './useTerminalStore';

const DIR_A = '/projects/alpha';
const DIR_B = '/projects/beta';

const resetStore = () => {
  useTerminalStore.getState().clearAll();
};

describe('useTerminalStore buffer isolation', () => {
  beforeEach(resetStore);

  test('buffer chunks for one directory never leak into another directory', () => {
    const store = useTerminalStore.getState();

    store.ensureDirectory(DIR_A);
    store.ensureDirectory(DIR_B);

    const tabA = useTerminalStore.getState().getActiveTab(DIR_A)?.id;
    const tabB = useTerminalStore.getState().getActiveTab(DIR_B)?.id;
    expect(tabA).toBeTruthy();
    expect(tabB).toBeTruthy();

    // Output written for directory A's tab.
    store.appendToBuffer(DIR_A, tabA as string, '\u001b[31mhello-A\u001b[0m');

    const afterA = useTerminalStore.getState();
    const dirAChunks = afterA.getActiveTab(DIR_A)?.bufferChunks ?? [];
    const dirBChunks = afterA.getActiveTab(DIR_B)?.bufferChunks ?? [];

    // Directory A holds exactly its own chunk; directory B is untouched.
    expect(dirAChunks.map((c) => c.data)).toEqual(['\u001b[31mhello-A\u001b[0m']);
    expect(dirBChunks).toEqual([]);

    // Now write to directory B; it must not see A's data and vice versa.
    store.appendToBuffer(DIR_B, tabB as string, 'output-B');

    const afterB = useTerminalStore.getState();
    expect((afterB.getActiveTab(DIR_A)?.bufferChunks ?? []).map((c) => c.data)).toEqual([
      '\u001b[31mhello-A\u001b[0m',
    ]);
    expect((afterB.getActiveTab(DIR_B)?.bufferChunks ?? []).map((c) => c.data)).toEqual([
      'output-B',
    ]);
  });

  test('setTabSessionId resets the buffer when the terminal session id changes', () => {
    const store = useTerminalStore.getState();

    store.ensureDirectory(DIR_A);
    const tabA = useTerminalStore.getState().getActiveTab(DIR_A)?.id as string;

    // First live session produces buffered output (with ANSI color sequences).
    store.setTabSessionId(DIR_A, tabA, 'session-1');
    store.appendToBuffer(DIR_A, tabA, '\u001b[32msession-1-output\u001b[0m');

    expect((useTerminalStore.getState().getActiveTab(DIR_A)?.bufferChunks ?? []).length).toBe(1);

    // Session exits: id cleared, but buffer is intentionally retained for replay.
    store.setTabSessionId(DIR_A, tabA, null);
    expect((useTerminalStore.getState().getActiveTab(DIR_A)?.bufferChunks ?? []).map((c) => c.data)).toEqual([
      '\u001b[32msession-1-output\u001b[0m',
    ]);

    // A NEW session is bound to the same tab: the stale session-1 chunks must
    // be cleared so they cannot bleed into the new session id's viewport.
    store.setTabSessionId(DIR_A, tabA, 'session-2');
    const afterRebind = useTerminalStore.getState().getActiveTab(DIR_A);
    expect(afterRebind?.terminalSessionId).toBe('session-2');
    expect(afterRebind?.bufferChunks ?? []).toEqual([]);
    expect(afterRebind?.bufferLength ?? -1).toBe(0);
  });

  test('setTabSessionId with the same session id keeps the buffer intact', () => {
    const store = useTerminalStore.getState();

    store.ensureDirectory(DIR_A);
    const tabA = useTerminalStore.getState().getActiveTab(DIR_A)?.id as string;

    store.setTabSessionId(DIR_A, tabA, 'session-1');
    store.appendToBuffer(DIR_A, tabA, 'persisted');

    // Re-asserting the same session id must NOT wipe the live buffer.
    store.setTabSessionId(DIR_A, tabA, 'session-1');
    expect((useTerminalStore.getState().getActiveTab(DIR_A)?.bufferChunks ?? []).map((c) => c.data)).toEqual([
      'persisted',
    ]);
  });

  test('chunk ids are globally monotonic so cross-session ids never collide', () => {
    const store = useTerminalStore.getState();

    store.ensureDirectory(DIR_A);
    store.ensureDirectory(DIR_B);
    const tabA = useTerminalStore.getState().getActiveTab(DIR_A)?.id as string;
    const tabB = useTerminalStore.getState().getActiveTab(DIR_B)?.id as string;

    store.appendToBuffer(DIR_A, tabA, 'a1');
    store.appendToBuffer(DIR_B, tabB, 'b1');
    store.appendToBuffer(DIR_A, tabA, 'a2');

    const idA = (useTerminalStore.getState().getActiveTab(DIR_A)?.bufferChunks ?? []).map((c) => c.id);
    const idB = (useTerminalStore.getState().getActiveTab(DIR_B)?.bufferChunks ?? []).map((c) => c.id);

    // Every chunk id across both directories is unique and strictly increasing,
    // which is what lets the viewport's id-based replay marker stay session-safe.
    const all = [...idA, ...idB];
    expect(new Set(all).size).toBe(all.length);
    expect(idA[0]).toBeLessThan(idB[0]);
    expect(idB[0]).toBeLessThan(idA[1]);
  });
});
