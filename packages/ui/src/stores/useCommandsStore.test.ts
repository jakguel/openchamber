import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { opencodeClient } from '@/lib/opencode/client';
import * as runtimeFetchMod from '@/lib/runtime-fetch';
import * as configUpdate from '@/lib/configUpdate';
import * as configSync from '@/lib/configSync';

const activeProjectPath = '/workspace/project';

let listCommandsWithDetailsCalls = 0;
let listCommandsWithDetailsImpl: () => Promise<unknown[]> = async () => [];
let withDirectoryImpl: (_directory: string | null, callback: () => Promise<unknown>) => Promise<unknown> = async (_directory, callback) => callback();
let getDirectoryImpl: () => string = () => '/fallback/project';
let runtimeFetchImpl: () => Promise<Response> = async () => new Response(JSON.stringify({ scope: 'project' }), {
  headers: { 'Content-Type': 'application/json' },
});

// De-mocked: the SDK client, runtime fetch, and config bus are spied on their real
// modules before useCommandsStore is dynamically imported, so the config-change
// subscription it registers at module load resolves to the no-op stub instead of
// leaking a real listener. The store logic runs for real against these boundaries.
spyOn(useProjectsStore, 'getState').mockReturnValue({
  getActiveProject: () => ({ path: activeProjectPath }),
} as unknown as ReturnType<typeof useProjectsStore.getState>);
spyOn(opencodeClient, 'getDirectory').mockImplementation(() => getDirectoryImpl());
spyOn(opencodeClient, 'listCommandsWithDetails').mockImplementation((async () => {
  listCommandsWithDetailsCalls += 1;
  return listCommandsWithDetailsImpl();
}) as unknown as typeof opencodeClient.listCommandsWithDetails);
spyOn(opencodeClient, 'withDirectory').mockImplementation((async (directory: string | null, callback: () => Promise<unknown>) => withDirectoryImpl(directory, callback)) as typeof opencodeClient.withDirectory);
spyOn(runtimeFetchMod, 'runtimeFetch').mockImplementation((async () => runtimeFetchImpl()) as unknown as typeof runtimeFetchMod.runtimeFetch);
spyOn(configUpdate, 'startConfigUpdate').mockImplementation(() => undefined);
spyOn(configUpdate, 'finishConfigUpdate').mockImplementation(() => undefined);
spyOn(configUpdate, 'updateConfigUpdateMessage').mockImplementation(() => undefined);
spyOn(configSync, 'emitConfigChange').mockImplementation(() => undefined);
spyOn(configSync, 'scopeMatches').mockImplementation(() => false);
spyOn(configSync, 'subscribeToConfigChanges').mockImplementation((() => () => undefined) as typeof configSync.subscribeToConfigChanges);

const { useCommandsStore } = await import('./useCommandsStore');

afterAll(() => {
  mock.restore();
});

describe('useCommandsStore', () => {
  beforeEach(() => {
    listCommandsWithDetailsCalls = 0;
    listCommandsWithDetailsImpl = async () => [];
    withDirectoryImpl = async (_directory, callback) => callback();
    getDirectoryImpl = () => '/fallback/project';
    runtimeFetchImpl = async () => new Response(JSON.stringify({ scope: 'project' }), {
      headers: { 'Content-Type': 'application/json' },
    });

    useCommandsStore.setState({
      selectedCommandName: null,
      commands: [],
      isLoading: false,
      commandDraft: null,
    });
  });

  test('loadCommands preserves previous commands when the command list fails', async () => {
    const previousCommands = [{
      name: 'existing',
      description: 'Existing command',
      template: 'do the previous thing',
      scope: 'project' as const,
    }];
    useCommandsStore.setState({ commands: previousCommands });
    listCommandsWithDetailsImpl = async () => {
      throw new Error('network down');
    };

    const result = await useCommandsStore.getState().loadCommands();

    expect(result).toBe(false);
    expect(listCommandsWithDetailsCalls).toBe(3);
    expect(useCommandsStore.getState().commands).toEqual(previousCommands);
    expect(useCommandsStore.getState().isLoading).toBe(false);
  });
});
