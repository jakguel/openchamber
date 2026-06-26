import { afterEach, describe, expect, test } from "bun:test"
import { create } from "zustand"

import { INITIAL_STATE } from "../types"
import { finalizeOrphanedPartsOnUpstreamDeath, handleEvent } from "../sync-context"
import { ChildStoreManager } from "../child-store"
import { createEventPipeline } from "../event-pipeline"

// ---------------------------------------------------------------------------
// WI4: finalizeOrphanedPartsOnUpstreamDeath + the handleEvent routing branch
//
// WI3's server half pushes an authoritative `openchamber:upstream-status`
// { state: "died" } frame over the message stream the INSTANT the managed
// OpenCode child is observed exited. This client half turns that signal into
// immediate finalization of every orphaned running tool part across ALL
// directory stores — collapsing the stale tool-counter freeze to <2s.
//
// The contrast with the heartbeat path (finalizeOrphanedPartsOnHeartbeatTimeout)
// is the whole point: the heartbeat path INFERS death from local silence and is
// therefore gated to a foreground/online tab; this path RECEIVES an authoritative
// server confirmation, so it is deliberately NOT gated on visibility/online — a
// hidden or offline tab whose server has confirmed death must still stop its tool
// counters. A delayed/duplicate death is dropped by a monotonic generation guard.
//
// Allowed test seam: the ONLY things faked are the BROWSER ENVIRONMENT
// (`document`/`navigator` reassigned on globalThis) and the I/O transport boundary
// (a fake `sdk.global.event` SSE stream) — the exact pattern used by
// heartbeat-disconnect-finalize.test.js. That is NOT a mock.module() and NOT a
// project-internal module mock. Everything else runs as real production code: the
// real handleEvent dispatch, the real createEventPipeline + its frame routing, the
// real ChildStoreManager registry, the zustand directory stores, and the WI1
// hasAnyRunningPart / finalizeOrphanedRunningParts reducer helpers (unchanged).
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

// The production high-water mark (lastProcessedDeathGeneration) is MODULE-SCOPED
// and shared across every test in this file. Allocating a STRICTLY-INCREASING
// generation for each finalize-expecting death keeps the suite independent of that
// shared state: a fresh generation always exceeds the module max, so it always
// passes the guard. Stale/idempotency cases derive values at or below the current
// max on purpose, to prove they are dropped.
let generationCounter = 0
const nextGeneration = () => (generationCounter += 1)

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

