import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { toast } from '@/components/ui';
import * as i18n from '@/lib/i18n';
import * as runtimeAPIRegistry from '@/contexts/runtimeAPIRegistry';
import * as gitHttp from '@/lib/gitApiHttp';
import {
  clearWorktreeBootstrapState,
  getWorktreeBootstrapState,
  markWorktreeBootstrapPending,
  startWorktreeBootstrapWatcher,
  waitForWorktreeBootstrap,
} from './worktreeBootstrap';

const bootstrapStatusCalls: string[] = [];
let bootstrapStatusResult: { status: 'pending' | 'ready' | 'failed'; error: string | null; updatedAt: number } = {
  status: 'ready',
  error: null,
  updatedAt: 1,
};
const toastErrors: Array<{ title: string; description?: string }> = [];

// De-mocked: worktreeBootstrap runs for real. The toast surface, i18n formatter,
// runtime API registry, and git-http status boundary are spied on their real
// modules; formatMessage returns the raw key so assertions read the message keys.
// The real useI18nStore is used (no stub needed once the module registry is intact).
spyOn(toast, 'error').mockImplementation(((title: string, options?: { description?: string }) => {
  toastErrors.push({ title, description: options?.description });
}) as unknown as typeof toast.error);
spyOn(i18n, 'formatMessage').mockImplementation(((_dictionary: Record<string, string>, key: string) => key) as unknown as typeof i18n.formatMessage);
spyOn(runtimeAPIRegistry, 'getRegisteredRuntimeAPIs').mockImplementation((() => ({
  git: {
    worktree: {
      bootstrapStatus: (directory: string) => {
        bootstrapStatusCalls.push(directory);
        return Promise.resolve(bootstrapStatusResult);
      },
    },
  },
})) as unknown as typeof runtimeAPIRegistry.getRegisteredRuntimeAPIs);
spyOn(gitHttp, 'getGitWorktreeBootstrapStatus').mockImplementation(((directory: string) => {
  bootstrapStatusCalls.push(directory);
  return Promise.resolve(bootstrapStatusResult);
}) as unknown as typeof gitHttp.getGitWorktreeBootstrapStatus);

afterAll(() => {
  mock.restore();
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for condition');
};

describe('worktreeBootstrap.waitForWorktreeBootstrap', () => {
  beforeEach(() => {
    bootstrapStatusCalls.length = 0;
    toastErrors.length = 0;
    bootstrapStatusResult = { status: 'ready', error: null, updatedAt: 1 };
    clearWorktreeBootstrapState('/repo');
    clearWorktreeBootstrapState('/repo-wt');
  });

  test('does not poll directories that were not marked pending', async () => {
    await waitForWorktreeBootstrap('/repo');

    expect(bootstrapStatusCalls).toEqual([]);
  });

  test('polls when the directory was explicitly marked pending', async () => {
    markWorktreeBootstrapPending('/repo-wt');

    await waitForWorktreeBootstrap('/repo-wt');

    expect(bootstrapStatusCalls).toEqual(['/repo-wt']);
  });

  test('background watcher polls pending worktrees without blocking', async () => {
    markWorktreeBootstrapPending('/repo-wt');
    const readyStatuses: Array<{ status: 'pending' | 'ready' | 'failed'; error: string | null; updatedAt: number }> = [];

    startWorktreeBootstrapWatcher('/repo-wt', {
      pollIntervalMs: 0,
      onReady: (status) => readyStatuses.push(status),
    });

    await waitFor(() => readyStatuses.length === 1);
    expect(bootstrapStatusCalls).toEqual(['/repo-wt']);
    expect(readyStatuses.map((status) => status.status)).toEqual(['ready']);
    expect(toastErrors).toEqual([]);
  });

  test('background watcher shows a toast when bootstrap fails', async () => {
    bootstrapStatusResult = { status: 'failed', error: 'setup failed', updatedAt: 2 };
    markWorktreeBootstrapPending('/repo-wt');

    startWorktreeBootstrapWatcher('/repo-wt', { pollIntervalMs: 0 });

    await waitFor(() => toastErrors.length === 1);
    expect(toastErrors).toEqual([{ title: 'worktree.bootstrap.toast.failed', description: 'setup failed' }]);
  });

  test('background watcher marks failed and toasts when bootstrap times out', async () => {
    bootstrapStatusResult = { status: 'pending', error: null, updatedAt: 2 };
    markWorktreeBootstrapPending('/repo-wt');
    const failedStatuses: Array<{ status: 'pending' | 'ready' | 'failed'; error: string | null; updatedAt: number }> = [];

    startWorktreeBootstrapWatcher('/repo-wt', {
      timeoutMs: 0,
      pollIntervalMs: 0,
      onFailed: (status) => failedStatuses.push(status),
    });

    await waitFor(() => toastErrors.length === 1);
    expect(getWorktreeBootstrapState('/repo-wt')?.status).toBe('failed');
    expect(failedStatuses.map((status) => status.status)).toEqual(['failed']);
    expect(toastErrors).toEqual([{
      title: 'worktree.bootstrap.toast.failed',
      description: 'worktree.bootstrap.toast.timeoutDescription',
    }]);
  });

  test('background watcher is deduped per directory', async () => {
    bootstrapStatusResult = { status: 'pending', error: null, updatedAt: 2 };
    markWorktreeBootstrapPending('/repo-wt');

    startWorktreeBootstrapWatcher('/repo-wt', { pollIntervalMs: 1000 });
    startWorktreeBootstrapWatcher('/repo-wt', { pollIntervalMs: 1000 });

    await waitFor(() => bootstrapStatusCalls.length === 1);
    expect(bootstrapStatusCalls).toEqual(['/repo-wt']);
    clearWorktreeBootstrapState('/repo-wt');
  });
});
