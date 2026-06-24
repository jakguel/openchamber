import { beforeEach, describe, expect, mock, test } from "bun:test"
import type {
  Event,
  Message,
  OpencodeClient,
  Part,
  PermissionRequest,
  QuestionRequest,
  SessionStatus,
} from "@opencode-ai/sdk/v2/client"
import { create, type StoreApi } from "zustand"
import { applyDirectoryEvent, applyOptimisticQuestionAction, finalizeOrphanedRunningParts, hasAnyRunningPart } from "../event-reducer"
import { INITIAL_STATE, type State } from "../types"
import type { ChildStoreManager, DirectoryStore } from "../child-store"

// Question lifecycle fixtures (AC1/AC2/AC4): mock only the SDK client and the
// connection gate respondToQuestion needs; tests dynamic-import session-actions
// so these mocks register before the module evaluates.
let questionReplyShouldThrow = false
let onQuestionReplyInvoked: (() => void) | null = null
const scopedReplyDirectories: string[] = []

const mockQuestionClient = {
  question: {
    reply: mock(async () => {
      onQuestionReplyInvoked?.()
      if (questionReplyShouldThrow) throw new Error("simulated reply failure")
      return { data: true }
    }),
    reject: mock(async () => {
      onQuestionReplyInvoked?.()
      if (questionReplyShouldThrow) throw new Error("simulated reject failure")
      return { data: true }
    }),
  },
}

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getScopedSdkClient: (directory: string) => {
      scopedReplyDirectories.push(directory)
      return mockQuestionClient
    },
    getDirectory: () => "/test/project",
    setDirectory: () => undefined,
  },
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({ isConnected: true, hasEverConnected: true }),
  },
}))

mock.module("@/stores/permissionStore", () => ({
  usePermissionStore: {
    getState: () => ({ isSessionAutoAccepting: () => false }),
  },
}))

mock.module("@/stores/useTodosPersistStore", () => ({
  useTodosPersistStore: { getState: () => ({}) },
}))

mock.module("@/components/ui", () => ({
  toast: { info: () => undefined, error: () => undefined, success: () => undefined, dismiss: () => undefined },
}))

function makeQuestion(id: string, sessionID = "ses_a"): QuestionRequest {
  return {
    id,
    sessionID,
    questions: [{ question: "Continue?", header: "Q", options: [{ label: "Yes", description: "Proceed" }] }],
  } as QuestionRequest
}

function createQuestionStore(sessionID: string, questions: QuestionRequest[]): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    question: { [sessionID]: questions },
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

function makeChildStores(entries: Array<[string, StoreApi<DirectoryStore>]>) {
  return {
    children: new Map(entries),
    ensureChild: (directory: string) => {
      const store = new Map(entries).get(directory)
      if (!store) throw new Error(`No store for ${directory}`)
      return store
    },
    getChild: (directory: string) => new Map(entries).get(directory),
  } as unknown as ChildStoreManager
}

function state(overrides: Partial<State> = {}): State {
  return {
    ...INITIAL_STATE,
    message: {},
    part: {},
    session_status: {},
    ...overrides,
  }
}

function deltaEvent(): Event {
  return {
    type: "message.part.delta",
    properties: {
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: "hello",
    },
  } as Event
}

function partUpdatedEvent(): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_1",
        messageID: "msg_1",
        sessionID: "ses_1",
        type: "text",
        text: "hello",
      },
    },
  } as Event
}

function topLevelSessionOnlyPartUpdatedEvent(): Event {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: "ses_1",
      part: {
        id: "prt_1",
        messageID: "msg_1",
        type: "text",
        text: "hello",
      },
    },
  } as Event
}

