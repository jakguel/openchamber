import { describe, expect, test, beforeEach, mock } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"

// ---------------------------------------------------------------------------
// WI3: resyncDirectorySessionStatuses → { snapshot, loweredIdleSessionIds }
//
// The ONLY mocked seam is the OpenCode SDK client wrapper — the network I/O
// boundary (`@/lib/opencode/client`). Everything else runs real production
// code: the directory store, applySessionStatusSnapshot, toSessionStatus, the
// finalizeOrphanedRunningParts reducer helper, and resyncBlockingRequests.
// No internal project module is mocked.
// ---------------------------------------------------------------------------

type StatusValue = { type: "idle" | "busy" | "retry"; attempt?: number; message?: string; next?: number }

const DIRECTORY = "/repo"

// Mutable I/O-boundary controls. Declared before mock.module so the factory
// closes over the live bindings and each test can drive the network responses.
let nextStatusSnapshot: Record<string, StatusValue> | null = null
let statusFetchShouldThrow = false
let scopedSessionGet: () => Promise<unknown> = async () => {
  throw new Error("stub: session.get not configured")
}
let scopedSessionMessages: () => Promise<unknown> = async () => {
  throw new Error("stub: session.messages not configured")
}

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getDirectory: () => DIRECTORY,
    setDirectory: () => undefined,
    getSessionStatusForDirectory: async () => {
      if (statusFetchShouldThrow) throw new Error("network request failed: simulated reconnect blip")
      return nextStatusSnapshot
    },
    getScopedSdkClient: () => ({
      session: {
        get: () => scopedSessionGet(),
        messages: () => scopedSessionMessages(),
      },
    }),
    listPendingQuestions: async () => [],
    listPendingPermissions: async () => [],
  },
}))

import { INITIAL_STATE, type State } from "../types"
import type { DirectoryStore } from "../child-store"
import { resyncDirectorySessionStatuses, resyncDirectoryAfterReconnect } from "../sync-context"

function createDirectoryStore(initial: Partial<State>): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    session: initial.session ?? [],
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

function session(id: string): State["session"][number] {
  return { id, title: id, time: { created: 1, updated: 1 }, version: "1" } as State["session"][number]
}

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

// Narrowing accessor: returns the tool state so assertions can discriminate on
// `status` without casts.
function toolState(part: Part | undefined) {
  if (!part || part.type !== "tool") throw new Error("expected a tool part")
  return part.state
}

beforeEach(() => {
  nextStatusSnapshot = null
  statusFetchShouldThrow = false
  scopedSessionGet = async () => {
    throw new Error("stub: session.get not configured")
  }
  scopedSessionMessages = async () => {
    throw new Error("stub: session.messages not configured")
  }
})

