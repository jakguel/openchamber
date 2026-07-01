import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { OpencodeClient, Session } from '@opencode-ai/sdk/v2/client';

import { ChildStoreManager } from '@/sync/child-store';
import { setSyncRefs, resetSyncRefs } from '@/sync/sync-refs';
import { setActionRefs, resetActionRefs } from '@/sync/session-actions';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { opencodeClient } from '@/lib/opencode/client';
import { resolveSessionSendDirectory } from './sessionSendDirectory';

const PROJ_A = '/projA';
const PROJ_B = '/projB';

function makeSession(id: string, directory: string): Session {
  return {
    id,
    slug: id,
    projectID: 'proj',
    directory,
    title: id,
    version: '1',
    time: { created: 1, updated: 1 },
  };
}

// Narrow cast at the EXTERNAL SDK boundary only — the send/messages seam is stubbed.
const stubSdk = {
  session: {
    messages: async () => ({ data: [] }),
  },
} as unknown as OpencodeClient;

const realGetDirectory = opencodeClient.getDirectory();

function resetStore() {
  useSessionUIStore.setState({
    currentSessionId: null,
    currentSessionDirectory: null,
    worktreeMetadata: new Map(),
  });
}

afterAll(() => {
  opencodeClient.setDirectory(realGetDirectory);
  resetSyncRefs();
  resetActionRefs();
  resetStore();
});

function wireRefs(mgr: ChildStoreManager) {
  setSyncRefs(stubSdk, mgr, '');
  setActionRefs(stubSdk, mgr, () => '');
  resetStore();
}

describe('resolveSessionSendDirectory — no explicit-global leak (bug .20)', () => {
  beforeEach(() => {
    wireRefs(new ChildStoreManager());
  });

  test('null-resolvable session is BLOCKED, never the previous project global', () => {
    opencodeClient.setDirectory(PROJ_A);
    useDirectoryStore.setState({ currentDirectory: PROJ_A });

    let leaked: string | null = null;
    let message = '';
    try {
      leaked = resolveSessionSendDirectory('ses_unknown');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(/no resolvable directory|refusing to send/i.test(message)).toBe(true);
    expect(leaked).toBeNull();
    expect(opencodeClient.getDirectory()).toBe(PROJ_A);
  });

  test('resolves a current-session directory hint, not the global', () => {
    opencodeClient.setDirectory(PROJ_A);
    useSessionUIStore.getState().setCurrentSession('ses_created', PROJ_B);

    expect(resolveSessionSendDirectory('ses_created')).toBe(PROJ_B);
  });

  test('resolves an authoritative sync session directory even when the global is a foreign project', () => {
    const mgr = new ChildStoreManager();
    const store = mgr.ensureChild(PROJ_B, { bootstrap: false });
    store.getState().patch({ session: [makeSession('ses_sync', PROJ_B)] });
    wireRefs(mgr);

    opencodeClient.setDirectory(PROJ_A);

    expect(resolveSessionSendDirectory('ses_sync')).toBe(PROJ_B);
  });
});
