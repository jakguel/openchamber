import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2/client"

import { INITIAL_STATE, type State } from "../types"
import type { ChildStoreManager, DirectoryStore } from "../child-store"
import {
  setSyncRefs,
  resetSyncRefs,
  getSyncSDK,
  getSyncChildStores,
  getSyncDirectory,
  getDirectoryState,
  getAllSyncSessions,
  getSyncSessions,
} from "../sync-refs"
import { setActionRefs, resetActionRefs, forkFromMessage } from "../session-actions"
import { useSessionUIStore } from "@/sync/session-ui-store"

// SyncProvider's ref effect (sync-context.tsx) calls setSyncRefs + setActionRefs
// on mount and, on unmount, runs resetSyncRefs() + resetActionRefs() as its
// cleanup. This suite exercises that mount→unmount ref lifecycle through the
// exact public DI seam the provider uses, across the real sync-refs,
// session-actions, session-ui-store and child-store modules:
//   • mount phase  → the ref-dependent read surface (getSyncSDK, child-store
//     reads, session lists) resolves against injected state.
//   • unmount phase → the same reset pair the provider cleanup invokes returns
//     every ref to pristine (null), so readers throw the "not initialized"
//     guard and a real cross-module action (forkFromMessage) rejects.
//
// A createRoot()-based mount/unmount of <SyncProvider/> is intentionally not
// used: bun test provides no document/window, the monorepo ships no
// happy-dom/jsdom/testing-library/react-test-renderer, and adding one is out of
// scope (project rule: no new deps). Fully mounting SyncProvider would also
// start its SSE/reconnect/bootstrap effects and leak timers into the rest of
// src/sync. The provider's ref contract is therefore verified via its DI seam.
// Only the external SDK I/O boundary is a stub; no internal module is mocked.

const DIR = "/proj"

function makeSession(id: string, directory: string): Session {
  return {
    id,
    title: id,
    directory,
    time: { created: 1, updated: 1 },
    version: "1",
  } as unknown as Session
}

function makeChildStores(): ChildStoreManager {
  const children = new Map<string, StoreApi<DirectoryStore>>()
  return {
    children,
    ensureChild: (directory: string) => {
      let store = children.get(directory)
      if (!store) {
        store = create<DirectoryStore>()((set) => ({
          ...INITIAL_STATE,
          patch: (partial: Partial<State>) => set(partial),
          replace: (next: State) => set(next),
        }))
        children.set(directory, store)
      }
      return store
    },
    getChild: (directory: string) => children.get(directory),
    getState: (directory: string) => children.get(directory)?.getState(),
  } as unknown as ChildStoreManager
}

const stubSdk = {
  session: {
    messages: async () => ({ data: [] }),
  },
} as unknown as OpencodeClient

// Mirror what SyncProvider's ref effect does on mount.
function mountRefs() {
  const mgr = makeChildStores()
  mgr.ensureChild(DIR).getState().patch({ session: [makeSession("ses_live", DIR)] })
  setSyncRefs(stubSdk, mgr, DIR)
  setActionRefs(stubSdk, mgr, () => DIR)
  return mgr
}

// Mirror SyncProvider's unmount cleanup.
function unmountRefs() {
  resetSyncRefs()
  resetActionRefs()
}

beforeEach(() => {
  useSessionUIStore.setState({
    currentSessionId: null,
    currentSessionDirectory: null,
    worktreeMetadata: new Map(),
  })
  mountRefs()
})

afterAll(() => {
  unmountRefs()
  useSessionUIStore.setState({
    currentSessionId: null,
    currentSessionDirectory: null,
    worktreeMetadata: new Map(),
  })
})

describe("SyncProvider mount/unmount ref lifecycle", () => {
  test("mount: the ref-dependent read surface resolves against injected state", () => {
    const mgr = mountRefs()
    expect(getSyncSDK()).toBe(stubSdk)
    expect(getSyncChildStores()).toBe(mgr)
    expect(getSyncDirectory()).toBe(DIR)
    expect(getDirectoryState(DIR)).toBeTruthy()
    expect(getSyncSessions(DIR).map((s) => s.id)).toEqual(["ses_live"])
    expect(getAllSyncSessions().map((s) => s.id)).toEqual(["ses_live"])
  })

  test("unmount: sync-refs getters/readers return to pristine", () => {
    unmountRefs()
    expect(() => getSyncSDK()).toThrow(/not initialized/i)
    expect(() => getSyncChildStores()).toThrow(/not initialized/i)
    expect(getSyncDirectory()).toBe("")
    expect(getDirectoryState(DIR)).toBe(undefined)
    expect(getAllSyncSessions()).toEqual([])
  })

  test("unmount: a real cross-module session action can no longer read stale refs", async () => {
    unmountRefs()
    let error: unknown
    try {
      await forkFromMessage("ses_live", "msg_gone")
    } catch (e) {
      error = e
    }
    expect(error instanceof Error).toBe(true)
    expect(/not initialized/i.test((error as Error).message)).toBe(true)
  })
})
