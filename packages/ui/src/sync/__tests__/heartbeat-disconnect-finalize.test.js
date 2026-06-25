import { afterEach, describe, expect, test } from "bun:test"
import { create } from "zustand"

import { INITIAL_STATE } from "../types"
import { finalizeOrphanedPartsOnHeartbeatTimeout } from "../sync-context"
import { createEventPipeline } from "../event-pipeline"

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
// Allowed test seam: the ONLY things faked are the BROWSER ENVIRONMENT
// (`document`/`window`/`navigator` reassigned on globalThis) and the I/O
// transport boundary (a fake `sdk.global.event` SSE stream) — the exact pattern
// used by event-pipeline-online.test.js. That is NOT a mock.module() and NOT a
// project-internal module mock. Everything else runs as real production code: the
// real createEventPipeline + its heartbeat timer, the zustand directory store, the
// WI1 hasAnyRunningPart / finalizeOrphanedRunningParts reducer helpers, and the
// real gate + finalize.
//
// Two layers of coverage:
//   1. Fast direct-call unit tests for each gate branch (hidden / offline /
//      non-heartbeat / pre-scan).
//   2. Real-pipeline integration tests proving a genuine heartbeat timeout
//      produces a `*_heartbeat_timeout` reason that reaches onDisconnect and
//      finalizes the store — and that a real non-heartbeat reason does not.
// ---------------------------------------------------------------------------

const savedDocument = globalThis.document
const savedWindow = globalThis.window
const savedNavigator = globalThis.navigator

