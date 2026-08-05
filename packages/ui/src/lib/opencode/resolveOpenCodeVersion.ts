/**
 * Extracts the OpenCode version from an `/api/opencode/version` JSON payload.
 *
 * The server route returns `{ version: string | null }` (see
 * `packages/web/server/lib/opencode/routes.js` — `GET /api/opencode/version`).
 * The About surfaces render this as best-effort text, so a missing, non-string,
 * or blank value collapses to `null` and the caller shows an "unknown" label.
 *
 * Pure and side-effect free so the About boundary parse can be unit-tested
 * without a DOM, network, or React.
 */
export const resolveOpenCodeVersion = (data: unknown): string | null => {
  if (data === null || typeof data !== 'object') return null;
  const candidate = (data as { version?: unknown }).version;
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
};
