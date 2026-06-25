import { afterEach, describe, expect, test } from "bun:test"
import { create } from "zustand"

import { INITIAL_STATE } from "../types"
import { finalizeOrphanedPartsOnHeartbeatTimeout } from "../sync-context"

// ---------------------------------------------------------------------------
// WI4: finalizeOrphanedPartsOnHeartbeatTimeout(reason, stores)
//
// The heartbeat-death catch-all. When the OpenCode upstream dies and the SSE/WS
// heartbeat times out, no session.idle/error event ever arrives, so the reducer
// (WI2) and reconnect-resync (WI3) finalize paths never fire. This handler stamps
// the orphaned running tool parts terminal — but ONLY on a foreground, online tab,
// because a hidden/offline tab's heartbeat death is the expected idle path (the
// server may still be alive) and finalizing then would wrongly error live tools.
//
// Allowed test seam: the ONLY thing faked is the BROWSER ENVIRONMENT — the
// `document.visibilityState` and `navigator.onLine` globals are reassigned on
// globalThis (the same pattern as event-pipeline-online.test.js). That is NOT a
// mock.module() and NOT a project-internal module mock. Everything else runs as
// real production code: the zustand directory store, the WI1 hasAnyRunningPart /
// finalizeOrphanedRunningParts reducer helpers, and the real gate + finalize.
// ---------------------------------------------------------------------------

const savedDocument = globalThis.document
const savedNavigator = globalThis.navigator

// Restore the real environment globals after every test so a stub cannot leak
// into other suites sharing the process.
afterEach(() => {
  globalThis.document = savedDocument
  globalThis.navigator = savedNavigator
})

function setEnvironment(visibilityState, onLine) {
  globalThis.document = { visibilityState }
  globalThis.navigator = { onLine }
}

function createDirectoryStore(initial) {
  return create()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    session: initial.session ?? [],
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

function assistantMessage(id, sessionID) {
  return { id, sessionID, role: "assistant", time: { created: 1 } }
}

function runningTool(id, messageID, sessionID, start = 1_000) {
  return {
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: `call_${id}`,
    tool: "bash",
    state: { status: "running", input: { command: "sleep 999" }, time: { start } },
  }
}

function toolState(part) {
  if (!part || part.type !== "tool") throw new Error("expected a tool part")
  return part.state
}

// A directory store with one busy session whose assistant message holds a single
// still-running tool part — the orphaned-on-upstream-death fixture.
function busyStoreWithRunningTool() {
  return createDirectoryStore({
    session_status: { ses_a: { type: "busy" } },
    message: { ses_a: [assistantMessage("msg_1", "ses_a")] },
    part: { msg_1: [runningTool("prt_1", "msg_1", "ses_a", 5_000)] },
  })
}

describe("finalizeOrphanedPartsOnHeartbeatTimeout — gate + finalize", () => {
  // POSITIVE (AC4): all gates pass — a foreground, online tab on a heartbeat-timeout
  // reason finalizes the orphaned running tool part AND lowers the session to idle.
  test("visible + online heartbeat timeout finalizes orphaned parts and lowers status to idle", () => {
    setEnvironment("visible", true)
    const store = busyStoreWithRunningTool()

    finalizeOrphanedPartsOnHeartbeatTimeout("ws_heartbeat_timeout", [store])

    // Orphaned running tool part stamped terminal (the WI1 helper's ToolStateError).
    expect(toolState(store.getState().part.msg_1[0]).status).toBe("error")
    // Session status lowered to idle directly (NOT via session.error semantics).
    expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
  })

  // NEGATIVE 1 (AC2): a hidden tab's heartbeat death is the expected idle path — the
  // server may still be alive, so nothing is finalized and nothing is lowered.
  test("hidden tab does NOT finalize even on a heartbeat-timeout reason", () => {
    setEnvironment("hidden", true)
    const store = busyStoreWithRunningTool()

    finalizeOrphanedPartsOnHeartbeatTimeout("ws_heartbeat_timeout", [store])

    expect(toolState(store.getState().part.msg_1[0]).status).toBe("running")
    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
  })

  // NEGATIVE 2 (AC3): an offline tab's heartbeat death is the expected idle path (the
  // network is down) — nothing is finalized even though the tab is visible.
  test("offline tab does NOT finalize even when visible on a heartbeat-timeout reason", () => {
    setEnvironment("visible", false)
    const store = busyStoreWithRunningTool()

    finalizeOrphanedPartsOnHeartbeatTimeout("ws_heartbeat_timeout", [store])

    expect(toolState(store.getState().part.msg_1[0]).status).toBe("running")
    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
  })

  // NEGATIVE 3 (AC1): a non-heartbeat disconnect reason (here a real `ws_manual`
  // reconnect reason that also reaches onDisconnect) never finalizes — only a
  // `*_heartbeat_timeout` suffix is the upstream-death signal.
  test("non-heartbeat reason does NOT finalize even when visible + online", () => {
    setEnvironment("visible", true)
    const store = busyStoreWithRunningTool()

    finalizeOrphanedPartsOnHeartbeatTimeout("ws_manual", [store])

    expect(toolState(store.getState().part.msg_1[0]).status).toBe("running")
    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
  })

  // AC5 pre-scan: a non-idle session with NO running parts is left untouched — the
  // pre-scan skips it, so its status is NOT spuriously lowered to idle.
  test("pre-scan leaves a non-idle session with no running parts untouched", () => {
    setEnvironment("visible", true)
    const store = createDirectoryStore({ session_status: { ses_a: { type: "busy" } } })

    finalizeOrphanedPartsOnHeartbeatTimeout("ws_heartbeat_timeout", [store])

    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
  })
})
