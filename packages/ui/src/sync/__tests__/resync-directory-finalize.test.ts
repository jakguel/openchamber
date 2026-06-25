import { afterAll, describe, expect, test } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"

import { INITIAL_STATE, type State } from "../types"
import type { DirectoryStore } from "../child-store"
import { resyncDirectorySessionStatuses, resyncDirectoryAfterReconnect } from "../sync-context"
import { opencodeClient } from "@/lib/opencode/client"

// ---------------------------------------------------------------------------
// WI3: resyncDirectorySessionStatuses -> { snapshot, loweredIdleSessionIds }
//
// Allowed test seam: the ONLY thing faked is the external HTTP I/O boundary
// method `opencodeClient.getSessionStatusForDirectory`, reassigned on the real
// singleton. This is NOT mock.module() and NOT a project-internal module mock —
// it overrides a single network method on the SDK-client wrapper. Everything
// else runs as real production code: the directory store, the
// applySessionStatusSnapshot reconciler, toSessionStatus, the WI1
// finalizeOrphanedRunningParts reducer helper, resyncBlockingRequestsForDirectory,
// and the real getScopedSdkClient (whose relative-URL fetch rejects fast and is
// swallowed by the reconnect loop's `.catch(() => null)` — no retry delay).
// ---------------------------------------------------------------------------

type StatusSnapshot = Record<string, { type: "idle" | "busy" | "retry"; attempt?: number; message?: string; next?: number }>

const DIRECTORY = "/repo"
const realGetSessionStatusForDirectory = opencodeClient.getSessionStatusForDirectory

// Restore the real HTTP boundary after the file completes so the override cannot
// leak into other suites sharing the process.
afterAll(() => {
  opencodeClient.getSessionStatusForDirectory = realGetSessionStatusForDirectory
})

function stubStatusFetch(snapshot: StatusSnapshot | null): void {
  opencodeClient.getSessionStatusForDirectory = async (): Promise<StatusSnapshot | null> => snapshot
}

function stubStatusFetchThrows(): void {
  opencodeClient.getSessionStatusForDirectory = async (): Promise<StatusSnapshot | null> => {
    throw new Error("session.status failed: simulated reconnect network blip")
  }
}

function createDirectoryStore(initial: Partial<State>): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    session: initial.session ?? [],
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
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

function toolState(part: Part | undefined) {
  if (!part || part.type !== "tool") throw new Error("expected a tool part")
  return part.state
}

function emptyRoutingIndex() {
  return {
    sessionDirectoryById: new Map<string, string>(),
    messageSessionById: new Map<string, string>(),
    sessionMessageIdsById: new Map<string, Set<string>>(),
  }
}

