import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { OpencodeClient, Session } from '@opencode-ai/sdk/v2/client';

import { ChildStoreManager } from '@/sync/child-store';
import { setSyncRefs, resetSyncRefs } from '@/sync/sync-refs';
import { setActionRefs, resetActionRefs } from '@/sync/session-actions';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { opencodeClient } from '@/lib/opencode/client';
import { startReviewFlow } from '@/lib/reviewFlow';

const PROJ_A = '/projA';

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

const stubSdk = {
  session: {
    messages: async () => ({ data: [] }),
  },
} as unknown as OpencodeClient;

const realGetDirectory = opencodeClient.getDirectory();
const realCreateSession = opencodeClient.createSession.bind(opencodeClient);
const realSendMessage = opencodeClient.sendMessage.bind(opencodeClient);
const realGetSession = opencodeClient.getSession.bind(opencodeClient);

let createSessionDirs: Array<string | null | undefined> = [];
let sendMessageDirs: Array<string | null | undefined> = [];

function resetStore() {
  useSessionUIStore.setState({
    currentSessionId: null,
    currentSessionDirectory: null,
    worktreeMetadata: new Map(),
  });
}

afterAll(() => {
  opencodeClient.setDirectory(realGetDirectory);
  opencodeClient.createSession = realCreateSession;
  opencodeClient.sendMessage = realSendMessage;
  opencodeClient.getSession = realGetSession;
  resetSyncRefs();
  resetActionRefs();
  resetStore();
});

beforeEach(() => {
  createSessionDirs = [];
  sendMessageDirs = [];
  const mgr = new ChildStoreManager();
  setSyncRefs(stubSdk, mgr, '');
  setActionRefs(stubSdk, mgr, () => '');
  resetStore();
  // Spy on the external SDK send boundary — record the directory each would route to.
  opencodeClient.createSession = (async (_params, directory) => {
    createSessionDirs.push(directory);
    return makeSession('ses_review', directory ?? '');
  }) as typeof opencodeClient.createSession;
  opencodeClient.sendMessage = (async (params) => {
    sendMessageDirs.push(params.directory);
    return '';
  }) as typeof opencodeClient.sendMessage;
  opencodeClient.getSession = (async (id, directory) => makeSession(id, directory ?? '')) as typeof opencodeClient.getSession;
});

describe('startReviewFlow — authoritative send directory, no global fallback (bug .20)', () => {
  test('null-resolvable original session BLOCKS the review send and never routes to the global', async () => {
    // Poison setup: original session has no store-resolvable directory and the
    // process-global is a foreign project. Caller passes the poisoned global as
    // input.directory — startReviewFlow must ignore it and refuse to send.
    opencodeClient.setDirectory(PROJ_A);
    useDirectoryStore.setState({ currentDirectory: PROJ_A });

    let message = '';
    try {
      await startReviewFlow({
        originalSessionID: 'ses_orig_unknown',
        directory: PROJ_A,
        providerID: 'anthropic',
        modelID: 'claude',
        generateHandoff: false,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(/no resolvable directory|refusing to send/i.test(message)).toBe(true);
    expect(createSessionDirs).toEqual([]);
    expect(sendMessageDirs).toEqual([]);
    expect(createSessionDirs).not.toContain(PROJ_A);
    expect(sendMessageDirs).not.toContain(PROJ_A);
  });
});
