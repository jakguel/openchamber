/**
 * Regression tests for the fetchMessagesForSession SDK-not-initialized boot race.
 *
 * Background: setCurrentSession() fires `void fetchMessagesForSession()` before
 * SyncProvider installs refs via setSyncRefs()/setActionRefs(). The function
 * previously called `const s = sdk()` BEFORE its try/catch, so an un-mounted SDK
 * threw "SDK not initialized", producing an unhandled promise rejection on boot.
 *
 * Fix: isSyncReady() guard in fetchMessagesForSession returns early (no-op) when
 * the sync refs are not yet installed, without masking real mid-session errors.
 *
 * No internal module is mocked here. The ONLY fake is the OpenCode SDK client
 * object passed to setSyncRefs/setActionRefs — the external I/O boundary.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { OpencodeClient, Message, Part } from "@opencode-ai/sdk/v2/client"

import { INITIAL_STATE, type State } from "../types"
import type { ChildStoreManager, DirectoryStore } from "../child-store"
import { isSyncReady, setSyncRefs, resetSyncRefs } from "../sync-refs"
import { setActionRefs, resetActionRefs, fetchMessagesForSession } from "../session-actions"
import { useSessionUIStore } from "@/sync/session-ui-store"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DIR = "/proj/test"
const SESSION_ID = "ses_guard_test"

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
  } as unknown as ChildStoreManager
}

function makeMessage(id: string): Message {
  return {
    id,
    role: "user",
    time: { created: 1 },
    sessionID: SESSION_ID,
    path: { session: "", message: "" },
    metadata: {},
  } as unknown as Message
}

// ---------------------------------------------------------------------------
// Teardown — ensure refs are pristine after each test so tests don't bleed.
// ---------------------------------------------------------------------------

afterEach(() => {
  resetSyncRefs()
  resetActionRefs()
  useSessionUIStore.setState({ currentSessionId: null } as Parameters<typeof useSessionUIStore.setState>[0])
})

// ---------------------------------------------------------------------------
// AC1 — isSyncReady() tracks the SDK ref lifecycle
// ---------------------------------------------------------------------------

describe("isSyncReady() tracks ref lifecycle", () => {
  test("returns false before setSyncRefs()", () => {
    resetSyncRefs()
    expect(isSyncReady()).toBe(false)
  })

  test("returns true after setSyncRefs()", () => {
    const stubSdk = { session: { messages: async () => ({ data: [] }) } } as unknown as OpencodeClient
    setSyncRefs(stubSdk, makeChildStores(), DIR)
    expect(isSyncReady()).toBe(true)
  })

  test("returns false again after resetSyncRefs()", () => {
    const stubSdk = { session: { messages: async () => ({ data: [] }) } } as unknown as OpencodeClient
    setSyncRefs(stubSdk, makeChildStores(), DIR)
    expect(isSyncReady()).toBe(true)
    resetSyncRefs()
    expect(isSyncReady()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC2 + AC4 — fetchMessagesForSession is a clean no-op when refs are unset
// ---------------------------------------------------------------------------

describe("fetchMessagesForSession with refs UNSET", () => {
  test("resolves without throwing (no unhandled rejection) when SDK is not initialized", async () => {
    // Refs explicitly unset; without the guard this throws 'SDK not initialized'.
    resetSyncRefs()
    resetActionRefs()

    // Provide a non-null directory so the early 'if (!resolvedDir) return' guard
    // does NOT trigger — only the isSyncReady() guard should fire.
    let threw = false
    try {
      await fetchMessagesForSession(SESSION_ID, DIR)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })

  test("writes nothing to the child store when refs are unset", async () => {
    const mgr = makeChildStores()
    const store = mgr.ensureChild(DIR)
    const snapshotBefore = store.getState().message

    resetSyncRefs()
    resetActionRefs()

    await fetchMessagesForSession(SESSION_ID, DIR)

    // Store state must be unchanged — no messages written.
    expect(store.getState().message).toBe(snapshotBefore)
  })
})

// ---------------------------------------------------------------------------
// AC3 — fetchMessagesForSession materializes messages when refs ARE set
// ---------------------------------------------------------------------------

describe("fetchMessagesForSession with refs SET", () => {
  test("materializes messages from SDK into the child store", async () => {
    const msg = makeMessage("msg_001")
    const fakeSdk = {
      session: {
        messages: async () => ({
          data: [{ info: msg, parts: [] as Part[] }],
        }),
      },
    } as unknown as OpencodeClient

    const mgr = makeChildStores()
    mgr.ensureChild(DIR) // ensure child store exists before mount

    setSyncRefs(fakeSdk, mgr, DIR)
    setActionRefs(fakeSdk, mgr, () => DIR)

    // The staleness guard checks currentSessionId; must match for store write.
    useSessionUIStore.setState({ currentSessionId: SESSION_ID } as Parameters<typeof useSessionUIStore.setState>[0])

    await fetchMessagesForSession(SESSION_ID, DIR)

    const messages = mgr.ensureChild(DIR).getState().message[SESSION_ID]
    expect(messages !== undefined).toBe(true)
    expect((messages ?? []).length > 0).toBe(true)
    expect((messages ?? [])[0]?.id).toBe("msg_001")
  })

  test("real session.messages errors still reach the existing catch (guard does not mask mid-session errors)", async () => {
    // When SDK IS set and session.messages returns an error response,
    // fetchMessagesForSession must NOT propagate the error (existing catch
    // swallows it as-designed), and the guard must not swallow it prematurely.
    const fakeSdk = {
      session: {
        messages: async () => ({
          error: { message: "network error" },
          response: { status: 500 },
        }),
      },
    } as unknown as OpencodeClient

    const mgr = makeChildStores()
    mgr.ensureChild(DIR)
    setSyncRefs(fakeSdk, mgr, DIR)
    setActionRefs(fakeSdk, mgr, () => DIR)

    useSessionUIStore.setState({ currentSessionId: SESSION_ID } as Parameters<typeof useSessionUIStore.setState>[0])

    let threw = false
    try {
      await fetchMessagesForSession(SESSION_ID, DIR)
    } catch {
      threw = true
    }
    // The existing catch in fetchMessagesForSession swallows transient errors.
    expect(threw).toBe(false)
    // And no messages were written.
    expect(mgr.ensureChild(DIR).getState().message[SESSION_ID]).toBe(undefined)
  })
})
