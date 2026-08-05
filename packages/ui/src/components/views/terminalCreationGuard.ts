// Pure, framework-free concurrency helpers for terminal session creation.
// Extracted from TerminalView.ensureSession so the storm-prevention and
// stick-vs-close decisions can be unit-tested without React/DOM.

export type ShouldStartTerminalCreationParams = {
    /** Stable creation key, typically `${directory}::${tabId}`. */
    key: string;
    /** Keys whose createSession call is currently in flight. */
    inFlightSet: Set<string>;
    /** Existing terminal/session id for this tab; null/empty means none yet. */
    terminalId: string | null;
    /** Current tab lifecycle (e.g. 'idle' | 'running' | 'exited'). */
    lifecycle: string;
    /** Whether this tab is a project-action tab. */
    isActionTab: boolean;
    /** Whether buffered output already exists for this tab. */
    hasBufferedOutput: boolean;
};

/**
 * Decide whether a terminal creation should start for this run.
 * Returns true ONLY when there is no existing session, no in-flight creation
 * for this key, the tab has not exited, and we are not re-creating an action
 * tab that already has buffered output. Any other case returns false.
 */
export const shouldStartTerminalCreation = (
    params: ShouldStartTerminalCreationParams
): boolean => {
    const { key, inFlightSet, terminalId, lifecycle, isActionTab, hasBufferedOutput } = params;
    if (terminalId) {
        return false;
    }
    if (inFlightSet.has(key)) {
        return false;
    }
    if (lifecycle === 'exited') {
        return false;
    }
    if (isActionTab && hasBufferedOutput) {
        return false;
    }
    return true;
};

export type ShouldKeepCreatedSessionParams = {
    /** The currently active directory at decision time. */
    currentDirectory: string | null;
    /** The currently active tab id at decision time. */
    currentTabId: string | null;
    /** The directory the just-created session was created for. */
    targetDirectory: string;
    /** The tab id the just-created session was created for. */
    targetTabId: string;
};

/**
 * Decide whether a freshly created session should be kept (bound) or closed.
 * Purely target-identity based: keep IFF the created session's directory and
 * tab still match the current active target. No per-run `cancelled` coupling.
 */
export const shouldKeepCreatedSession = (
    params: ShouldKeepCreatedSessionParams
): boolean => {
    const { currentDirectory, currentTabId, targetDirectory, targetTabId } = params;
    return targetDirectory === currentDirectory && targetTabId === currentTabId;
};
