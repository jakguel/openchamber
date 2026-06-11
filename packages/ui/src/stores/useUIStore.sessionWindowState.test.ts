import { beforeEach, describe, expect, test } from 'bun:test';

import { useUIStore } from './useUIStore';

// The module-level sessionWindowStateBySession Map persists across tests.
// We use unique session IDs per test to avoid cross-test pollution.
// The Zustand store state is reset in beforeEach via setState.

const DEFAULT_STATE = {
  isBottomTerminalOpen: false,
  isBottomTerminalExpanded: false,
  activeMainTab: 'chat' as const,
};

const resetStoreState = () => {
  useUIStore.setState({
    isBottomTerminalOpen: false,
    isBottomTerminalExpanded: false,
    activeMainTab: 'chat',
  });
};

describe('SessionWindowState', () => {
  beforeEach(resetStoreState);

  describe('AC1 — round-trip preserves all 3 fields', () => {
    test('restores isBottomTerminalOpen, isBottomTerminalExpanded, and activeMainTab after prepare+restore', () => {
      const store = useUIStore.getState();

      // Set up a non-default state
      store.setBottomTerminalOpen(true);
      store.setBottomTerminalExpanded(true);
      store.setActiveMainTab('terminal');

      // Save state for session A
      useUIStore.getState().prepareForSessionSwitch('ses_ac1_round_trip');

      // Reset to defaults (simulates switching away)
      resetStoreState();

      // Verify defaults are in place
      expect(useUIStore.getState().isBottomTerminalOpen).toBe(false);
      expect(useUIStore.getState().isBottomTerminalExpanded).toBe(false);
      expect(useUIStore.getState().activeMainTab).toBe('chat');

      // Restore session A
      useUIStore.getState().restoreForSessionSwitch('ses_ac1_round_trip');

      // All 3 fields must be restored
      expect(useUIStore.getState().isBottomTerminalOpen).toBe(true);
      expect(useUIStore.getState().isBottomTerminalExpanded).toBe(true);
      expect(useUIStore.getState().activeMainTab).toBe('terminal');
    });

    test('preserves false/false/chat when those were the saved values', () => {
      // Ensure defaults are set
      resetStoreState();

      useUIStore.getState().prepareForSessionSwitch('ses_ac1_defaults');

      // Change to non-default
      useUIStore.getState().setBottomTerminalOpen(true);
      useUIStore.getState().setActiveMainTab('git');

      // Restore — should go back to false/false/chat
      useUIStore.getState().restoreForSessionSwitch('ses_ac1_defaults');

      expect(useUIStore.getState().isBottomTerminalOpen).toBe(false);
      expect(useUIStore.getState().isBottomTerminalExpanded).toBe(false);
      expect(useUIStore.getState().activeMainTab).toBe('chat');
    });
  });

  describe('AC2 — unknown session applies DEFAULT', () => {
    test('applies default state when sessionId has no saved entry', () => {
      // Set non-default state first
      useUIStore.getState().setBottomTerminalOpen(true);
      useUIStore.getState().setBottomTerminalExpanded(true);
      useUIStore.getState().setActiveMainTab('files');

      // Restore for a session that was never saved
      useUIStore.getState().restoreForSessionSwitch('ses_ac2_never_saved');

      expect(useUIStore.getState().isBottomTerminalOpen).toBe(DEFAULT_STATE.isBottomTerminalOpen);
      expect(useUIStore.getState().isBottomTerminalExpanded).toBe(DEFAULT_STATE.isBottomTerminalExpanded);
      expect(useUIStore.getState().activeMainTab).toBe(DEFAULT_STATE.activeMainTab);
    });

    test('applies default state when sessionId is null', () => {
      useUIStore.getState().setBottomTerminalOpen(true);
      useUIStore.getState().setActiveMainTab('plan');

      useUIStore.getState().restoreForSessionSwitch(null);

      expect(useUIStore.getState().isBottomTerminalOpen).toBe(false);
      expect(useUIStore.getState().isBottomTerminalExpanded).toBe(false);
      expect(useUIStore.getState().activeMainTab).toBe('chat');
    });
  });

  describe('AC3 — multi-session isolation', () => {
    test('restoring session A returns A values, not B values', () => {
      // Save session A: terminal open, tab=terminal
      useUIStore.getState().setBottomTerminalOpen(true);
      useUIStore.getState().setBottomTerminalExpanded(false);
      useUIStore.getState().setActiveMainTab('terminal');
      useUIStore.getState().prepareForSessionSwitch('ses_ac3_a');

      // Save session B: terminal closed, tab=chat
      useUIStore.getState().setBottomTerminalOpen(false);
      useUIStore.getState().setBottomTerminalExpanded(false);
      useUIStore.getState().setActiveMainTab('chat');
      useUIStore.getState().prepareForSessionSwitch('ses_ac3_b');

      // Restore A — must get A's values
      useUIStore.getState().restoreForSessionSwitch('ses_ac3_a');

      expect(useUIStore.getState().isBottomTerminalOpen).toBe(true);
      expect(useUIStore.getState().isBottomTerminalExpanded).toBe(false);
      expect(useUIStore.getState().activeMainTab).toBe('terminal');
    });

    test('restoring session B returns B values, not A values', () => {
      // Save session A: terminal open, expanded, tab=files
      useUIStore.getState().setBottomTerminalOpen(true);
      useUIStore.getState().setBottomTerminalExpanded(true);
      useUIStore.getState().setActiveMainTab('files');
      useUIStore.getState().prepareForSessionSwitch('ses_ac3_iso_a');

      // Save session B: terminal closed, tab=git
      useUIStore.getState().setBottomTerminalOpen(false);
      useUIStore.getState().setBottomTerminalExpanded(false);
      useUIStore.getState().setActiveMainTab('git');
      useUIStore.getState().prepareForSessionSwitch('ses_ac3_iso_b');

      // Restore B — must get B's values
      useUIStore.getState().restoreForSessionSwitch('ses_ac3_iso_b');

      expect(useUIStore.getState().isBottomTerminalOpen).toBe(false);
      expect(useUIStore.getState().isBottomTerminalExpanded).toBe(false);
      expect(useUIStore.getState().activeMainTab).toBe('git');
    });

    test('sessions do not overwrite each other when saved sequentially', () => {
      // Save A
      useUIStore.getState().setBottomTerminalOpen(true);
      useUIStore.getState().setActiveMainTab('context');
      useUIStore.getState().prepareForSessionSwitch('ses_ac3_seq_a');

      // Save B (different values)
      useUIStore.getState().setBottomTerminalOpen(false);
      useUIStore.getState().setActiveMainTab('diagram');
      useUIStore.getState().prepareForSessionSwitch('ses_ac3_seq_b');

      // Restore A — must still have A's values
      useUIStore.getState().restoreForSessionSwitch('ses_ac3_seq_a');
      expect(useUIStore.getState().isBottomTerminalOpen).toBe(true);
      expect(useUIStore.getState().activeMainTab).toBe('context');

      // Restore B — must have B's values
      useUIStore.getState().restoreForSessionSwitch('ses_ac3_seq_b');
      expect(useUIStore.getState().isBottomTerminalOpen).toBe(false);
      expect(useUIStore.getState().activeMainTab).toBe('diagram');
    });
  });

  describe('AC4 — serialization round-trip', () => {
    test('partialize includes sessionWindowStates entry after prepareForSessionSwitch', () => {
      useUIStore.getState().setBottomTerminalOpen(true);
      useUIStore.getState().setBottomTerminalExpanded(true);
      useUIStore.getState().setActiveMainTab('terminal');

      useUIStore.getState().prepareForSessionSwitch('ses_ac4_serial');

      // Access the partialize function via the persist API
      const { partialize } = useUIStore.persist.getOptions();
      if (!partialize) throw new Error('partialize not configured on useUIStore');

      const partializedState = partialize(useUIStore.getState());

      // sessionWindowStates is an array of [sessionId, SessionWindowState] tuples
      const sessionWindowStates = (partializedState as { sessionWindowStates?: unknown }).sessionWindowStates;
      expect(Array.isArray(sessionWindowStates)).toBe(true);

      const entries = sessionWindowStates as Array<[string, unknown]>;
      const entry = entries.find(([id]) => id === 'ses_ac4_serial');
      expect(entry).not.toBeNull();
      expect(entry != null).toBe(true);
      expect(entry?.[1]).toEqual({
        isBottomTerminalOpen: true,
        isBottomTerminalExpanded: true,
        activeMainTab: 'terminal',
      });
    });

    test('onRehydrateStorage callback repopulates the Map from serialized sessionWindowStates', () => {
      // Step 1: Set TARGET values and save to the module-level Map
      useUIStore.getState().setBottomTerminalOpen(true);
      useUIStore.getState().setBottomTerminalExpanded(false);
      useUIStore.getState().setActiveMainTab('plan');
      useUIStore.getState().prepareForSessionSwitch('ses_ac4_rehydrate');

      // Step 2: Capture the TARGET values via partialize
      const { partialize, onRehydrateStorage } = useUIStore.persist.getOptions();
      if (!partialize) throw new Error('partialize not configured on useUIStore');
      if (!onRehydrateStorage) throw new Error('onRehydrateStorage not configured on useUIStore');

      const partializedState = partialize(useUIStore.getState());
      const serializedStates = (partializedState as { sessionWindowStates?: unknown }).sessionWindowStates;

      // Step 3: Overwrite the Map entry with OPPOSITE values (false/true/chat).
      // This is the key step: if onRehydrateStorage is broken, restoreForSessionSwitch
      // would return these overwritten values and the assertions would fail.
      useUIStore.getState().setBottomTerminalOpen(false);
      useUIStore.getState().setBottomTerminalExpanded(true);
      useUIStore.getState().setActiveMainTab('chat');
      useUIStore.getState().prepareForSessionSwitch('ses_ac4_rehydrate');

      // Step 4: Reset Zustand store state to defaults
      resetStoreState();

      // Step 5: Simulate rehydration by calling onRehydrateStorage directly
      // (persist.rehydrate() uses a synchronous pseudo-thenable that doesn't play
      // well with native await in tests; calling the callback directly is equivalent
      // and tests the actual rehydrateSessionWindowStates code path).
      const postRehydrationCallback = onRehydrateStorage(useUIStore.getState());
      if (postRehydrationCallback) {
        // Pass a fake state that contains the serialized sessionWindowStates from storage
        postRehydrationCallback(
          { sessionWindowStates: serializedStates } as unknown as Parameters<typeof postRehydrationCallback>[0],
          undefined,
        );
      }

      // Step 6: Restore — must return TARGET values (true/false/plan),
      // NOT the overwritten values (false/true/chat).
      // This proves onRehydrateStorage correctly called rehydrateSessionWindowStates.
      useUIStore.getState().restoreForSessionSwitch('ses_ac4_rehydrate');

      expect(useUIStore.getState().isBottomTerminalOpen).toBe(true);
      expect(useUIStore.getState().isBottomTerminalExpanded).toBe(false);
      expect(useUIStore.getState().activeMainTab).toBe('plan');
    });
  });

  describe('prepareForSessionSwitch with null sessionId', () => {
    test('does nothing when sessionId is null', () => {
      useUIStore.getState().setBottomTerminalOpen(true);
      useUIStore.getState().setActiveMainTab('git');

      // null sessionId should be a no-op
      useUIStore.getState().prepareForSessionSwitch(null);

      // State should remain unchanged
      expect(useUIStore.getState().isBottomTerminalOpen).toBe(true);
      expect(useUIStore.getState().activeMainTab).toBe('git');
    });
  });
});
