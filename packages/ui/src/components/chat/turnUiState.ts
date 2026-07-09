// Per-turn expand/collapse UI state for MessageList, keyed by turnId.
//
// The chat viewport no longer remounts on session switch (ChatContainer stopped
// keying <ChatViewport> on the session id, to kill the Firefox remount-flash),
// so this map is no longer cleared by an unmount. MessageList's reset effect,
// keyed on [activityRenderMode, sessionKey], is now the SOLE guard against
// session A's expand/collapse state bleeding into session B. These pure helpers
// own that create/reset/toggle/read semantics so the no-bleed invariant is
// unit-testable without a DOM (this package ships no jsdom/RTL).

export type TurnUiState = { isExpanded: boolean };

export function createTurnUiStates(): Map<string, TurnUiState> {
    return new Map<string, TurnUiState>();
}

export function resolveTurnUiState(
    states: Map<string, TurnUiState>,
    turnId: string,
    defaultExpanded: boolean,
): TurnUiState {
    return states.get(turnId) ?? { isExpanded: defaultExpanded };
}

export function toggleTurnUiState(
    previous: Map<string, TurnUiState>,
    turnId: string,
    defaultExpanded: boolean,
): Map<string, TurnUiState> {
    const next = new Map(previous);
    const current = next.get(turnId) ?? { isExpanded: defaultExpanded };
    next.set(turnId, { isExpanded: !current.isExpanded });
    return next;
}
