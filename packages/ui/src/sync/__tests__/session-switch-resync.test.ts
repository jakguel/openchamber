import { describe, expect, test, beforeEach, mock } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2/client"

const listPendingQuestionsCalls: Array<{ directories?: Array<string | null | undefined> }> = []
const listPendingPermissionsCalls: Array<{ directories?: Array<string | null | undefined> }> = []
let pendingQuestionsResponse: QuestionRequest[] = []
let pendingPermissionsResponse: PermissionRequest[] = []
let pendingQuestionsShouldThrow = false
let pendingPermissionsShouldThrow = false

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    listPendingQuestions: mock(async (opts?: { directories?: Array<string | null | undefined> }) => {
      listPendingQuestionsCalls.push(opts ?? {})
      if (pendingQuestionsShouldThrow) throw new Error("question.list failed: simulated")
      return pendingQuestionsResponse
    }),
    listPendingPermissions: mock(async (opts?: { directories?: Array<string | null | undefined> }) => {
      listPendingPermissionsCalls.push(opts ?? {})
      if (pendingPermissionsShouldThrow) throw new Error("permission.list failed: simulated")
      return pendingPermissionsResponse
    }),
    getDirectory: () => "/repo",
    getScopedSdkClient: () => ({}),
    setDirectory: () => undefined,
  },
}))

mock.module("@/stores/permissionStore", () => ({
  usePermissionStore: {
    getState: () => ({ isSessionAutoAccepting: () => false }),
  },
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({ isConnected: true, hasEverConnected: true }),
    setState: () => undefined,
  },
}))

mock.module("@/stores/useTodosPersistStore", () => ({
  useTodosPersistStore: { getState: () => ({}) },
}))

mock.module("@/components/ui", () => ({
  toast: { info: () => undefined, error: () => undefined, success: () => undefined, dismiss: () => undefined },
}))

import { INITIAL_STATE, type State } from "../types"
import type { DirectoryStore } from "../child-store"
import { resyncBlockingRequestsForDirectory } from "../sync-context"
import {
  answeredRequestIds,
  addAnsweredRequestId,
  clearAnsweredRequestId,
  clearAnsweredRequestIds,
} from "../session-actions"

function buildQuestion(overrides: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    id: "que_1",
    sessionID: "ses_a",
    questions: [{ question: "Continue?", header: "Q", options: [{ label: "Yes", description: "" }] }],
    ...overrides,
  } as QuestionRequest
}

function buildPermission(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "perm_1",
    sessionID: "ses_a",
    permission: "bash",
    patterns: [],
    metadata: {},
    always: [],
    ...overrides,
  } as PermissionRequest
}

function createDirectoryStore(initial: Partial<State>): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    session: initial.session ?? [{ id: "ses_a", title: "ses_a", time: { created: 1, updated: 1 }, version: "1" } as State["session"][number]],
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

describe("resyncBlockingRequestsForDirectory", () => {
  beforeEach(() => {
    listPendingQuestionsCalls.length = 0
    listPendingPermissionsCalls.length = 0
    pendingQuestionsResponse = []
    pendingPermissionsResponse = []
    pendingQuestionsShouldThrow = false
    pendingPermissionsShouldThrow = false
  })

  test("calls listPendingQuestions and listPendingPermissions exactly once for the directory", async () => {
    const store = createDirectoryStore({})
    pendingQuestionsResponse = [buildQuestion()]
    pendingPermissionsResponse = [buildPermission()]

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(listPendingQuestionsCalls).toHaveLength(1)
    expect(listPendingQuestionsCalls[0]).toEqual({ directories: ["/repo"] })
    expect(listPendingPermissionsCalls).toHaveLength(1)
    expect(listPendingPermissionsCalls[0]).toEqual({ directories: ["/repo"] })
  })

  test("merges newly fetched questions/permissions into the directory store", async () => {
    const store = createDirectoryStore({})
    pendingQuestionsResponse = [buildQuestion()]
    pendingPermissionsResponse = [buildPermission()]

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(store.getState().question["ses_a"]).toHaveLength(1)
    expect(store.getState().question["ses_a"]?.[0]?.id).toBe("que_1")
    expect(store.getState().permission["ses_a"]).toHaveLength(1)
    expect(store.getState().permission["ses_a"]?.[0]?.id).toBe("perm_1")
  })

  test("preserves an in-flight SSE-delivered question whose signature changed during the fetch", async () => {
    const store = createDirectoryStore({
      question: { ses_a: [{ ...buildQuestion(), id: "que_initial" }] },
    })
    pendingQuestionsResponse = []

    const promise = resyncBlockingRequestsForDirectory("/repo", store)
    store.setState({
      question: { ses_a: [{ ...buildQuestion(), id: "que_sse_arrived" }] },
    })
    await promise

    expect(store.getState().question["ses_a"]).toHaveLength(1)
    expect(store.getState().question["ses_a"]?.[0]?.id).toBe("que_sse_arrived")
  })

  test("clears stale entries when API returns no pending requests and signature unchanged", async () => {
    const store = createDirectoryStore({
      question: { ses_a: [{ ...buildQuestion(), id: "que_stale" }] },
    })
    pendingQuestionsResponse = []
    pendingPermissionsResponse = []

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(store.getState().question["ses_a"]).toEqual(undefined)
  })

  test("ignores questions for sessions the directory does not know about", async () => {
    const store = createDirectoryStore({})
    pendingQuestionsResponse = [{ ...buildQuestion(), sessionID: "ses_unknown" }]

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(store.getState().question["ses_unknown"]).toEqual(undefined)
  })

  test("returns early without fetching when no candidate sessions are known", async () => {
    const store = createDirectoryStore({ session: [] })
    await resyncBlockingRequestsForDirectory("/repo", store)
    expect(listPendingQuestionsCalls).toHaveLength(0)
    expect(listPendingPermissionsCalls).toHaveLength(0)
  })

  // Regression: prior to the fix, listPendingQuestions silently returned [] on
  // fetch failure, indistinguishable from a successful empty server response.
  // The resync then walked the candidate set and deleted any question that
  // wasn't in the (empty) result — wiping legitimate in-flight prompts on a
  // transient network blip. The client method now throws on failure and the
  // outer try/catch preserves existing state.
  test("preserves existing questions when listPendingQuestions throws (transient fetch failure)", async () => {
    const store = createDirectoryStore({
      question: { ses_a: [{ ...buildQuestion(), id: "que_in_flight" }] },
    })
    pendingQuestionsShouldThrow = true

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(store.getState().question["ses_a"]).toHaveLength(1)
    expect(store.getState().question["ses_a"]?.[0]?.id).toBe("que_in_flight")
  })

  test("preserves existing permissions when listPendingPermissions throws (transient fetch failure)", async () => {
    const store = createDirectoryStore({
      permission: { ses_a: [{ ...buildPermission(), id: "perm_in_flight" }] },
    })
    pendingPermissionsShouldThrow = true

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(store.getState().permission["ses_a"]).toHaveLength(1)
    expect(store.getState().permission["ses_a"]?.[0]?.id).toBe("perm_in_flight")
  })

  test("permission fetch failure does not block question resync (and vice versa)", async () => {
    const store = createDirectoryStore({})
    pendingQuestionsResponse = [buildQuestion()]
    pendingPermissionsShouldThrow = true

    await resyncBlockingRequestsForDirectory("/repo", store)

    // Question block ran successfully despite permission block failing.
    expect(store.getState().question["ses_a"]).toHaveLength(1)
    expect(store.getState().question["ses_a"]?.[0]?.id).toBe("que_1")
    expect(listPendingPermissionsCalls).toHaveLength(1)
  })
})