// Restore the real environment globals after every test so a stub cannot leak
// into other suites sharing the process.
afterEach(() => {
  globalThis.document = savedDocument
  globalThis.window = savedWindow
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

// Multi-listener event-target stub (matches event-pipeline-online.test.js). The
// real pipeline registers visibilitychange/pageshow/online/offline/system-resume
// listeners on window+document at construction, so both must support add/remove.
function createEventTarget(extras = {}) {
  const listeners = new Map()
  return {
    ...extras,
    addEventListener(event, handler) {
      const list = listeners.get(event)
      if (list) list.add(handler)
      else listeners.set(event, new Set([handler]))
    },
    removeEventListener(event, handler) {
      listeners.get(event)?.delete(handler)
    },
    dispatch(event) {
      const list = listeners.get(event)
      if (!list) return
      for (const handler of Array.from(list)) handler()
    },
  }
}

// Browser-env stub for the REAL-pipeline tests: document/window must be event
// targets (the pipeline wires listeners on them); navigator carries onLine for the
// finalize gate. The fast direct-call tests above use plain `setEnvironment`
// because they never construct a pipeline.
function setPipelineEnvironment(visibilityState, onLine) {
  globalThis.document = createEventTarget({ visibilityState })
  globalThis.window = createEventTarget({
    location: { href: "http://127.0.0.1:3000/", origin: "http://127.0.0.1:3000" },
  })
  globalThis.navigator = { onLine }
}

// Fake SSE transport (the I/O boundary): connects successfully, emits NO events,
// and ends its stream when the attempt's signal aborts — mirroring a real fetch
// stream that terminates on signal.abort(). With no events arriving, the
// pipeline's real heartbeat timer is what eventually fires.
function silentSseSdk() {
  return {
    global: {
      event: async ({ signal }) => ({
        stream: (async function* () {
          if (signal?.aborted) return
          await new Promise((resolve) => {
            signal?.addEventListener("abort", () => resolve(), { once: true })
          })
        })(),
      }),
    },
  }
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

// ---------------------------------------------------------------------------
// AC8 integration: drive the REAL event pipeline so a genuine heartbeat timeout
// produces a `*_heartbeat_timeout` reason that reaches onDisconnect (the actual
// production wiring), which then finalizes the real store. Only the transport +
// browser-env globals are faked; createEventPipeline, its heartbeat timer, the
// store, the reducer helpers, and the gate are all real.
// ---------------------------------------------------------------------------
describe("heartbeat-timeout finalize through the real event pipeline", () => {
  // POSITIVE: a silent SSE stream lets the pipeline's real heartbeat timer fire,
  // which sets attemptAbortReason = `sse_heartbeat_timeout` and aborts; the loop
  // calls onDisconnect with that reason → finalize stamps the orphaned part error
  // and lowers the session to idle. This proves the full chain end-to-end, not a
  // hand-passed reason string.
  test("a real heartbeat timeout drives onDisconnect and finalizes the store", async () => {
    setPipelineEnvironment("visible", true)
    const store = busyStoreWithRunningTool()
    let capturedReason = null

    await new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk: silentSseSdk(),
        transport: "sse",
        heartbeatTimeoutMs: 10,
        reconnectDelayMs: 10_000,
        onEvent: () => {},
        onDisconnect: (reason) => {
          capturedReason = reason
          finalizeOrphanedPartsOnHeartbeatTimeout(reason, [store])
          cleanup()
          resolve()
        },
      })
    })

    // The reason was produced by the REAL heartbeat timer, not the test.
    expect(capturedReason).toBe("sse_heartbeat_timeout")
    expect(/_heartbeat_timeout$/.test(capturedReason)).toBe(true)
    // Full wiring proven: heartbeat timer → reason → onDisconnect → finalize.
    expect(toolState(store.getState().part.msg_1[0]).status).toBe("error")
    expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
  })

  // NEGATIVE (reason propagation): a manual reconnect drives a real, non-heartbeat
  // disconnect reason (`sse_manual`) through the same pipeline to onDisconnect. The
  // gate must short-circuit on the real reason string — the orphaned part stays
  // running and the session stays busy. heartbeatTimeoutMs is large so the only
  // disconnect is the manual one.
  test("a real non-heartbeat reason reaches onDisconnect but does NOT finalize", async () => {
    setPipelineEnvironment("visible", true)
    const store = busyStoreWithRunningTool()
    let capturedReason = null

    await new Promise((resolve) => {
      let triggered = false
      const pipeline = createEventPipeline({
        sdk: silentSseSdk(),
        transport: "sse",
        heartbeatTimeoutMs: 10_000,
        reconnectDelayMs: 10_000,
        onEvent: () => {},
        onReconnect: () => {
          // The attempt is now live; force a manual (non-heartbeat) abort through
          // the real pipeline, which yields reason `sse_manual`.
          if (triggered) return
          triggered = true
          pipeline.reconnect("manual")
        },
        onDisconnect: (reason) => {
          capturedReason = reason
          finalizeOrphanedPartsOnHeartbeatTimeout(reason, [store])
          pipeline.cleanup()
          resolve()
        },
      })
    })

    // A real pipeline reason that is NOT a heartbeat timeout.
    expect(capturedReason).toBe("sse_manual")
    expect(/_heartbeat_timeout$/.test(capturedReason)).toBe(false)
    // The gate short-circuited: the orphaned part is left running, session busy.
    expect(toolState(store.getState().part.msg_1[0]).status).toBe("running")
    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
  })

  // NEGATIVE (system resume — Story AC8): the OS-suspend-resume hazard. When the
  // laptop wakes from sleep, the pipeline's real `openchamber:system-resume` listener
  // (event-pipeline.ts) aborts the stalled attempt with reason `${transport}_system_resume`
  // and reconnects — the heartbeat that froze during sleep never produces a
  // `*_heartbeat_timeout`. This negative drives that exact path through the REAL pipeline:
  // a genuine `sse_system_resume` disconnect reaches onDisconnect on a fully visible +
  // online tab (so the visibility/online gate would PASS) and the ONLY thing stopping a
  // finalize is the reason-gate. If that gate were broadened to fire on any disconnect, a
  // machine waking from sleep would wrongly stamp its still-live tools `error`. The tool
  // must stay running and the session must stay busy across the resume.
  test("a real system-resume reconnect reaches onDisconnect but does NOT finalize (visible + online)", async () => {
    setPipelineEnvironment("visible", true)
    const store = busyStoreWithRunningTool()
    let capturedReason = null

    await new Promise((resolve) => {
      let triggered = false
      const pipeline = createEventPipeline({
        sdk: silentSseSdk(),
        transport: "sse",
        // Large heartbeat window so the heartbeat timer never fires — the only
        // disconnect is the OS resume we dispatch below.
        heartbeatTimeoutMs: 10_000,
        reconnectDelayMs: 10_000,
        onEvent: () => {},
        onReconnect: () => {
          // The attempt is live; simulate the OS waking from suspend by firing the
          // real `openchamber:system-resume` window event the pipeline listens for.
          if (triggered) return
          triggered = true
          globalThis.window.dispatch("openchamber:system-resume")
        },
        onDisconnect: (reason) => {
          capturedReason = reason
          finalizeOrphanedPartsOnHeartbeatTimeout(reason, [store])
          pipeline.cleanup()
          resolve()
        },
      })
    })

    // A real pipeline reason produced by the system-resume handler — NOT a heartbeat death.
    expect(capturedReason).toBe("sse_system_resume")
    expect(/_heartbeat_timeout$/.test(capturedReason)).toBe(false)
    // The reason-gate short-circuited despite visible+online: a waking machine keeps its
    // live tool running and the session busy — no spurious finalize.
    expect(toolState(store.getState().part.msg_1[0]).status).toBe("running")
    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
  })
})