describe("resyncDirectorySessionStatuses", () => {
  // AC2: a candidate the snapshot lowers from busy -> EXPLICIT idle is surfaced.
  test("authoritative: surfaces a busy candidate the server explicitly reports idle", async () => {
    const store = createDirectoryStore({ session_status: { ses_a: { type: "busy" } } })
    stubStatusFetch({ ses_a: { type: "idle" } })

    const result = await resyncDirectorySessionStatuses(DIRECTORY, store, ["ses_a"], "authoritative")

    expect(result.loweredIdleSessionIds).toEqual(["ses_a"])
    expect(result.snapshot).toEqual({ ses_a: { type: "idle" } })
    // The snapshot is applied as a side effect: the live status is lowered.
    expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
  })

  // AC3 (null path = the real production failure mode: the client method catches
  // internally and returns null). Fetch failure preserves state, lowers nothing.
  test("authoritative: a null status fetch yields a null snapshot, no lowering, preserved state", async () => {
    const store = createDirectoryStore({ session_status: { ses_a: { type: "busy" } } })
    stubStatusFetch(null)

    const result = await resyncDirectorySessionStatuses(DIRECTORY, store, ["ses_a"], "authoritative")

    expect(result.snapshot).toBeNull()
    expect(result.loweredIdleSessionIds).toEqual([])
    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
  })

  // AC3 (throw path): a thrown fetch carries the same contract as a null result.
  test("authoritative: a thrown status fetch yields a null snapshot, no lowering, preserved state", async () => {
    const store = createDirectoryStore({ session_status: { ses_a: { type: "busy" } } })
    stubStatusFetchThrows()

    const result = await resyncDirectorySessionStatuses(DIRECTORY, store, ["ses_a"], "authoritative")

    expect(result.snapshot).toBeNull()
    expect(result.loweredIdleSessionIds).toEqual([])
    // A fetch failure is not "every session went idle": busy must survive so the
    // caller never finalizes a live tool part on a transient network blip.
    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
  })

  // AC4: a snapshot that confirms the existing busy status lowers nothing
  // (exercises the `snapshot is not idle` branch of the diff).
  test("authoritative: a snapshot confirming the existing busy status lowers nothing", async () => {
    const store = createDirectoryStore({ session_status: { ses_a: { type: "busy" } } })
    stubStatusFetch({ ses_a: { type: "busy" } })

    const result = await resyncDirectorySessionStatuses(DIRECTORY, store, ["ses_a"], "authoritative")

    expect(result.loweredIdleSessionIds).toEqual([])
    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
  })

  // AC4: an already-idle session that stays idle is not re-surfaced
  // (exercises the `previous is already idle` continue branch of the diff).
  test("authoritative: an already-idle session that stays idle is not surfaced", async () => {
    const store = createDirectoryStore({ session_status: { ses_a: { type: "idle" } } })
    stubStatusFetch({ ses_a: { type: "idle" } })

    const result = await resyncDirectorySessionStatuses(DIRECTORY, store, ["ses_a"], "authoritative")

    expect(result.loweredIdleSessionIds).toEqual([])
  })

  // Edge: a partial snapshot only surfaces EXPLICITLY-idle candidates. An absent
  // candidate is "server says nothing" — authoritative mode still lowers its
  // status, but it must NOT be a finalize candidate (else live tool calls orphan).
  test("authoritative: an absent candidate is not a finalize target even though its status is lowered", async () => {
    const store = createDirectoryStore({
      session_status: { ses_a: { type: "busy" }, ses_b: { type: "busy" } },
    })
    // ses_b is ABSENT from the snapshot — the server reported nothing about it.
    stubStatusFetch({ ses_a: { type: "idle" } })

    const result = await resyncDirectorySessionStatuses(DIRECTORY, store, ["ses_a", "ses_b"], "authoritative")

    expect(result.loweredIdleSessionIds).toEqual(["ses_a"])
    expect(result.loweredIdleSessionIds).not.toContain("ses_b")
    // Intentional divergence: authoritative still lowers ses_b's STATUS to idle...
    expect(store.getState().session_status.ses_b).toEqual({ type: "idle" })
  })

  // Monotonic mode never lowers status, so it must never surface finalize candidates.
  test("monotonic: never surfaces lowered sessions and never lowers status", async () => {
    const store = createDirectoryStore({ session_status: { ses_a: { type: "busy" } } })
    stubStatusFetch({ ses_a: { type: "idle" } })

    const result = await resyncDirectorySessionStatuses(DIRECTORY, store, ["ses_a"], "monotonic")

    expect(result.loweredIdleSessionIds).toEqual([])
    expect(result.snapshot).toEqual({ ses_a: { type: "idle" } })
    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
  })
})

describe("resyncDirectoryAfterReconnect (reconnect boundary integration)", () => {
  // AC5 end-to-end across the reconnect boundary: real store + reducer + the WI1
  // finalizeOrphanedRunningParts helper + applySessionStatusSnapshot + the real
  // getScopedSdkClient (its relative-URL fetch fails fast and is swallowed). Only
  // the status fetch is faked. A reconnect snapshot lowering a session to idle
  // must finalize that session's orphaned running tool part so the shell counter
  // stops ticking.
  test("finalizes orphaned running tool parts for sessions the snapshot lowers to idle", async () => {
    const store = createDirectoryStore({
      session_status: { ses_a: { type: "busy" } },
      message: { ses_a: [assistantMessage("msg_1", "ses_a")] },
      part: { msg_1: [runningTool("prt_1", "msg_1", "ses_a", 5_000)] },
    })
    stubStatusFetch({ ses_a: { type: "idle" } })

    await resyncDirectoryAfterReconnect(DIRECTORY, store, emptyRoutingIndex())

    // The orphaned running tool part was stamped terminal (status 'error').
    expect(toolState(store.getState().part.msg_1[0]).status).toBe("error")
    // The authoritative snapshot also lowered the session to idle.
    expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
  })

  // No-finalize on fetch failure (null snapshot): a transient network blip on
  // reconnect must not orphan a live tool part.
  test("does NOT finalize running parts when the reconnect status fetch returns null", async () => {
    const store = createDirectoryStore({
      session_status: { ses_a: { type: "busy" } },
      message: { ses_a: [assistantMessage("msg_1", "ses_a")] },
      part: { msg_1: [runningTool("prt_1", "msg_1", "ses_a", 5_000)] },
    })
    stubStatusFetch(null)

    await resyncDirectoryAfterReconnect(DIRECTORY, store, emptyRoutingIndex())

    expect(toolState(store.getState().part.msg_1[0]).status).toBe("running")
    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
  })

  // No-finalize on fetch failure (thrown): same contract as the null path.
  test("does NOT finalize running parts when the reconnect status fetch throws", async () => {
    const store = createDirectoryStore({
      session_status: { ses_a: { type: "busy" } },
      message: { ses_a: [assistantMessage("msg_1", "ses_a")] },
      part: { msg_1: [runningTool("prt_1", "msg_1", "ses_a", 5_000)] },
    })
    stubStatusFetchThrows()

    await resyncDirectoryAfterReconnect(DIRECTORY, store, emptyRoutingIndex())

    expect(toolState(store.getState().part.msg_1[0]).status).toBe("running")
    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
  })
})