describe("answeredRequestIds guard", () => {
  beforeEach(() => {
    answeredRequestIds.clear()
    listPendingQuestionsCalls.length = 0
    listPendingPermissionsCalls.length = 0
    pendingQuestionsResponse = []
    pendingPermissionsResponse = []
    pendingQuestionsShouldThrow = false
    pendingPermissionsShouldThrow = false
  })

  // AC3: a question the user already answered must never be re-added by resync.
  test("resync does NOT restore a question that is in answeredRequestIds", async () => {
    const store = createDirectoryStore({})
    pendingQuestionsResponse = [buildQuestion({ id: "que_answered" })]
    addAnsweredRequestId("/repo", "que_answered")

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(store.getState().question["ses_a"]).toEqual(undefined)
  })

  // AC3: answered IDs are skipped while still-pending questions are restored.
  test("resync restores questions NOT in answeredRequestIds while skipping answered ones", async () => {
    const store = createDirectoryStore({})
    pendingQuestionsResponse = [
      buildQuestion({ id: "que_answered" }),
      buildQuestion({ id: "que_pending", sessionID: "ses_a" }),
    ]
    addAnsweredRequestId("/repo", "que_answered")

    await resyncBlockingRequestsForDirectory("/repo", store)

    // Only the unanswered question survives the guard; answered one is dropped.
    const ids = (store.getState().question["ses_a"] ?? []).map((q) => q.id)
    expect(ids).toEqual(["que_pending"])
  })

  // AC4: SSE cleanup removes the specific answered id from the directory set.
  test("clearAnsweredRequestId removes the specific requestId from the set", () => {
    addAnsweredRequestId("/repo", "que_1")
    addAnsweredRequestId("/repo", "que_2")

    clearAnsweredRequestId("/repo", "que_1")

    expect(answeredRequestIds.get("/repo")?.has("que_1")).toBe(false)
    expect(answeredRequestIds.get("/repo")?.has("que_2")).toBe(true)
  })

  test("clearAnsweredRequestId is a no-op when the directory has no entry", () => {
    clearAnsweredRequestId("/nonexistent", "que_1")
    expect(answeredRequestIds.has("/nonexistent")).toBe(false)
  })

  // AC5: directory eviction drops the whole answered set for that directory.
  test("clearAnsweredRequestIds removes the entire directory entry", () => {
    addAnsweredRequestId("/repo", "que_1")
    addAnsweredRequestId("/repo", "que_2")

    clearAnsweredRequestIds("/repo")

    expect(answeredRequestIds.has("/repo")).toBe(false)
  })

  test("clearAnsweredRequestIds on one directory does not affect another directory", () => {
    addAnsweredRequestId("/repo-a", "que_1")
    addAnsweredRequestId("/repo-b", "que_2")

    clearAnsweredRequestIds("/repo-a")

    expect(answeredRequestIds.has("/repo-a")).toBe(false)
    expect(answeredRequestIds.get("/repo-b")?.has("que_2")).toBe(true)
  })
})