function runningTool(id, messageID, sessionID, start = 5_000) {
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
function busyStoreWithRunningTool(sessionID = "ses_a", messageID = "msg_1", partID = "prt_1") {
  return createDirectoryStore({
    session_status: { [sessionID]: { type: "busy" } },
    message: { [sessionID]: [assistantMessage(messageID, sessionID)] },
    part: { [messageID]: [runningTool(partID, messageID, sessionID)] },
  })
}

// Restore a finalized store back to a running/busy fixture so a SUBSEQUENT death
// would be OBSERVABLE if the generation guard wrongly let it through. (The reducer
// only finalizes `running` parts, so without this reset a second finalize would be
// an indistinguishable no-op and could not prove the guard.)
function restoreRunning(store, sessionID = "ses_a", messageID = "msg_1", partID = "prt_1") {
  store.setState({
    session_status: { [sessionID]: { type: "busy" } },
    part: { [messageID]: [runningTool(partID, messageID, sessionID)] },
  })
}

// The exact WI3 wire frame the server pushes (and its inner event payload).
function deathPayload(generation, state = "died") {
  return {
    type: "openchamber:upstream-status",
    properties: { state, cause: "upstream_exited", generation, timestamp: 1_700_000_000_000 },
  }
}

function deathFrame(generation, state = "died") {
  return { type: "event", payload: deathPayload(generation, state), directory: "global" }
}

// Minimal EventRoutingIndex shape (handleEvent's death branch returns before it is
// consulted; this just satisfies the parameter for the real dispatch entrypoint).
function emptyRoutingIndex() {
  return {
    sessionDirectoryById: new Map(),
    messageSessionById: new Map(),
    sessionMessageIdsById: new Map(),
  }
}

// ---------------------------------------------------------------------------
// Production routing: a pushed death event flows through the REAL handleEvent
// dispatch and finalizes EVERY child store that holds a running tool part.
// ---------------------------------------------------------------------------
describe("handleEvent — pushed upstream-death finalize (no gate, all stores)", () => {
  // AC1: the death event routes through handleEvent to finalize ALL directory
  // stores holding a running tool part — parts -> error, session_status -> idle.
  // Reverting the handleEvent branch leaves both stores running and fails this.
  test("routes a pushed death event to finalize across all child stores", () => {
    const storeA = busyStoreWithRunningTool("ses_a", "msg_a", "prt_a")
    const storeB = busyStoreWithRunningTool("ses_b", "msg_b", "prt_b")
    const childStores = new ChildStoreManager()
    childStores.children.set("/dir-a", storeA)
    childStores.children.set("/dir-b", storeB)

    handleEvent("global", deathPayload(nextGeneration()), childStores, emptyRoutingIndex())

    expect(toolState(storeA.getState().part.msg_a[0]).status).toBe("error")
    expect(storeA.getState().session_status.ses_a).toEqual({ type: "idle" })
    expect(toolState(storeB.getState().part.msg_b[0]).status).toBe("error")
    expect(storeB.getState().session_status.ses_b).toEqual({ type: "idle" })
  })

  // AC3 (no gate): a non-death openchamber:upstream-status (state !== "died") that
  // reaches handleEvent must NOT finalize — the live tool stays running, busy.
  test("a non-death upstream-status routed through handleEvent does nothing", () => {
    const store = busyStoreWithRunningTool()
    const childStores = new ChildStoreManager()
    childStores.children.set("/dir-a", store)

    handleEvent("global", deathPayload(nextGeneration(), "alive"), childStores, emptyRoutingIndex())

    expect(toolState(store.getState().part.msg_1[0]).status).toBe("running")
    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
  })
})

// ---------------------------------------------------------------------------
// Handler semantics: no visibility/online gate, generation idempotency + stale
// drop, and non-death no-op. Direct calls to the REAL handler over REAL stores +
// the REAL finalizeOrphanedRunningParts reducer helper (no mocks).
// ---------------------------------------------------------------------------
describe("finalizeOrphanedPartsOnUpstreamDeath — no gate + generation guard", () => {
  // AC3: authoritative signal — finalizes EVEN on a hidden, offline tab (the exact
  // environment where the heartbeat path is gated OFF). If a visible/online gate
  // were copied onto this path, this test fails.
  test("finalizes even when hidden + offline (no visible/online gate)", () => {
    setEnvironment("hidden", false)
    const store = busyStoreWithRunningTool()

    finalizeOrphanedPartsOnUpstreamDeath(deathPayload(nextGeneration()), [store])

    expect(toolState(store.getState().part.msg_1[0]).status).toBe("error")
    expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
  })

  // AC4 (idempotency): the SAME generation seen twice finalizes ONCE. After the
  // first death the store is restored to running; the second (same-generation)
  // death must be dropped, leaving the restored part running and the session busy.
  test("a second death with the SAME generation does not finalize again", () => {
    const store = busyStoreWithRunningTool()
    const generation = nextGeneration()

    finalizeOrphanedPartsOnUpstreamDeath(deathPayload(generation), [store])
    expect(toolState(store.getState().part.msg_1[0]).status).toBe("error")

    restoreRunning(store)
    finalizeOrphanedPartsOnUpstreamDeath(deathPayload(generation), [store])

    // Guard dropped the duplicate: the restored running part is untouched.
    expect(toolState(store.getState().part.msg_1[0]).status).toBe("running")
    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
  })

  // AC4 (stale drop): a delayed/duplicate death for an already-superseded
  // generation (strictly lower than the high-water mark) is ignored.
  test("a death with a stale (lower) generation is ignored", () => {
    const store = busyStoreWithRunningTool()
    const current = nextGeneration()

    finalizeOrphanedPartsOnUpstreamDeath(deathPayload(current), [store])
    expect(toolState(store.getState().part.msg_1[0]).status).toBe("error")

    restoreRunning(store)
    finalizeOrphanedPartsOnUpstreamDeath(deathPayload(current - 1), [store])

    expect(toolState(store.getState().part.msg_1[0]).status).toBe("running")
    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
  })

  // AC3 negative: a non-death upstream-status (state !== "died") does nothing and
  // does NOT consume the generation, so a later real death still finalizes.
  test("a non-death upstream-status (state != 'died') does nothing", () => {
    const store = busyStoreWithRunningTool()

    finalizeOrphanedPartsOnUpstreamDeath(deathPayload(nextGeneration(), "alive"), [store])

    expect(toolState(store.getState().part.msg_1[0]).status).toBe("running")
    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
  })
})

// ---------------------------------------------------------------------------
// AC integration: drive the EXACT WI3 wire frame through the REAL event pipeline
// so the real frame routing (resolveEventPayload unwrap + normalizeEventType +
// coalesce/flush) delivers the unwrapped death payload to onEvent, which finalizes
// the real store. Only the SSE transport + browser-env globals are faked.
// ---------------------------------------------------------------------------
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

function setPipelineEnvironment(visibilityState, onLine) {
  globalThis.document = createEventTarget({ visibilityState })
  globalThis.window = createEventTarget({
    location: { href: "http://127.0.0.1:3000/", origin: "http://127.0.0.1:3000" },
  })
  globalThis.navigator = { onLine }
}

// Fake SSE transport (the I/O boundary): connects, yields the provided frames,
// then stays open until the attempt's signal aborts — mirroring a real fetch
// stream that ends on abort.
function emittingSseSdk(frames) {
  return {
    global: {
      event: async ({ signal }) => ({
        stream: (async function* () {
          for (const frame of frames) {
            if (signal?.aborted) return
            yield frame
          }
          await new Promise((resolve) => {
            if (signal?.aborted) {
              resolve()
              return
            }
            signal?.addEventListener("abort", () => resolve(), { once: true })
          })
        })(),
      }),
    },
  }
}

describe("pushed death frame through the real event pipeline", () => {
  // The pipeline parses the exact WI3 wire frame, unwraps the inner death payload
  // via the real resolveEventPayload, preserves its type through normalizeEventType,
  // and delivers it to onEvent on the "global" directory — where the handler
  // finalizes the orphaned running part. Proves the inbound routing end-to-end.
  test("delivers the unwrapped death payload to onEvent and finalizes the store", async () => {
    setPipelineEnvironment("visible", true)
    const store = busyStoreWithRunningTool()
    const generation = nextGeneration()
    let delivered = null

    await new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk: emittingSseSdk([deathFrame(generation)]),
        transport: "sse",
        heartbeatTimeoutMs: 10_000,
        reconnectDelayMs: 10_000,
        onEvent: (directory, payload) => {
          if (payload.type !== "openchamber:upstream-status") return
          delivered = { directory, payload }
          finalizeOrphanedPartsOnUpstreamDeath(payload, [store])
          cleanup()
          resolve()
        },
      })
    })

    // The REAL pipeline unwrapped the frame and delivered the death payload intact.
    expect(delivered?.directory).toBe("global")
    expect(delivered?.payload?.type).toBe("openchamber:upstream-status")
    expect(delivered?.payload?.properties?.state).toBe("died")
    // Finalize stamped the orphaned running part terminal + lowered to idle.
    expect(toolState(store.getState().part.msg_1[0]).status).toBe("error")
    expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
  })
})
