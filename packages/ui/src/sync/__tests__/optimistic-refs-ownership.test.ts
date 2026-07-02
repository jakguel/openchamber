import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { Message, OpencodeClient, Part } from "@opencode-ai/sdk/v2/client"

import { INITIAL_STATE, type State } from "../types"
import type { ChildStoreManager, DirectoryStore } from "../child-store"
import {
  setActionRefs,
  resetActionRefs,
  setOptimisticRefs,
  resetOptimisticRefs,
  optimisticSend,
} from "../session-actions"
import { useConfigStore } from "@/stores/useConfigStore"

// Regression coverage for the "Optimistic refs not set — is useSync() mounted?"
// crash after a directory/worktree switch. SyncProvider re-runs its ref effect
// on props.directory change (resetActionRefs then setActionRefs), but the
// optimistic pair is owned by SyncOptimisticBridge (mount-once, no remount).
// resetActionRefs must therefore NOT null the optimistic pair.
//
// This suite drives the exact public DI seam (setActionRefs/setOptimisticRefs/
// resetActionRefs/resetOptimisticRefs/optimisticSend) against the real
// session-actions module. Only the external OpencodeClient SDK session surface
// is stubbed; the connection gate is satisfied by seeding the REAL useConfigStore
// state (no internal module is mocked). bun test has no DOM, so SyncProvider is
// not mounted — its ref contract is verified through the DI seam it uses.

const DIR = "/proj"

type OptimisticAddCall = { sessionID: string; directory?: string | null; message: Message; parts: Part[] }

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

function baseSend(input: {
  sessionId: string
  onAdd?: (call: OptimisticAddCall) => void
}) {
  return optimisticSend({
    sessionId: input.sessionId,
    directory: DIR,
    content: "hello",
    providerID: "provider",
    modelID: "model",
    send: async () => {},
  })
}

beforeEach(() => {
  // Defensively clear any optimistic refs leaked by other suites (resetActionRefs
  // no longer clears them) so these tests start from a known-null baseline.
  resetOptimisticRefs()
  resetActionRefs()
  useConfigStore.setState({ isConnected: true, hasEverConnected: true })
})

afterAll(() => {
  resetOptimisticRefs()
  resetActionRefs()
})

describe("optimistic-ref ownership survives a directory switch", () => {
  test("optimisticSend routes to optimisticAdd after resetActionRefs + setActionRefs without re-setting optimistic refs", async () => {
    const mgr = makeChildStores()
    mgr.ensureChild(DIR)
    let added: OptimisticAddCall | null = null

    setOptimisticRefs((input) => { added = input }, () => {})
    setActionRefs(stubSdk, mgr, () => DIR)

    resetActionRefs()
    setActionRefs(stubSdk, mgr, () => DIR)

    await baseSend({ sessionId: "ses_switch" })

    expect(added).not.toBeNull()
    const call = added as unknown as OptimisticAddCall
    expect(call.sessionID).toBe("ses_switch")
    expect(call.directory).toBe(DIR)
    expect(mgr.getChild(DIR)?.getState().session_status["ses_switch"]?.type).toBe("busy")
  })

  test("resetActionRefs alone leaves the optimistic refs set — send fails past the guard, not on it", async () => {
    const mgr = makeChildStores()
    mgr.ensureChild(DIR)

    setOptimisticRefs(() => {}, () => {})
    setActionRefs(stubSdk, mgr, () => DIR)
    resetActionRefs()

    let thrown: unknown
    try {
      await baseSend({ sessionId: "ses_no_action_refs" })
    } catch (error) {
      thrown = error
    }

    expect(thrown instanceof Error).toBe(true)
    expect((thrown as Error).message).toContain("Child stores not initialized")
    expect((thrown as Error).message).not.toContain("Optimistic refs not set")
  })
})

describe("resetOptimisticRefs clears the optimistic refs", () => {
  test("after resetOptimisticRefs() a subsequent optimisticSend throws the guard; second reset is a no-op", async () => {
    const mgr = makeChildStores()
    mgr.ensureChild(DIR)
    let addCount = 0

    setActionRefs(stubSdk, mgr, () => DIR)
    setOptimisticRefs(() => { addCount += 1 }, () => {})

    resetOptimisticRefs()
    resetOptimisticRefs()

    let thrown: unknown
    try {
      await baseSend({ sessionId: "ses_after_reset" })
    } catch (error) {
      thrown = error
    }

    expect(thrown instanceof Error).toBe(true)
    expect((thrown as Error).message).toContain("Optimistic refs not set")
    expect(addCount).toBe(0)
  })
})