describe("resyncDirectorySessionStatuses", () => {
  // AC2: a candidate the snapshot lowers from busy → idle is surfaced.
  test("authoritative: a busy candidate the server reports idle is surfaced in loweredIdleSessionIds", async () => {
    const store = createDirectoryStore({ session_status: { ses_a: { type: "busy" } } })
    nextStatusSnapshot = { ses_a: { type: "idle" } }

    const result = await resyncDirectorySessionStatuses(DIRECTORY, store, ["ses_a"], "authoritative")

    expect(result.loweredIdleSessionIds).toEqual(["ses_a"])
    expect(result.snapshot).toEqual({ ses_a: { type: "idle" } })
    // The snapshot was applied to the store as a side effect.
    expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
  })

  // AC3 (null path): a null fetch is a fetch failure — preserve state, finalize nothing.
  test("a null status fetch (failure) yields a null snapshot and no lowered sessions", async () => {
    const store = createDirectoryStore({ session_status: { ses_a: { type: "busy" } } })
    nextStatusSnapshot = null

    const result = await resyncDirectorySessionStatuses(DIRECTORY, store, ["ses_a"], "authoritative")

    expect(result.snapshot).toBeNull()
    expect(result.loweredIdleSessionIds).toEqual([])
    // Fetch failure must NOT lower existing state (no applySessionStatusSnapshot).
    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
  })

  // AC3 (throw path): a thrown fetch is also a fetch failure — same contract as null.
  test("a thrown status fetch (failure) yields a null snapshot and no lowered sessions", async () => {
    const store = createDirectoryStore({ session_status: { ses_a: { type: "busy" } } })
    statusFetchShouldThrow = true

    const result = await resyncDirectorySessionStatuses(DIRECTORY, store, ["ses_a"], "authoritative")

    expect(result.snapshot).toBeNull()
    expect(result.loweredIdleSessionIds).toEqual([])
    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
  })

  // AC4: a snapshot that merely confirms the existing busy status lowers nothing.
  test("a snapshot that confirms the existing busy status lowers nothing", async () => {
    const store = createDirectoryStore({ session_status: { ses_a: { type: "busy" } } })
    nextStatusSnapshot = { ses_a: { type: "busy" } }

    const result = await resyncDirectorySessionStatuses(DIRECTORY, store, ["ses_a"], "authoritative")

    expect(result.loweredIdleSessionIds).toEqual([])
    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
  })

  // Edge: a partial snapshot only finalizes EXPLICITLY-idle sessions. An absent
  // candidate is "server says nothing" and must NOT be lowered for finalize, even
  // though authoritative mode lowers its status (AGENTS.md fetch-failure-vs-empty).
  test("a partial snapshot only surfaces explicitly-idle sessions, not absent ones", async () => {
    const store = createDirectoryStore({
      session_status: { ses_a: { type: "busy" }, ses_b: { type: "busy" } },
    })
    // ses_b is ABSENT from the snapshot — the server said nothing about it.
    nextStatusSnapshot = { ses_a: { type: "idle" } }

    const result = await resyncDirectorySessionStatuses(DIRECTORY, store, ["ses_a", "ses_b"], "authoritative")

    expect(result.loweredIdleSessionIds).toEqual(["ses_a"])
    // Divergence is intentional: authoritative mode still lowers ses_b's STATUS...
    expect(store.getState().session_status.ses_b).toEqual({ type: "idle" })
    // ...but ses_b is NOT a finalize candidate (absent ≠ explicit idle).
    expect(result.loweredIdleSessionIds).not.toContain("ses_b")
  })

  // Monotonic mode never lowers status, so it must never surface finalize candidates,
  // even when the snapshot reports a busy session as idle.
  test("monotonic mode never surfaces lowered sessions even when the snapshot reports idle", async () => {
    const store = createDirectoryStore({ session_status: { ses_a: { type: "busy" } } })
    nextStatusSnapshot = { ses_a: { type: "idle" } }

    const result = await resyncDirectorySessionStatuses(DIRECTORY, store, ["ses_a"], "monotonic")

    expect(result.loweredIdleSessionIds).toEqual([])
    // Monotonic preserves the live busy status.
    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
  })
})

describe("resyncDirectoryAfterReconnect", () => {
  // AC5: end-to-end — a reconnect snapshot lowering a session to idle finalizes
  // that session's orphaned running tool part so the shell counter stops ticking.
  test("finalizes orphaned running parts for sessions the snapshot lowered to idle", async () => {
    const store = createDirectoryStore({
      session: [session("ses_a")],
      session_status: { ses_a: { type: "busy" } },
      message: { ses_a: [assistantMessage("msg_1", "ses_a")] },
      part: { msg_1: [runningTool("prt_1", "msg_1", "ses_a", 5_000)] },
    })
    nextStatusSnapshot = { ses_a: { type: "idle" } }
    // The per-session resync SDK calls reject with a non-transient error (no retry
    // delay); the loop short-circuits, leaving the finalized part intact.
    scopedSessionGet = async () => {
      throw new Error("stub: session.get unavailable")
    }
    scopedSessionMessages = async () => {
      throw new Error("stub: session.messages unavailable")
    }

    const routingIndex = {
      sessionDirectoryById: new Map<string, string>(),
      messageSessionById: new Map<string, string>(),
      sessionMessageIdsById: new Map<string, Set<string>>(),
    }

    await resyncDirectoryAfterReconnect(DIRECTORY, store, routingIndex)

    // The orphaned running tool part was stamped terminal (status 'error').
    expect(toolState(store.getState().part.msg_1[0]).status).toBe("error")
    // The authoritative snapshot also lowered the session to idle.
    expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
  })

  // A reconnect whose status fetch fails (null snapshot) must NOT finalize: a
  // transient network blip cannot orphan live tool parts.
  test("does not finalize running parts when the reconnect status fetch fails", async () => {
    const store = createDirectoryStore({
      session: [session("ses_a")],
      session_status: { ses_a: { type: "busy" } },
      message: { ses_a: [assistantMessage("msg_1", "ses_a")] },
      part: { msg_1: [runningTool("prt_1", "msg_1", "ses_a", 5_000)] },
    })
    nextStatusSnapshot = null
    scopedSessionGet = async () => {
      throw new Error("stub: session.get unavailable")
    }
    scopedSessionMessages = async () => {
      throw new Error("stub: session.messages unavailable")
    }

    const routingIndex = {
      sessionDirectoryById: new Map<string, string>(),
      messageSessionById: new Map<string, string>(),
      sessionMessageIdsById: new Map<string, Set<string>>(),
    }

    await resyncDirectoryAfterReconnect(DIRECTORY, store, routingIndex)

    // Fetch failure preserves the running part AND the busy status.
    expect(toolState(store.getState().part.msg_1[0]).status).toBe("running")
    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
  })
})
