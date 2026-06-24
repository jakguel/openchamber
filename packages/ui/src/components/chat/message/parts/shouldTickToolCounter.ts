/**
 * Pure gate for the LiveDuration tool counter tick.
 *
 * The counter only advances while the tool is genuinely in flight AND the
 * runtime connection is live. Gating on `isConnected` pauses the visual tick
 * the moment the connection drops (e.g. the OpenCode server dies mid-execution)
 * and auto-resumes it on reconnect for tools that have not yet finalized.
 *
 * Extracted to its own module so it can be unit-tested as a pure function:
 * importing ToolPart.tsx in the test runner is not possible because its
 * dependency graph pulls in a Vite `?worker&url` import.
 */
export function shouldTickToolCounter(isFinalized: boolean, activeLatched: boolean, isConnected: boolean): boolean {
    return !isFinalized && activeLatched && isConnected;
}
