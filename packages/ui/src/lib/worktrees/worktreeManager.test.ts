import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { WorktreeMetadata } from '@/types/worktree';
import * as openchamberConfig from '@/lib/openchamberConfig';
import * as worktreeBootstrap from '@/lib/worktrees/worktreeBootstrap';
import * as worktreeStatus from '@/lib/worktrees/worktreeStatus';
import { useSessionUIStore } from '@/sync/session-ui-store';
import * as gitApi from '@/lib/gitApi';
import { createWorktree, listProjectWorktrees } from './worktreeManager';

type WorktreeListEntry = {
  path?: string;
  branch?: string;
  head?: string;
  name?: string;
};

const listCalls: string[] = [];
const listResolvers: Array<(value: WorktreeListEntry[]) => void> = [];
const createdWorktree = {
  name: 'feature',
  branch: 'feature',
  path: '/repo-feature',
  directoryCreated: true as const,
  bootstrapStatus: { status: 'pending' as const, error: null, updatedAt: 1 },
};

const sessionState = {
  availableWorktreesByProject: new Map<string, WorktreeMetadata[]>(),
  availableWorktrees: [] as WorktreeMetadata[],
};

// De-mocked: worktreeManager runs for real; the git/config/bootstrap/status I/O
// boundaries and the session store are spied on their real modules and restored
// afterAll so nothing leaks to other files.
spyOn(openchamberConfig, 'substituteCommandVariables').mockImplementation((command: string) => command);
spyOn(worktreeBootstrap, 'clearWorktreeBootstrapState').mockImplementation(() => undefined);
spyOn(worktreeBootstrap, 'markWorktreeBootstrapPending').mockImplementation(() => undefined);
spyOn(worktreeBootstrap, 'setWorktreeBootstrapState').mockImplementation((() => undefined) as unknown as typeof worktreeBootstrap.setWorktreeBootstrapState);
spyOn(worktreeBootstrap, 'startWorktreeBootstrapWatcher').mockImplementation((() => undefined) as unknown as typeof worktreeBootstrap.startWorktreeBootstrapWatcher);
spyOn(worktreeStatus, 'invalidateResolvedProjectRootCache').mockImplementation(() => undefined);
spyOn(worktreeStatus, 'resolveProjectRoot').mockImplementation(((directory: string) => Promise.resolve(directory)) as unknown as typeof worktreeStatus.resolveProjectRoot);
spyOn(useSessionUIStore, 'getState').mockReturnValue(sessionState as unknown as ReturnType<typeof useSessionUIStore.getState>);
spyOn(useSessionUIStore, 'setState').mockImplementation(((patch: Partial<typeof sessionState> | ((state: typeof sessionState) => Partial<typeof sessionState>)) => {
  const next = typeof patch === 'function' ? patch(sessionState) : patch;
  Object.assign(sessionState, next);
}) as unknown as typeof useSessionUIStore.setState);
spyOn(gitApi, 'deleteRemoteBranch').mockImplementation((() => Promise.resolve({ success: true })) as unknown as typeof gitApi.deleteRemoteBranch);
spyOn(gitApi.git.worktree, 'list').mockImplementation(((directory: string) => {
  listCalls.push(directory);
  return new Promise<WorktreeListEntry[]>((resolve) => {
    listResolvers.push(resolve);
  });
}) as unknown as typeof gitApi.git.worktree.list);
spyOn(gitApi.git.worktree, 'create').mockImplementation((() => Promise.resolve(createdWorktree)) as unknown as typeof gitApi.git.worktree.create);
spyOn(gitApi.git.worktree, 'remove').mockImplementation((() => Promise.resolve({ success: true })) as unknown as typeof gitApi.git.worktree.remove);

afterAll(() => {
  mock.restore();
});

const waitForListCallCount = async (count: number): Promise<void> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (listCalls.length >= count) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Expected ${count} worktree list calls, got ${listCalls.length}`);
};

describe('worktreeManager list invalidation', () => {
  beforeEach(() => {
    listCalls.length = 0;
    listResolvers.length = 0;
    sessionState.availableWorktreesByProject = new Map();
    sessionState.availableWorktrees = [];
  });

  test('retries an in-flight list when a worktree is created before it resolves', async () => {
    const project = { id: 'project-1', path: '/repo' };
    const listing = listProjectWorktrees(project);

    await waitForListCallCount(1);

    await createWorktree(project, {
      preferredName: 'feature',
      mode: 'new',
      branchName: 'feature',
      worktreeName: 'feature',
    });

    listResolvers[0]([]);
    await waitForListCallCount(2);
    listResolvers[1]([createdWorktree]);

    const result = await listing;

    expect(listCalls).toEqual(['/repo', '/repo']);
    expect(result.map((entry) => entry.path)).toEqual(['/repo-feature']);
  });

  test('marks fast-created worktrees pending until bootstrap settles', async () => {
    const metadata = await createWorktree({ id: 'project-1', path: '/repo' }, {
      preferredName: 'feature',
      mode: 'new',
      branchName: 'feature',
      worktreeName: 'feature',
      returnAfterDirectoryCreated: true,
    });

    expect(metadata.worktreeStatus).toBe('pending');
    expect(sessionState.availableWorktrees[0]?.worktreeStatus).toBe('pending');
  });
});
