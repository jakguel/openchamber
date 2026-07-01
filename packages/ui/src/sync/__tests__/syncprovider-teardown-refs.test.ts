import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"

import { INITIAL_STATE, type State } from "../types"
import type { ChildStoreManager, DirectoryStore } from "../child-store"
import {
  setSyncRefs,
  resetSyncRefs,
  getSyncSDK,
  getSyncChildStores,
  getSyncDirectory,
} from "../sync-refs"
import { setActionRefs, resetActionRefs, forkFromMessage } from "../session-actions"
import { useSessionUIStore } from "@/sync/session-ui-store"

// SyncProvider's ref effect (sync-context.tsx) sets these refs on mount and,
// on unmount, runs resetSyncRefs() + resetActionRefs() as its cleanup. This
// suite pins that unmount contract: after the same cleanup pair runs, both
// modules are pristine again (null refs), so any code touching them throws the
// "not initialized" guard instead of reading a stale _sdk / _childStores.
//
// Real production modules run; the only faked seam is the external SDK I/O
// boundary (a stub OpencodeClient), injected via the public setSyncRefs /
// setActionRefs DI setters. No internal module is mock.module()'d.

const DIR = "/proj"

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

function wireMounted() {
  const mgr = makeChildStores()
  setSyncRefs(stubSdk, mgr, DIR)
  setActionRefs(stubSdk, mgr, () => DIR)
  return mgr
}

// Mirror SyncProvider's unmount cleanup.
function runTeardown() {
  resetSyncRefs()
  resetActionRefs()
}

beforeEach(() => {
  useSessionUIStore.setState({
    currentSessionId: null,
    currentSessionDirectory: null,
    worktreeMetadata: new Map(),
  })
  wireMounted()
})

afterAll(() => {
  runTeardown()
  useSessionUIStore.setState({
    currentSessionId: null,
    currentSessionDirectory: null,
    worktreeMetadata: new Map(),
  })
})

describe("SyncProvider teardown resets sync/action refs", () => {
  test("mounted refs resolve to the injected sdk/childStores/directory", () => {
    const mgr = wireMounted()
    expect(getSyncSDK()).toBe(stubSdk)
    expect(getSyncChildStores()).toBe(mgr)
    expect(getSyncDirectory()).toBe(DIR)
  })

  test("after teardown, sync-refs getters throw the unmounted guard", () => {
    runTeardown()
    expect(() => getSyncSDK()).toThrow(/not initialized/i)
    expect(() => getSyncChildStores()).toThrow(/not initialized/i)
    expect(getSyncDirectory()).toBe("")
  })

  test("after teardown, a session action can no longer read stale action refs", async () => {
    runTeardown()
    let error: unknown
    try {
      await forkFromMessage("ses_gone", "msg_gone")
    } catch (e) {
      error = e
    }
    expect(error instanceof Error).toBe(true)
    expect(/not initialized/i.test((error as Error).message)).toBe(true)
  })
})
