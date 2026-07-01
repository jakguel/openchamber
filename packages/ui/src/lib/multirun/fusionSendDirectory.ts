import { useSessionUIStore } from '@/sync/session-ui-store';

// Bug .20: never fall back to opencodeClient.getDirectory() here — that
// process-global holds the PREVIOUS project during a fusion-session create-race
// and misroutes the first prompt. Unresolvable => throw (NON-SENDABLE), so the
// send cannot silently leak to the wrong project.
export const resolveFusionSendDirectory = (fusionSessionId: string): string => {
  const directory = useSessionUIStore.getState().getDirectoryForSession(fusionSessionId);
  if (!directory) {
    throw new Error(
      `Fusion session ${fusionSessionId} has no resolvable directory; refusing to send to avoid cross-project misroute`,
    );
  }
  return directory;
};
