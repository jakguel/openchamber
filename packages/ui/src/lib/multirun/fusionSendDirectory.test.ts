import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { create, type StoreApi } from 'zustand';
import type { OpencodeClient, Session } from '@opencode-ai/sdk/v2/client';

import { INITIAL_STATE, type State } from '@/sync/types';
import type { ChildStoreManager, DirectoryStore } from '@/sync/child-store';
import { setSyncRefs, resetSyncRefs } from '@/sync/sync-refs';
import { setActionRefs, resetActionRefs } from '@/sync/session-actions';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { opencodeClient } from '@/lib/opencode/client';
import { resolveFusionSendDirectory } from './fusionSendDirectory';

const PROJ_A = '/projA';
const PROJ_B = '/projB';

function makeChildStores() {
  const children = new Map<string, StoreApi<DirectoryStore>>();
  const createChild = (sessions: State['session'] = []): StoreApi<DirectoryStore> =>
    create<DirectoryStore>()((set) => ({
      ...INITIAL_STATE,
      session: sessions,
      patch: (partial) => set(partial),
      replace: (next) => set(next),
    }));
  const mgr = {
    children,
    ensureChild: (directory: string) => {
      let store = children.get(directory);
      if (!store) {
        store = createChild();
        children.set(directory, store);
      }
      return store;
    },
    getChild: (directory: string) => children.get(directory),
    getState: (directory: string) => children.get(directory)?.getState(),
  } as unknown as ChildStoreManager;
  return { mgr, children, createChild };
}

function makeSession(id: string, directory: string): Session {
  return {
    id,
    title: id,
    directory,
    time: { created: 1, updated: 1 },
    version: '1',
  } as unknown as Session;
}

const stubSdk = {
  session: {
    messages: async () => ({ data: [] }),
  },
} as unknown as OpencodeClient;

const realGetDirectory = opencodeClient.getDirectory();

afterAll(() => {
  opencodeClient.setDirectory(realGetDirectory);
  resetSyncRefs();
  resetActionRefs();
  useSessionUIStore.setState({
    currentSessionId: null,
    currentSessionDirectory: null,
    worktreeMetadata: new Map(),
  });
});

function wireRefs(childMgr: ChildStoreManager) {
  setSyncRefs(stubSdk, childMgr, '');
  setActionRefs(stubSdk, childMgr, () => '');
  useSessionUIStore.setState({
    currentSessionId: null,
    currentSessionDirectory: null,
    worktreeMetadata: new Map(),
  });
}

describe('resolveFusionSendDirectory — no explicit-global leak (bug .20)', () => {
  beforeEach(() => {
    wireRefs(makeChildStores().mgr);
  });

  test('null-resolvable fusion session is BLOCKED, never the previous project global', () => {
    opencodeClient.setDirectory(PROJ_A);
    useDirectoryStore.setState({ currentDirectory: PROJ_A });

    let leaked: string | null = null;
    let threw = false;
    try {
      leaked = resolveFusionSendDirectory('ses_fusion_unknown');
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(leaked).not.toBe(PROJ_A);
    expect(opencodeClient.getDirectory()).toBe(PROJ_A);
  });

  test('resolves the fusion session current-session directory hint, not the global', () => {
    opencodeClient.setDirectory(PROJ_A);
    useSessionUIStore.getState().setCurrentSession('ses_fusion_created', PROJ_B);

    expect(resolveFusionSendDirectory('ses_fusion_created')).toBe(PROJ_B);
  });

  test('resolves an authoritative sync session directory even when the global is a foreign project', () => {
    const { mgr, children, createChild } = makeChildStores();
    children.set(PROJ_B, createChild([makeSession('ses_fusion_sync', PROJ_B)]));
    wireRefs(mgr);

    opencodeClient.setDirectory(PROJ_A);

    expect(resolveFusionSendDirectory('ses_fusion_sync')).toBe(PROJ_B);
  });
});
