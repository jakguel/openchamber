import { beforeEach, describe, expect, test } from 'bun:test';

import { useUIStore } from './useUIStore';
import { useFilesViewTabsStore } from './useFilesViewTabsStore';
import { useSessionUIStore } from '../sync/session-ui-store';

// Regression coverage for the FilesView stale-content bug: restoreForSessionSwitch
// reconciles useUIStore (activeSessionFileTabId) but historically never bridged the
// restored active tab's path into useFilesViewTabsStore.byRoot[root].selectedPath —
// the value FilesView actually renders from. After a session switch the tab strip
// (useUIStore) and the rendered file (useFilesViewTabsStore) drifted apart, showing
// the PREVIOUS session's file content. These tests drive the REAL stores (no internal
// mocks) and assert the two sources of truth stay in sync.

const dir = '/repo';
const fileX = '/repo/src/x.ts';
const fileY = '/repo/src/y.ts';

const resetStores = () => {
  // Clear the live file-tab state + active-session pointer (module-level Map state
  // persists across tests). Passing null applies DEFAULT and clears the pointer.
  useUIStore.getState().restoreForSessionSwitch(null);
  useFilesViewTabsStore.setState({ byRoot: {} });
};

const selectedPathForRoot = (root: string): string | null | undefined =>
  useFilesViewTabsStore.getState().byRoot[root]?.selectedPath;

const openPathsForRoot = (root: string): string[] =>
  useFilesViewTabsStore.getState().byRoot[root]?.openPaths ?? [];

