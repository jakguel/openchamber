import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as safeStorageMod from './utils/safeStorage';
import * as desktop from '@/lib/desktop';
import * as runtimeFetchMod from '@/lib/runtime-fetch';

const storage = new Map<string, string>();
let storageSetCount = 0;

const safeStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storageSetCount += 1;
    storage.set(key, value);
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => {
    storage.clear();
  },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() {
    return storage.size;
  },
} as Storage;

// De-mocked: leaf I/O modules are spied before the subject is dynamically imported
// so the persist getSafeStorage factory (captured at store creation) resolves here.
spyOn(safeStorageMod, 'getSafeStorage').mockImplementation(() => safeStorage);
spyOn(desktop, 'isVSCodeRuntime').mockImplementation(() => false);
spyOn(runtimeFetchMod, 'runtimeFetch').mockImplementation((async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })) as typeof runtimeFetchMod.runtimeFetch);

const { useSessionFoldersStore } = await import('./useSessionFoldersStore');

afterAll(() => {
  mock.restore();
});

const waitForPersist = () => new Promise((resolve) => setTimeout(resolve, 350));

describe('useSessionFoldersStore folder assignments', () => {
  beforeEach(() => {
    storage.clear();
    storageSetCount = 0;
    useSessionFoldersStore.setState({
      foldersMap: {},
      collapsedFolderIds: new Set<string>(),
    });
  });

  test('repeated addSessionToFolder to the same folder preserves foldersMap reference', async () => {
    const store = useSessionFoldersStore.getState();
    const folder = store.createFolder('/workspace/project', 'Work');
    store.addSessionToFolder('/workspace/project', folder.id, 'ses_1');
    await waitForPersist();
    storageSetCount = 0;

    const before = useSessionFoldersStore.getState().foldersMap;
    useSessionFoldersStore.getState().addSessionToFolder('/workspace/project', folder.id, 'ses_1');
    await waitForPersist();

    expect(useSessionFoldersStore.getState().foldersMap).toBe(before);
    expect(storageSetCount).toBe(0);
  });

  test('repeated addSessionsToFolder to the same folder preserves foldersMap reference', async () => {
    const store = useSessionFoldersStore.getState();
    const folder = store.createFolder('/workspace/project', 'Batch');
    store.addSessionsToFolder('/workspace/project', folder.id, ['ses_1', 'ses_2']);
    await waitForPersist();
    storageSetCount = 0;

    const before = useSessionFoldersStore.getState().foldersMap;
    useSessionFoldersStore.getState().addSessionsToFolder('/workspace/project', folder.id, ['ses_1', 'ses_2']);
    await waitForPersist();

    expect(useSessionFoldersStore.getState().foldersMap).toBe(before);
    expect(storageSetCount).toBe(0);
  });
});
