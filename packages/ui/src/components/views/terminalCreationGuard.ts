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

export type RunTerminalSessionCreationDeps = {
    /** Stable creation key, typically `${directory}::${tabId}`. */
    key: string;
    /** Keys whose createSession call is currently in flight (mutated here). */
    inFlightSet: Set<string>;
    /** Existing terminal/session id for this tab; null/empty means none yet. */
    terminalId: string | null;
    /** Current tab lifecycle (e.g. 'idle' | 'running' | 'exited'). */
    lifecycle: string;
    /** Whether this tab is a project-action tab. */
    isActionTab: boolean;
    /** Whether buffered output already exists for this tab. */
    hasBufferedOutput: boolean;
    /** Directory the session is being created for. */
    directory: string;
    /** Tab id the session is being created for. */
    tabId: string;
    /** Live getter for the currently active directory (read after the await). */
    getCurrentDirectory: () => string | null;
    /** Live getter for the currently active tab id (read after the await). */
    getCurrentTabId: () => string | null;
    /** I/O boundary: create the upstream terminal session. */
    createSession: (opts: { cwd: string; cols?: number; rows?: number }) => Promise<{ sessionId: string }>;
    /** I/O boundary: close an orphaned upstream terminal session. */
    closeSession: (sessionId: string) => Promise<void>;
    /** Bind the created session to the store for the target dir+tab. */
    bindSession: (sessionId: string) => void;
    /** Optional initial column count. */
    cols?: number;
    /** Optional initial row count. */
    rows?: number;
};

export type RunTerminalSessionCreationResult = {
    /** Whether a createSession call was actually issued this run. */
    created: boolean;
    /** The created session id, or null when no creation started. */
    sessionId: string | null;
    /** Whether the created session was bound (kept) vs closed as an orphan. */
    kept: boolean;
};

/**
 * Orchestrates a single terminal session creation with storm-prevention and a
 * target-identity stick decision, using only injected collaborators so it can
 * be driven in tests without React/DOM.
 *
 * The entry guard (shouldStartTerminalCreation) and the in-flight add both run
 * synchronously before the first await, so a concurrent invocation sharing the
 * same inFlightSet + key is short-circuited (created:false) — createSession is
 * issued exactly once. The key is always released in the finally, even on throw.
 */
export const runTerminalSessionCreation = async (
    deps: RunTerminalSessionCreationDeps
): Promise<RunTerminalSessionCreationResult> => {
    const {
        key,
        inFlightSet,
        terminalId,
        lifecycle,
        isActionTab,
        hasBufferedOutput,
        directory,
        tabId,
        getCurrentDirectory,
        getCurrentTabId,
        createSession,
        closeSession,
        bindSession,
        cols,
        rows,
    } = deps;

    if (
        !shouldStartTerminalCreation({
            key,
            inFlightSet,
            terminalId,
            lifecycle,
            isActionTab,
            hasBufferedOutput,
        })
    ) {
        return { created: false, sessionId: null, kept: false };
    }

    inFlightSet.add(key);
    try {
        const session = await createSession({ cwd: directory, cols, rows });

        const kept = shouldKeepCreatedSession({
            currentDirectory: getCurrentDirectory(),
            currentTabId: getCurrentTabId(),
            targetDirectory: directory,
            targetTabId: tabId,
        });

        if (!kept) {
            try {
                await closeSession(session.sessionId);
            } catch { /* ignored */ }
            return { created: true, sessionId: session.sessionId, kept: false };
        }

        bindSession(session.sessionId);
        return { created: true, sessionId: session.sessionId, kept: true };
    } finally {
        inFlightSet.delete(key);
    }
};
