import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2/client"

import { INITIAL_STATE, type State } from "../types"
import type { ChildStoreManager, DirectoryStore } from "../child-store"
import { setSyncRefs, resetSyncRefs } from "../sync-refs"
import { setActionRefs, resetActionRefs, forkFromMessage } from "../session-actions"
import { useSessionUIStore } from "@/sync/session-ui-store"
import { useDirectoryStore } from "@/stores/useDirectoryStore"
import { opencodeClient } from "@/lib/opencode/client"

// Real stores/reducers/resolvers run as production code. The only faked seam is
// the external I/O boundary (stub SDK session.messages + reassigned forkSession),
// injected via the public setSyncRefs/setActionRefs DI setters. No internal
// module is mock.module()'d. afterAll resets every injected seam so no stub
// leaks into later test files (resetSyncRefs/resetActionRefs return the modules
// to their pristine unmounted state).

const PROJ_A = "/projA"
const PROJ_B = "/projB"

function makeChildStores() {
  const children = new Map<string, StoreApi<DirectoryStore>>()
  const createChild = (sessions: State["session"] = []): StoreApi<DirectoryStore> =>
    create<DirectoryStore>()((set) => ({
      ...INITIAL_STATE,
      session: sessions,
      patch: (partial) => set(partial),
      replace: (next) => set(next),
    }))
  const mgr = {
    children,
    ensureChild: (directory: string) => {
      let store = children.get(directory)
      if (!store) {
        store = createChild()
        children.set(directory, store)
      }
      return store
    },
    getChild: (directory: string) => children.get(directory),
    getState: (directory: string) => children.get(directory)?.getState(),
  } as unknown as ChildStoreManager
  return { mgr, children, createChild }
}

function makeSession(id: string, directory: string): Session {
  return {
    id,
    title: id,
    directory,
    time: { created: 1, updated: 1 },
    version: "1",
  } as unknown as Session
}

const stubSdk = {
  session: {
    messages: async () => ({ data: [] }),
  },
} as unknown as OpencodeClient

const realForkSession = opencodeClient.forkSession.bind(opencodeClient)
const realGetDirectory = opencodeClient.getDirectory()

afterAll(() => {
  opencodeClient.forkSession = realForkSession
  opencodeClient.setDirectory(realGetDirectory)
  resetSyncRefs()
  resetActionRefs()
  useSessionUIStore.setState({
    currentSessionId: null,
    currentSessionDirectory: null,
    worktreeMetadata: new Map(),
  })
})

function wireRefs(childMgr: ChildStoreManager) {
  setSyncRefs(stubSdk, childMgr, "")
  setActionRefs(stubSdk, childMgr, () => "")
  useSessionUIStore.setState({
    currentSessionId: null,
    currentSessionDirectory: null,
    worktreeMetadata: new Map(),
  })
}

describe("setCurrentSession — directory poison removal (bug .20)", () => {
  beforeEach(() => {
    wireRefs(makeChildStores().mgr)
  })

  // Fails if the previous-project global fallback is reintroduced: currentSessionDirectory would become /projA.
  test("no hint + no authoritative dir stores NULL, never the previous project's global", () => {
    opencodeClient.setDirectory(PROJ_A)
    useDirectoryStore.setState({ currentDirectory: PROJ_A })

    useSessionUIStore.getState().setCurrentSession("ses_new_unknown", null)

    const stored = useSessionUIStore.getState().currentSessionDirectory
    expect(stored).toBeNull()
    expect(stored).not.toBe(PROJ_A)
    expect(opencodeClient.getDirectory()).not.toBe(PROJ_A)
  })

  // Fails if the fix over-corrects to always-null: an authoritative dir must still resolve.
  test("resolves an authoritative session directory when no hint is passed", () => {
    const { mgr, children, createChild } = makeChildStores()
    children.set(PROJ_B, createChild([makeSession("ses_b", PROJ_B)]))
    wireRefs(mgr)

    opencodeClient.setDirectory(PROJ_A)
    useSessionUIStore.getState().setCurrentSession("ses_b", null)

    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(PROJ_B)
  })

  // Fails if creators can no longer register a directory: the hint must win and be immediately resolvable.
  test("an explicit directory hint is stored and immediately resolvable", () => {
    opencodeClient.setDirectory(PROJ_A)

    useSessionUIStore.getState().setCurrentSession("ses_created", PROJ_B)

    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(PROJ_B)
    expect(useSessionUIStore.getState().getDirectoryForSession("ses_created")).toBe(PROJ_B)
  })

  // Mirrors the MultiRunLauncher/useMenuActions call sites: resolve the created
  // session's directory via getDirectoryForSession, pass it as the switch hint.
  // Fails if that resolve-then-hint path stops registering the directory.
  test("creator resolve-then-hint: a registered session's directory is resolved and stored on switch", () => {
    const { mgr, children, createChild } = makeChildStores()
    children.set(PROJ_B, createChild([makeSession("ses_multirun", PROJ_B)]))
    wireRefs(mgr)

    opencodeClient.setDirectory(PROJ_A)
    const store = useSessionUIStore.getState()
    const resolved = store.getDirectoryForSession("ses_multirun")
    expect(resolved).toBe(PROJ_B)

    store.setCurrentSession("ses_multirun", resolved)

    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(PROJ_B)
    expect(useSessionUIStore.getState().getDirectoryForSession("ses_multirun")).toBe(PROJ_B)
  })
})

describe("forkFromMessage — registers the parent session's directory (bug .20)", () => {
  beforeEach(() => {
    const { mgr, children, createChild } = makeChildStores()
    children.set(PROJ_B, createChild([makeSession("ses_parent", PROJ_B)]))
    setSyncRefs(stubSdk, mgr, "")
    setActionRefs(stubSdk, mgr, () => "")
    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      worktreeMetadata: new Map(),
    })
    opencodeClient.forkSession = (async () => makeSession("ses_forked", PROJ_B)) as typeof opencodeClient.forkSession
  })

  // Fails if the fork site drops the directory hint: the new session's directory would be null/leaked.
  test("forked session resolves the parent directory immediately after switch", async () => {
    opencodeClient.setDirectory(PROJ_A)

    await forkFromMessage("ses_parent", "msg_1")

    expect(useSessionUIStore.getState().currentSessionId).toBe("ses_forked")
    expect(useSessionUIStore.getState().getDirectoryForSession("ses_forked")).toBe(PROJ_B)
  })
})