describe('restoreForSessionSwitch → useFilesViewTabsStore bridge (FilesView stale content)', () => {
  beforeEach(resetStores);

  test('switch A(fileX) → B(fileY) → A restores each session\'s own selectedPath', () => {
    // --- Session A: open fileX ---
    useUIStore.getState().restoreForSessionSwitch('ses_switch_a', dir);
    useUIStore.getState().openSessionFileTab(dir, fileX);
    expect(useUIStore.getState().activeSessionFileTabId).toBe(fileX);
    expect(selectedPathForRoot(dir)).toBe(fileX);
    useUIStore.getState().prepareForSessionSwitch('ses_switch_a');

    // --- Session B: open fileY (this alone moves useFilesViewTabsStore.selectedPath to fileY) ---
    useUIStore.getState().restoreForSessionSwitch('ses_switch_b', dir);
    useUIStore.getState().openSessionFileTab(dir, fileY);
    expect(useUIStore.getState().activeSessionFileTabId).toBe(fileY);
    expect(selectedPathForRoot(dir)).toBe(fileY);
    useUIStore.getState().prepareForSessionSwitch('ses_switch_b');

    // --- Switch back to A: useUIStore must point at fileX AND the rendered
    // selectedPath must follow it (the bug left it stuck at fileY). ---
    useUIStore.getState().restoreForSessionSwitch('ses_switch_a', dir);
    expect(useUIStore.getState().activeSessionFileTabId).toBe(fileX);
    expect(selectedPathForRoot(dir)).toBe(fileX);

    // --- Switch to B again: selectedPath must track back to fileY. ---
    useUIStore.getState().restoreForSessionSwitch('ses_switch_b', dir);
    expect(useUIStore.getState().activeSessionFileTabId).toBe(fileY);
    expect(selectedPathForRoot(dir)).toBe(fileY);
  });

  test('reconciles all restored sessionFileTabs into byRoot.openPaths', () => {
    // Session opens two tabs; fileX is the active one.
    useUIStore.getState().restoreForSessionSwitch('ses_openpaths', dir);
    useUIStore.getState().openSessionFileTab(dir, fileX);
    useUIStore.getState().openSessionFileTab(dir, fileY);
    // fileY is now active; make fileX active so it is the restored active tab.
    useUIStore.getState().setActiveSessionFileTabId(dir, fileX);
    useUIStore.getState().prepareForSessionSwitch('ses_openpaths');

    // Switch away (clears live file-tab state + openPaths), then back.
    resetStores();
    useUIStore.getState().restoreForSessionSwitch('ses_openpaths', dir);

    // Both tabs from the restored session must be present in openPaths, and the
    // active tab must be the selected path.
    expect(openPathsForRoot(dir)).toContain(fileX);
    expect(openPathsForRoot(dir)).toContain(fileY);
    expect(selectedPathForRoot(dir)).toBe(fileX);
  });

  test('\'chat\' active tab clears the previous session\'s selectedPath for the root', () => {
    // Seed a selectedPath (previous session's file), then restore a session
    // whose active tab is 'chat'. FilesView must render NO file, so the bridge
    // must clear selectedPath (store's no-selection value is null).
    useFilesViewTabsStore.getState().setSelectedPath(dir, fileX);
    expect(selectedPathForRoot(dir)).toBe(fileX);

    // A never-saved session restores DEFAULT (activeSessionFileTabId === 'chat').
    useUIStore.getState().restoreForSessionSwitch('ses_chat_only', dir);

    expect(useUIStore.getState().activeSessionFileTabId).toBe('chat');
    expect(selectedPathForRoot(dir)).toBeNull();
  });

  test('session with no open file tab leaves no file selected', () => {
    // Fresh root with no prior selection; restore a chat-only session. The chat
    // branch clears the root's selection (null), so no file renders.
    useUIStore.getState().restoreForSessionSwitch('ses_no_tabs', dir);
    expect(useUIStore.getState().sessionFileTabs).toEqual([]);
    expect(useUIStore.getState().activeSessionFileTabId).toBe('chat');
    expect(selectedPathForRoot(dir)).toBeNull();
  });

  test('missing dir (undefined) with an active file tab does not crash and skips the bridge', () => {
    // Build a session with an active file tab in its snapshot.
    useUIStore.getState().restoreForSessionSwitch('ses_no_dir', dir);
    useUIStore.getState().openSessionFileTab(dir, fileX);
    useUIStore.getState().prepareForSessionSwitch('ses_no_dir');

    resetStores();

    // Restore WITHOUT a dir (legacy call). Must reconcile useUIStore state but
    // skip the bridge (no root to write into). Called directly: a throw fails the test.
    useUIStore.getState().restoreForSessionSwitch('ses_no_dir');
    expect(useUIStore.getState().activeSessionFileTabId).toBe(fileX);
    expect(selectedPathForRoot(dir)).toBeFalsy();
  });

  test('unknown root (no prior byRoot entry) is created without crashing', () => {
    const freshDir = '/other-repo';
    const freshFile = '/other-repo/main.ts';

    useUIStore.getState().restoreForSessionSwitch('ses_unknown_root', freshDir);
    useUIStore.getState().openSessionFileTab(freshDir, freshFile);
    useUIStore.getState().prepareForSessionSwitch('ses_unknown_root');

    resetStores();
    expect(useFilesViewTabsStore.getState().byRoot[freshDir]).toBeFalsy();

    // Called directly: a throw on an unknown root fails the test.
    useUIStore.getState().restoreForSessionSwitch('ses_unknown_root', freshDir);
    expect(selectedPathForRoot(freshDir)).toBe(freshFile);
  });

  describe('integration: useSessionUIStore.setCurrentSession threads resolvedDir', () => {
    test('switching sessions via setCurrentSession bridges selectedPath from the resolved directory hint', () => {
      // Session A active with fileX.
      useUIStore.getState().restoreForSessionSwitch('ses_int_a', dir);
      useUIStore.getState().openSessionFileTab(dir, fileX);
      useUIStore.getState().prepareForSessionSwitch('ses_int_a');

      // Session B active with fileY.
      useUIStore.getState().restoreForSessionSwitch('ses_int_b', dir);
      useUIStore.getState().openSessionFileTab(dir, fileY);
      useUIStore.getState().prepareForSessionSwitch('ses_int_b');

      // Make B the current session so the next switch is a real session change.
      useSessionUIStore.setState({ currentSessionId: 'ses_int_b', currentSessionDirectory: dir });

      // Drive the real call site: setCurrentSession(id, directoryHint). It resolves
      // resolvedDir from the hint and must thread it into restoreForSessionSwitch.
      useSessionUIStore.getState().setCurrentSession('ses_int_a', dir);

      expect(useUIStore.getState().activeSessionFileTabId).toBe(fileX);
      expect(selectedPathForRoot(dir)).toBe(fileX);
    });
  });
});