describe("applyDirectoryEvent", () => {
  test("returns typed materialization when delta arrives before parts", () => {
    const result = applyDirectoryEvent(state(), deltaEvent())

    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", messageID: "msg_1", partID: "prt_1" },
    })
  })

  test("returns typed materialization when delta part is missing", () => {
    const result = applyDirectoryEvent(
      state({ part: { msg_1: [{ id: "prt_2", messageID: "msg_1", type: "text", text: "" } as Part] } }),
      deltaEvent(),
    )

    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", messageID: "msg_1", partID: "prt_1" },
    })
  })

  test("applies part update and requests materialization when owning message is absent", () => {
    const draft = state()
    const result = applyDirectoryEvent(draft, partUpdatedEvent())

    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result).toEqual({
      changed: true,
      materialization: {
        type: "incomplete-session-snapshot",
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
      },
    })
  })

  test("uses top-level session id and part message id for part update materialization", () => {
    const draft = state()
    const result = applyDirectoryEvent(draft, topLevelSessionOnlyPartUpdatedEvent())

    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result).toEqual({
      changed: true,
      materialization: {
        type: "incomplete-session-snapshot",
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
      },
    })
  })

  test("uses top-level session id for delta materialization", () => {
    const result = applyDirectoryEvent(state(), {
      type: "message.part.delta",
      properties: {
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
        field: "text",
        delta: "hello",
      },
    } as Event)

    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", sessionID: "ses_1", messageID: "msg_1", partID: "prt_1" },
    })
  })

  test("applies part update without materialization when owning message exists", () => {
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as never] },
    })
    const result = applyDirectoryEvent(draft, partUpdatedEvent())

    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result).toBe(true)
  })

  test("skips duplicate session status events", () => {
    const draft = state()
    const busyStatus = { type: "busy" } as SessionStatus
    const event = {
      type: "session.status",
      properties: { sessionID: "ses_1", status: busyStatus },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1

    expect(applyDirectoryEvent(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("skips duplicate session idle events", () => {
    const draft = state()
    const event = {
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1

    expect(applyDirectoryEvent(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("skips duplicate session error idle-state events", () => {
    const draft = state()
    const event = {
      type: "session.error",
      properties: { sessionID: "ses_1" },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1

    expect(applyDirectoryEvent(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("detects retry status metadata changes", () => {
    const draft = state({
      session_status: {
        ses_1: { type: "retry", attempt: 1, message: "rate limited", next: 10 } as SessionStatus,
      },
    })

    const event = {
      type: "session.status",
      properties: {
        sessionID: "ses_1",
        status: { type: "retry", attempt: 2, message: "rate limited", next: 20 } as SessionStatus,
      },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    expect((draft.session_status.ses_1 as Extract<SessionStatus, { type: "retry" }>).attempt).toBe(2)
  })

  test("updates permission request arrays immutably", () => {
    const initialPermissions = [
      { id: "perm_1", sessionID: "ses_1" } as PermissionRequest,
    ]
    const draft = state({ permission: { ses_1: initialPermissions } })

    applyDirectoryEvent(draft, {
      type: "permission.asked",
      properties: { id: "perm_2", sessionID: "ses_1" } as PermissionRequest,
    } as Event)

    expect(draft.permission.ses_1).not.toBe(initialPermissions)
    expect(draft.permission.ses_1.map((item) => item.id)).toEqual(["perm_1", "perm_2"])

    const afterAsk = draft.permission.ses_1
    applyDirectoryEvent(draft, {
      type: "permission.replied",
      properties: { sessionID: "ses_1", requestID: "perm_1" },
    } as Event)

    expect(draft.permission.ses_1).not.toBe(afterAsk)
    expect(draft.permission.ses_1.map((item) => item.id)).toEqual(["perm_2"])
  })

  test("updates question request arrays immutably", () => {
    const initialQuestions = [
      { id: "ques_1", sessionID: "ses_1" } as QuestionRequest,
    ]
    const draft = state({ question: { ses_1: initialQuestions } })

    applyDirectoryEvent(draft, {
      type: "question.asked",
      properties: { id: "ques_2", sessionID: "ses_1" } as QuestionRequest,
    } as Event)

    expect(draft.question.ses_1).not.toBe(initialQuestions)
    expect(draft.question.ses_1.map((item) => item.id)).toEqual(["ques_1", "ques_2"])

    const afterAsk = draft.question.ses_1
    applyDirectoryEvent(draft, {
      type: "question.replied",
      properties: { sessionID: "ses_1", requestID: "ques_1" },
    } as Event)

    expect(draft.question.ses_1).not.toBe(afterAsk)
    expect(draft.question.ses_1.map((item) => item.id)).toEqual(["ques_2"])

    const afterReply = draft.question.ses_1
    applyDirectoryEvent(draft, {
      type: "question.rejected",
      properties: { sessionID: "ses_1", requestID: "ques_2" },
    } as Event)

    expect(draft.question.ses_1).not.toBe(afterReply)
    expect(draft.question.ses_1).toEqual([])
  })
})

describe("applyOptimisticQuestionAction", () => {
  test("removes question from store when question.optimistic-remove matches", () => {
    const initialQuestions = [
      { id: "que_1", sessionID: "ses_1" } as QuestionRequest,
      { id: "que_2", sessionID: "ses_1" } as QuestionRequest,
    ]
    const draft = state({ question: { ses_1: initialQuestions } })

    const changed = applyOptimisticQuestionAction(draft, {
      type: "question.optimistic-remove",
      sessionID: "ses_1",
      requestID: "que_1",
    })

    expect(changed).toBe(true)
    expect(draft.question.ses_1).not.toBe(initialQuestions)
    expect(draft.question.ses_1.map((q) => q.id)).toEqual(["que_2"])
  })

  test("returns false when question.optimistic-remove targets an absent ID", () => {
    const draft = state({ question: { ses_1: [{ id: "que_1", sessionID: "ses_1" } as QuestionRequest] } })

    const changed = applyOptimisticQuestionAction(draft, {
      type: "question.optimistic-remove",
      sessionID: "ses_1",
      requestID: "que_does_not_exist",
    })

    expect(changed).toBe(false)
    expect(draft.question.ses_1).toHaveLength(1)
  })

  test("re-inserts question in sorted order on question.optimistic-restore (rollback)", () => {
    const remaining = { id: "que_2", sessionID: "ses_1" } as QuestionRequest
    const draft = state({ question: { ses_1: [remaining] } })
    const removed = { id: "que_1", sessionID: "ses_1" } as QuestionRequest

    const changed = applyOptimisticQuestionAction(draft, {
      type: "question.optimistic-restore",
      question: removed,
    })

    expect(changed).toBe(true)
    expect(draft.question.ses_1.map((q) => q.id)).toEqual(["que_1", "que_2"])
  })

  test("initialises empty session array on question.optimistic-restore when none existed", () => {
    const draft = state({ question: {} })
    const question = { id: "que_1", sessionID: "ses_1" } as QuestionRequest

    applyOptimisticQuestionAction(draft, {
      type: "question.optimistic-restore",
      question,
    })

    expect(draft.question.ses_1).toHaveLength(1)
    expect(draft.question.ses_1.map((q) => q.id)).toEqual(["que_1"])
  })
})

describe("respondToQuestion question lifecycle", () => {
  beforeEach(async () => {
    questionReplyShouldThrow = false
    onQuestionReplyInvoked = null
    scopedReplyDirectories.length = 0
    const { answeredRequestIds } = await import("../session-actions")
    answeredRequestIds.clear()
  })

  test("optimistically removes the question from the store before the reply resolves", async () => {
    const { setActionRefs, respondToQuestion } = await import("../session-actions")
    const store = createQuestionStore("ses_a", [makeQuestion("q-ac1")])
    const childStores = makeChildStores([["/test/project", store]])
    setActionRefs(mockQuestionClient as unknown as OpencodeClient, childStores, () => "/test/project")

    let questionsPresentWhenReplyRan = -1
    onQuestionReplyInvoked = () => {
      questionsPresentWhenReplyRan = store.getState().question["ses_a"]?.length ?? 0
    }

    expect(store.getState().question["ses_a"]).toHaveLength(1)
    await respondToQuestion("ses_a", "q-ac1", [["Yes"]])

    expect(questionsPresentWhenReplyRan).toBe(0)
    expect(store.getState().question["ses_a"] ?? []).toHaveLength(0)
    expect(scopedReplyDirectories).toEqual(["/test/project"])
  })

  test("rolls back and restores the question when the reply fails", async () => {
    const { setActionRefs, respondToQuestion } = await import("../session-actions")
    const store = createQuestionStore("ses_a", [makeQuestion("q-ac2")])
    const childStores = makeChildStores([["/test/project", store]])
    setActionRefs(mockQuestionClient as unknown as OpencodeClient, childStores, () => "/test/project")
    questionReplyShouldThrow = true

    expect(store.getState().question["ses_a"]).toHaveLength(1)

    let thrown: unknown
    try {
      await respondToQuestion("ses_a", "q-ac2", [["Yes"]])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect(store.getState().question["ses_a"]).toHaveLength(1)
    expect(store.getState().question["ses_a"]?.[0]?.id).toBe("q-ac2")
  })

  test("clears the answered guard when question.replied confirms the answer", async () => {
    const { setActionRefs, respondToQuestion, clearAnsweredRequestId, answeredRequestIds } = await import(
      "../session-actions"
    )
    const store = createQuestionStore("ses_a", [makeQuestion("q-ac4")])
    const childStores = makeChildStores([["/test/project", store]])
    setActionRefs(mockQuestionClient as unknown as OpencodeClient, childStores, () => "/test/project")

    await respondToQuestion("ses_a", "q-ac4", [["Yes"]])
    expect(answeredRequestIds.get("/test/project")?.has("q-ac4")).toBe(true)

    // The SSE question.replied / question.rejected handler confirms the answer
    // and drops the guard via clearAnsweredRequestId (sync-context.tsx).
    clearAnsweredRequestId("/test/project", "q-ac4")
    expect(answeredRequestIds.get("/test/project")?.has("q-ac4") ?? false).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// WI1: finalizeOrphanedRunningParts + hasAnyRunningPart
// Pure-helper tests. No mocks: real reducer code, real State/Part fixtures.
// ---------------------------------------------------------------------------

const ORPHANED_ERROR = "orphaned: opencode upstream stopped before reporting completion"

function assistantMessage(id: string, sessionID: string): Message {
  return { id, sessionID, role: "assistant", time: { created: 1 } } as Message
}

function runningTool(id: string, messageID: string, sessionID: string, start = 1_000): Part {
  return {
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: `call_${id}`,
    tool: "bash",
    state: { status: "running", input: { command: "sleep 999" }, time: { start } },
  } as Part
}

// A malformed running tool part whose state carries no `time` — models wire data
// that violates the SDK type so the defensive `state.time?.start ?? Date.now()`
// fallback is exercised.
function runningToolNoTime(id: string, messageID: string, sessionID: string): Part {
  return {
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: `call_${id}`,
    tool: "bash",
    state: { status: "running", input: {} },
  } as Part
}

function completedTool(id: string, messageID: string, sessionID: string): Part {
  return {
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: `call_${id}`,
    tool: "bash",
    state: { status: "completed", input: {}, output: "ok", title: "bash", metadata: {}, time: { start: 1, end: 2 } },
  } as Part
}

function pendingTool(id: string, messageID: string, sessionID: string): Part {
  return {
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: `call_${id}`,
    tool: "bash",
    state: { status: "pending", input: {}, raw: "" },
  } as Part
}

function textPart(id: string, messageID: string, sessionID: string): Part {
  return { id, sessionID, messageID, type: "text", text: "hello" } as Part
}

// Narrowing accessor: returns the tool state so assertions can discriminate on
// `status` without casts.
function toolState(part: Part | undefined) {
  if (!part || part.type !== "tool") throw new Error("expected a tool part")
  return part.state
}

describe("finalizeOrphanedRunningParts", () => {
  test("finalizes a running tool part into a ToolStateError stamp (time.end >= time.start)", () => {
    const draft = state({
      message: { ses_1: [assistantMessage("msg_1", "ses_1")] },
      part: { msg_1: [runningTool("prt_1", "msg_1", "ses_1", 5_000)] },
    })

    const before = Date.now()
    const changed = finalizeOrphanedRunningParts(draft, "ses_1")
    const after = Date.now()

    expect(changed).toBe(true)
    const st = toolState(draft.part.msg_1[0])
    expect(st.status).toBe("error")
    if (st.status === "error") {
      expect(st.error).toBe(ORPHANED_ERROR)
      expect(st.input).toEqual({ command: "sleep 999" })
      expect(st.time.start).toBe(5_000)
      // AC2: end >= start. Here end is stamped to "now" (Math.max(5000, Date.now())),
      // strictly greater than the preserved start of 5000.
      expect(st.time.end).toBeGreaterThan(st.time.start)
      // end == Date.now() at finalize, i.e. within [before, after] (Date.now() is integer ms).
      expect(st.time.end).toBeGreaterThan(before - 1)
      expect(st.time.end).toBeLessThan(after + 1)
    }
  })

  test("returns false and leaves draft.part untouched when there are no running parts", () => {
    const parts = [completedTool("prt_1", "msg_1", "ses_1"), textPart("prt_2", "msg_1", "ses_1")]
    const partMap = { msg_1: parts }
    const draft = state({
      message: { ses_1: [assistantMessage("msg_1", "ses_1")] },
      part: partMap,
    })

    const changed = finalizeOrphanedRunningParts(draft, "ses_1")

    expect(changed).toBe(false)
    // Outer map AND inner array identity preserved — no CoW occurred.
    expect(draft.part).toBe(partMap)
    expect(draft.part.msg_1).toBe(parts)
    expect(toolState(draft.part.msg_1[0]).status).toBe("completed")
  })

  test("returns false when the session has no messages", () => {
    const partMap = {}
    const draft = state({ message: {}, part: partMap })

    expect(finalizeOrphanedRunningParts(draft, "ses_absent")).toBe(false)
    expect(draft.part).toBe(partMap)
  })

  test("outer-map CoW: clones draft.part once and leaves the original map object unmutated", () => {
    const originalMap = { msg_1: [runningTool("prt_1", "msg_1", "ses_1")] }
    const draft = state({
      message: { ses_1: [assistantMessage("msg_1", "ses_1")] },
      part: originalMap,
    })

    const changed = finalizeOrphanedRunningParts(draft, "ses_1")

    expect(changed).toBe(true)
    // draft.part is a NEW reference (outer CoW happened)...
    expect(draft.part).not.toBe(originalMap)
    // ...and the ORIGINAL map's array was not mutated in place: still running.
    expect(toolState(originalMap.msg_1[0]).status).toBe("running")
    // the cloned map carries the finalized part.
    expect(toolState(draft.part.msg_1[0]).status).toBe("error")
  })

  test("inner-array CoW: clones the parts array once and leaves the original array unmutated", () => {
    const originalParts = [
      runningTool("prt_1", "msg_1", "ses_1"),
      runningTool("prt_2", "msg_1", "ses_1"),
    ]
    const draft = state({
      message: { ses_1: [assistantMessage("msg_1", "ses_1")] },
      part: { msg_1: originalParts },
    })

    const changed = finalizeOrphanedRunningParts(draft, "ses_1")

    expect(changed).toBe(true)
    // New array reference for the touched message (inner CoW)...
    expect(draft.part.msg_1).not.toBe(originalParts)
    // ...both running parts finalized in the new array...
    expect(toolState(draft.part.msg_1[0]).status).toBe("error")
    expect(toolState(draft.part.msg_1[1]).status).toBe("error")
    // ...while the ORIGINAL array's elements remain running (not mutated in place).
    expect(toolState(originalParts[0]).status).toBe("running")
    expect(toolState(originalParts[1]).status).toBe("running")
  })

  test("only running tool parts are finalized; pending, terminal, and non-tool parts are left intact", () => {
    const draft = state({
      message: { ses_1: [assistantMessage("msg_1", "ses_1")] },
      part: {
        msg_1: [
          textPart("prt_text", "msg_1", "ses_1"),
          pendingTool("prt_pending", "msg_1", "ses_1"),
          runningTool("prt_run", "msg_1", "ses_1"),
          completedTool("prt_done", "msg_1", "ses_1"),
        ],
      },
    })

    const changed = finalizeOrphanedRunningParts(draft, "ses_1")

    expect(changed).toBe(true)
    expect(draft.part.msg_1[0].type).toBe("text")
    expect(toolState(draft.part.msg_1[1]).status).toBe("pending")
    expect(toolState(draft.part.msg_1[2]).status).toBe("error")
    expect(toolState(draft.part.msg_1[3]).status).toBe("completed")
  })

  test("re-running on already-finalized parts is idempotent (returns false, no further mutation)", () => {
    const draft = state({
      message: { ses_1: [assistantMessage("msg_1", "ses_1")] },
      part: { msg_1: [runningTool("prt_1", "msg_1", "ses_1")] },
    })

    expect(finalizeOrphanedRunningParts(draft, "ses_1")).toBe(true)
    const finalizedMap = draft.part
    const finalizedArray = draft.part.msg_1

    // Second pass: the synthetic error is terminal, not running → no work.
    expect(finalizeOrphanedRunningParts(draft, "ses_1")).toBe(false)
    expect(draft.part).toBe(finalizedMap)
    expect(draft.part.msg_1).toBe(finalizedArray)
  })

  test("falls back to Date.now() when a running part is missing time.start", () => {
    const draft = state({
      message: { ses_1: [assistantMessage("msg_1", "ses_1")] },
      part: { msg_1: [runningToolNoTime("prt_1", "msg_1", "ses_1")] },
    })

    const before = Date.now()
    const changed = finalizeOrphanedRunningParts(draft, "ses_1")
    const after = Date.now()

    expect(changed).toBe(true)
    const st = toolState(draft.part.msg_1[0])
    expect(st.status).toBe("error")
    if (st.status === "error") {
      // start fell back to Date.now(), i.e. within [before, after] (Date.now() is integer ms).
      expect(st.time.start).toBeGreaterThan(before - 1)
      expect(st.time.start).toBeLessThan(after + 1)
      // AC2: end >= start. start and end are captured ~the same instant and may be equal;
      // (end + 1) > start is the integer-safe encoding of end >= start.
      expect(st.time.end + 1).toBeGreaterThan(st.time.start)
      expect(st.time.end).toBeLessThan(after + 1)
    }
  })

  test("only finalizes parts belonging to the requested session", () => {
    const draft = state({
      message: {
        ses_1: [assistantMessage("msg_1", "ses_1")],
        ses_2: [assistantMessage("msg_2", "ses_2")],
      },
      part: {
        msg_1: [runningTool("prt_1", "msg_1", "ses_1")],
        msg_2: [runningTool("prt_2", "msg_2", "ses_2")],
      },
    })

    const changed = finalizeOrphanedRunningParts(draft, "ses_1")

    expect(changed).toBe(true)
    expect(toolState(draft.part.msg_1[0]).status).toBe("error")
    // ses_2's running part is untouched.
    expect(toolState(draft.part.msg_2[0]).status).toBe("running")
  })
})

describe("hasAnyRunningPart", () => {
  test("true when a running tool part exists, false for terminal/non-tool/empty", () => {
    const msgs = { ses_1: [assistantMessage("msg_1", "ses_1")] }

    // running present → true
    expect(hasAnyRunningPart(
      state({ message: msgs, part: { msg_1: [runningTool("p1", "msg_1", "ses_1")] } }),
      "ses_1",
    )).toBe(true)

    // only completed → false
    expect(hasAnyRunningPart(
      state({ message: msgs, part: { msg_1: [completedTool("p1", "msg_1", "ses_1")] } }),
      "ses_1",
    )).toBe(false)

    // only pending → false (pending is not running)
    expect(hasAnyRunningPart(
      state({ message: msgs, part: { msg_1: [pendingTool("p1", "msg_1", "ses_1")] } }),
      "ses_1",
    )).toBe(false)

    // only a non-tool part → false
    expect(hasAnyRunningPart(
      state({ message: msgs, part: { msg_1: [textPart("p1", "msg_1", "ses_1")] } }),
      "ses_1",
    )).toBe(false)

    // no messages for the session → false
    expect(hasAnyRunningPart(state({ message: {}, part: {} }), "ses_1")).toBe(false)

    // message exists but no parts entry → false
    expect(hasAnyRunningPart(state({ message: msgs, part: {} }), "ses_1")).toBe(false)
  })

  test("finds a running part in a later message (first-hit scan across messages)", () => {
    const draft = state({
      message: { ses_1: [assistantMessage("msg_1", "ses_1"), assistantMessage("msg_2", "ses_1")] },
      part: {
        msg_1: [completedTool("p1", "msg_1", "ses_1"), textPart("p2", "msg_1", "ses_1")],
        msg_2: [runningTool("p3", "msg_2", "ses_1")],
      },
    })

    expect(hasAnyRunningPart(draft, "ses_1")).toBe(true)
  })

  test("does not report running parts that belong to a different session", () => {
    const draft = state({
      message: {
        ses_1: [assistantMessage("msg_1", "ses_1")],
        ses_2: [assistantMessage("msg_2", "ses_2")],
      },
      part: {
        msg_1: [completedTool("p1", "msg_1", "ses_1")],
        msg_2: [runningTool("p2", "msg_2", "ses_2")],
      },
    })

    expect(hasAnyRunningPart(draft, "ses_1")).toBe(false)
    expect(hasAnyRunningPart(draft, "ses_2")).toBe(true)
  })
})
