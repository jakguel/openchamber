import { useSessionUIStore } from '@/sync/session-ui-store';

// Bug .20: resolve a session send's OWN authoritative directory. NEVER fall back
// to a process-global (opencodeClient.getDirectory() / currentDirectory /
// effectiveDirectory) — during a create/switch race those hold the PREVIOUS
// project and misroute the send. Unresolvable => throw (NON-SENDABLE).
export const resolveSessionSendDirectory = (sessionId: string): string => {
  const directory = useSessionUIStore.getState().getDirectoryForSession(sessionId);
  if (!directory) {
    throw new Error(
      `Session ${sessionId} has no resolvable directory; refusing to send to avoid cross-project misroute`,
    );
  }
  return directory;
};
