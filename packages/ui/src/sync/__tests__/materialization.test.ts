import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { getSessionMaterializationStatus, materializeSessionSnapshots } from "../materialization"

function message(id: string, sessionID = "ses_1"): Message {
  return { id, sessionID, role: "assistant", time: { created: 1 } } as Message
}

function userMessage(id: string, sessionID = "ses_1"): Message {
  return { id, sessionID, role: "user", time: { created: 1 } } as Message
}

function part(id: string, messageID: string, type = "text", text = id): Part {
  return { id, messageID, sessionID: "ses_1", type, text } as Part
}

describe("materializeSessionSnapshots", () => {
  test("marks an empty successful page as materialized", () => {
    const result = materializeSessionSnapshots(
      { message: {}, part: {} },
      "ses_1",
      [],
    )

    expect(result.message.ses_1).toEqual([])
    expect(result.messagesChanged).toBe(true)
    expect(getSessionMaterializationStatus(result, "ses_1")).toEqual({
      hasMessages: true,
      renderable: true,
      missingPartMessageIDs: [],
    })
  })

  test("materializes messages and parts together", () => {
    const result = materializeSessionSnapshots(
      { message: {}, part: {} },
      "ses_1",
      [{ info: message("msg_1"), parts: [part("prt_1", "msg_1")] }],
    )

    expect(result.message.ses_1.map((item) => item.id)).toEqual(["msg_1"])
    expect(result.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result.messagesChanged).toBe(true)
    expect(result.partsChanged).toBe(true)
  })

  test("preserves unchanged references", () => {
    const existingMessage = message("msg_1")
    const existingPart = part("prt_1", "msg_1")
    const state = { message: { ses_1: [existingMessage] }, part: { msg_1: [existingPart] } }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: existingMessage, parts: [existingPart] }],
    )

    expect(result.message).toBe(state.message)
    expect(result.part).toBe(state.part)
    expect(result.messagesChanged).toBe(false)
    expect(result.partsChanged).toBe(false)
  })

  test("skips non-rendered part types", () => {
    const result = materializeSessionSnapshots(
      { message: {}, part: {} },
      "ses_1",
      [{ info: message("msg_1"), parts: [part("prt_patch", "msg_1", "patch"), part("prt_text", "msg_1")] }],
      { skipPartTypes: new Set(["patch"]) },
    )

    expect(result.part.msg_1.map((item) => item.id)).toEqual(["prt_text"])
  })

  test("preserves newer live streaming text when a stale snapshot materializes", () => {
    const livePart = part("prt_1", "msg_1", "text", "First chunk ")
    const stalePart = part("prt_1", "msg_1", "text", "")
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [livePart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [stalePart] }],
    )

    expect(result.part.msg_1[0]).toBe(livePart)
    expect((result.part.msg_1[0] as { text?: string })?.text).toBe("First chunk ")
  })

  test("preserves live streaming parts omitted by a stale snapshot", () => {
    const livePart = part("prt_1", "msg_1", "text", "First chunk ")
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [livePart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [] }],
    )

    expect(result.part.msg_1[0]).toBe(livePart)
  })

  test("does not preserve omitted optimistic user text parts beside server snapshot parts", () => {
    const optimisticPart = { id: "prt_optimistic", messageID: "msg_1", type: "text", text: "Hello" } as Part
    const serverPart = part("prt_server", "msg_1", "text", "Hello")
    const state = {
      message: { ses_1: [userMessage("msg_1")] },
      part: { msg_1: [optimisticPart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: userMessage("msg_1"), parts: [serverPart] }],
    )

    expect(result.part.msg_1).toEqual([serverPart])
  })
})

// WI5: a reconnect-resync snapshot must not resurrect a locally-finalized terminal
// tool part back to "running" (irreversible-finalize invariant). Drives the REAL
// merge (materializeSessionSnapshots); only the snapshot records are faked (the
// post-fetch I/O boundary) — no internal module is mocked.
function toolPart(id: string, messageID: string, status: string, opts: { end?: number } = {}): Part {
  const time = opts.end !== undefined ? { start: 1, end: opts.end } : { start: 1 }
  return {
    id,
    messageID,
    sessionID: "ses_1",
    type: "tool",
    callID: `call_${id}`,
    tool: "bash",
    state: { status, input: { command: "sleep 999" }, time },
  } as Part
}

function partStatus(value: Part | undefined): string | undefined {
  return (value as { state?: { status?: string } } | undefined)?.state?.status
}

describe("materializeSessionSnapshots — terminal tool-part preservation (reconnect-resync)", () => {
  // AC1: a locally-finalized terminal "error" part must survive a resync snapshot
  // that re-delivers it as "running". Without the merge guard, mergeMaterializedPart
  // returns the snapshot's running part and resurrects the finalized counter.
  test("a running resync snapshot does NOT overwrite a locally-finalized error part", () => {
    const localError = toolPart("prt_1", "msg_1", "error", { end: 9_000 })
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [localError] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [toolPart("prt_1", "msg_1", "running")] }],
    )

    expect(partStatus(result.part.msg_1[0])).toBe("error")
  })

  // AC3: legitimate forward progress is preserved — a "completed" snapshot still
  // advances a locally-"running" part. The guard must not over-preserve.
  test("a completed resync snapshot still advances a locally-running part", () => {
    const localRunning = toolPart("prt_1", "msg_1", "running")
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [localRunning] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [toolPart("prt_1", "msg_1", "completed", { end: 9_000 })] }],
    )

    expect(partStatus(result.part.msg_1[0])).toBe("completed")
  })

  // Negative (no over-preservation): preserving one finalized part must NOT block a
  // brand-new running part the snapshot introduces. The terminal part stays "error"
  // AND the new running part is added.
  test("preserves a terminal part while still adding a brand-new running snapshot part", () => {
    const localError = toolPart("prt_1", "msg_1", "error", { end: 9_000 })
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [localError] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [
        {
          info: message("msg_1"),
          parts: [toolPart("prt_1", "msg_1", "running"), toolPart("prt_2", "msg_1", "running")],
        },
      ],
    )

    const byId = new Map(result.part.msg_1.map((item) => [item.id, item]))
    expect(result.part.msg_1.map((item) => item.id)).toEqual(["prt_1", "prt_2"])
    expect(partStatus(byId.get("prt_1"))).toBe("error")
    expect(partStatus(byId.get("prt_2"))).toBe("running")
  })
})

describe("getSessionMaterializationStatus", () => {
  test("requires assistant parts for renderable cached state", () => {
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: {},
    }

    expect(getSessionMaterializationStatus(state, "ses_1")).toEqual({
      hasMessages: true,
      renderable: false,
      missingPartMessageIDs: ["msg_1"],
    })
  })

  test("treats user-only cached state as renderable", () => {
    const state = {
      message: { ses_1: [{ ...message("msg_1"), role: "user" } as Message] },
      part: {},
    }

    expect(getSessionMaterializationStatus(state, "ses_1")).toEqual({
      hasMessages: true,
      renderable: true,
      missingPartMessageIDs: [],
    })
  })
})
