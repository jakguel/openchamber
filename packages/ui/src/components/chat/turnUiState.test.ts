import { describe, expect, test } from 'bun:test';

import { createTurnUiStates, resolveTurnUiState, toggleTurnUiState } from './turnUiState';

// Regression guard for the Firefox session-switch flicker fix: <ChatViewport> no
// longer remounts on session switch, so the per-turn expand/collapse map is no
// longer wiped by an unmount. MessageList's reset effect ([activityRenderMode,
// sessionKey]) now calls createTurnUiStates() on switch — these helpers are the
// exact code that runs. This suite proves the no-bleed invariant that guarantees
// once the reset fires, session A's expand/collapse state cannot survive into B.
// (The effect actually firing on switch is covered by the real-browser e2e —
// this package ships no jsdom/RTL, mirroring TocTree.test.tsx.)

describe('turnUiState — session-switch no-bleed', () => {
    test('expanded state from session A does not survive the reset into session B', () => {
        const defaultExpanded = false; // activityRenderMode !== 'summary'
        let states = createTurnUiStates();

        states = toggleTurnUiState(states, 'turn-A1', defaultExpanded);
        expect(resolveTurnUiState(states, 'turn-A1', defaultExpanded).isExpanded).toBe(true);

        // Session switch A -> B: reset effect installs a fresh empty map.
        states = createTurnUiStates();
        expect(resolveTurnUiState(states, 'turn-A1', defaultExpanded).isExpanded).toBe(false);
    });

    test('a turnId reused across sessions falls back to the default after reset (no carry-over)', () => {
        const defaultExpanded = false;
        let states = createTurnUiStates();

        states = toggleTurnUiState(states, 'shared-turn', defaultExpanded);
        expect(resolveTurnUiState(states, 'shared-turn', defaultExpanded).isExpanded).toBe(true);

        states = createTurnUiStates();
        expect(resolveTurnUiState(states, 'shared-turn', defaultExpanded).isExpanded).toBe(false);
    });

    test('collapsed override in summary mode also clears on switch (bleed guard both directions)', () => {
        const defaultExpanded = true; // activityRenderMode === 'summary'
        let states = createTurnUiStates();

        states = toggleTurnUiState(states, 'turn-A1', defaultExpanded);
        expect(resolveTurnUiState(states, 'turn-A1', defaultExpanded).isExpanded).toBe(false);

        states = createTurnUiStates();
        expect(resolveTurnUiState(states, 'turn-A1', defaultExpanded).isExpanded).toBe(true);
    });

    test('toggle and create return NEW maps (referential-equality discipline on the hot path)', () => {
        const initial = createTurnUiStates();
        const toggled = toggleTurnUiState(initial, 'turn-1', false);
        expect(toggled).not.toBe(initial);
        expect(initial.has('turn-1')).toBe(false);
        expect(createTurnUiStates()).not.toBe(initial);

        const toggledAgain = toggleTurnUiState(toggled, 'turn-1', false);
        expect(toggledAgain).not.toBe(toggled);
        expect(resolveTurnUiState(toggledAgain, 'turn-1', false).isExpanded).toBe(false);
    });
});
