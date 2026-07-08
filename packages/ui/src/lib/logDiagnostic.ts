import { runtimeFetch } from './runtime-fetch';

export type DiagnosticLevel = 'log' | 'info' | 'warn' | 'error';

// Keep well under the server-side /api/log message cap (4096) so a legitimate
// diagnostic is bounded on the client and never rejected by the endpoint.
const MAX_MESSAGE_LENGTH = 4000;
const TRUNCATION_SUFFIX = '…[truncated]';

/**
 * Forward a client-side diagnostic to the server process stdout via the runtime
 * log endpoint, fire-and-forget. This goes through the runtime abstraction
 * (`runtimeFetch`), so it works across web/desktop and degrades gracefully on
 * runtimes without the endpoint (e.g. VS Code) by swallowing the failure.
 *
 * A failed, slow, or absent endpoint MUST NOT throw into or block the caller —
 * every failure path is swallowed.
 */
export function forwardDiagnosticToServer(
  tag: string,
  message: string,
  level: DiagnosticLevel = 'log',
): void {
  try {
    const boundedMessage =
      message.length > MAX_MESSAGE_LENGTH
        ? `${message.slice(0, MAX_MESSAGE_LENGTH)}${TRUNCATION_SUFFIX}`
        : message;
    void runtimeFetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, tag, message: boundedMessage }),
    }).catch(() => {
      // Fire-and-forget: swallow network/endpoint failures so logging can never
      // surface into the caller's path.
    });
  } catch {
    // Guard against synchronous throws (e.g. JSON.stringify on hostile input)
    // so logging can never break the caller's path.
  }
}
