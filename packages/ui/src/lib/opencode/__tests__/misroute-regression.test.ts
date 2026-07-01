import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { opencodeClient } from "@/lib/opencode/client"

// ============================================================================
// Cross-project misroute regression — consolidated coverage map (story openchamber-5ki.20)
//
// This suite is the durable guard against reintroduction of the cross-project
// session/message misroute (a new session in project B whose first prompt was
// routed into a previously-active project A).
//
// AUDIT-THEN-FILL: groups (a),(b),(c),(e),(f),(g) are already guarded by tests
// written earlier in this story and are NOT duplicated here (duplication is a
// declared anti-goal). The one genuine remaining gap — group (d), a
// currentDirectory mutation DURING asynchronous file normalization — is filled
// below against the REAL client.sendMessage. The ONLY faked seam is the external
// SDK I/O boundary (session.promptAsync), reassigned on the REAL opencodeClient
// singleton; no internal module is mock.module()'d and afterAll restores every
// reassigned method so nothing leaks into later files.
//
// This file lives beside client-send-guard.test.ts (real-client harness) rather
// than under src/sync because the src/sync full-suite run globally mock.module()s
// @/lib/opencode/client (via session-actions.test.ts) — a stub without
// getSdkClient/sendMessage — which would make a real-client send test unrunnable
// there. Group (d) needs the real client and does NOT touch the session-ui-store,
// so it is immune to both the src/sync client mock and the src/lib session-store
// mock.
//
// COVERAGE MAP (group -> where the regression is guarded; each FAILS if its
// specific production bug/poison is reintroduced):
//   (a) new-session-in-B routes its send to B (top-level AC1 end-to-end)
//         resolution half: packages/ui/src/sync/__tests__/session-directory-poison.test.ts
//           ("an authoritative sync session directory beats a poisoned
//            currentSessionDirectory") — poisoned current /projA loses to
//            authoritative /projB.
//         send-forwarding half: packages/ui/src/lib/opencode/__tests__/client-send-guard.test.ts
//           ("sendMessage forwards a resolved directory to the SDK unchanged" +
//            "a resolved directory flows store -> client -> SDK shell unchanged").
//   (b) null-directory send blocked for prompt + slash command + shell
//         packages/ui/src/lib/opencode/__tests__/client-send-guard.test.ts
//           (sendMessage / sendCommand / shellSession all throw and never call
//            the SDK; routeMessage integration blocks a null-directory shell send).
//   (c) null fusion/source directory cannot route through the global; a
//       resolvable fusion directory routes to its own project (MultiRunFusionDialog
//       send arg = resolveSessionSendDirectory(fusionSession.id))
//         packages/ui/src/lib/session/sessionSendDirectory.test.ts
//           (null-resolvable session throws / never yields the global; a
//            current-session hint and an authoritative sync directory resolve to
//            the session's own project even when the global is foreign).
//   (d) file-attachment send whose currentDirectory CHANGES DURING file
//       normalization does NOT misroute
//         THIS FILE (below).
//   (e) getDirectoryForSession authoritative-first + last-resort preserved (AC2)
//         packages/ui/src/sync/__tests__/session-directory-poison.test.ts
//           (authoritative beats poison; currentSessionDirectory kept as the
//            current-session last-resort).
//   (f) reads thread the per-session directory to the SDK (AC3)
//         packages/ui/src/lib/opencode/__tests__/client-read-directory.test.ts
//           (listFiles/getSessionTodos/readFile/listCommands/listCommandsWithDetails/
//            listSkillsWithDetails route the passed directory, fall back only when
//            none is passed).
//   (g) SSE reducer populates session.directory so getDirectoryForSession self-heals
//         packages/ui/src/sync/__tests__/session-directory-poison.test.ts
//           ("a session.updated SSE event self-heals a stale currentSessionDirectory
//            via the real reducer").
// ============================================================================

const PROJ_A = "/projA" // the previously-active project (the misroute poison target)
const PROJ_B = "/projB" // the directory the caller passes for THIS send
const PROJ_NEUTRAL = "/projNeutral"

type SdkSendParams = { sessionID?: string; directory?: string | null }

const sdkSession = opencodeClient.getSdkClient().session
const realPromptAsync = sdkSession.promptAsync
const realDirectory = opencodeClient.getDirectory()

let promptCalls: SdkSendParams[] = []

beforeEach(() => {
  promptCalls = []
  opencodeClient.setDirectory(PROJ_NEUTRAL)
  sdkSession.promptAsync = (async (parameters: SdkSendParams) => {
    promptCalls.push(parameters)
    return { data: true }
  }) as unknown as typeof sdkSession.promptAsync
})

afterAll(() => {
  sdkSession.promptAsync = realPromptAsync
  opencodeClient.setDirectory(realDirectory)
})

const sendBase = { id: "ses_attach", providerID: "test-provider", modelID: "test-model" }

// A file whose `mime` getter flips the process-global to the foreign /projA the
// moment normalizeFilePart reads it — i.e. synchronously inside the awaited
// file-normalization loop, BEFORE requestDirectory is captured. `image/png` is
// neither HEIC nor text-normalizable, so normalizeFilePart returns it unchanged
// after one await tick. `fired` proves the interleave actually happened.
function makePoisoningFile(fired: { value: boolean }) {
  return {
    type: "file" as const,
    get mime() {
      fired.value = true
      opencodeClient.setDirectory(PROJ_A)
      return "image/png"
    },
    filename: "a.png",
    url: "data:image/png;base64,AAAA",
  }
}

describe("group (d) — a currentDirectory mutation DURING file normalization does not misroute the send", () => {
  // client.sendMessage derives requestDirectory from the immutable `directory`
  // param and never re-reads this.currentDirectory; the file-normalization loop
  // is awaited BEFORE the SDK call. If requestDirectory were (re)read from the
  // process-global after the async loop, the mid-normalization flip to /projA
  // would leak to the SDK. This test forces exactly that flip and asserts the
  // SDK still receives the originally-passed /projB. FAILS if the send re-reads
  // the mutated global instead of the captured param.
  test("primary files loop: SDK receives the originally-passed /projB even though the global flips to /projA mid-normalization", async () => {
    const fired = { value: false }

    await opencodeClient.sendMessage({
      ...sendBase,
      text: "here is a file",
      directory: PROJ_B,
      files: [makePoisoningFile(fired)],
    })

    // The interleave actually happened (guards the test itself).
    expect(fired.value).toBe(true)
    expect(opencodeClient.getDirectory()).toBe(PROJ_A)

    // ...yet the send routed to the originally-passed directory, not the mutated global.
    expect(promptCalls).toHaveLength(1)
    expect(promptCalls[0].sessionID).toBe("ses_attach")
    expect(promptCalls[0].directory).toBe(PROJ_B)
    expect(promptCalls[0].directory).not.toBe(PROJ_A)
  })

  // The additionalParts file loop is a SECOND awaited normalization surface that
  // also runs before requestDirectory is captured (batch/queued sends). Same
  // invariant: a mid-normalization global flip must not leak to the SDK.
  test("additionalParts files loop: a mid-normalization global flip to /projA still routes to the originally-passed /projB", async () => {
    const fired = { value: false }

    await opencodeClient.sendMessage({
      ...sendBase,
      text: "batch send",
      directory: PROJ_B,
      additionalParts: [
        { text: "queued follow-up", files: [makePoisoningFile(fired)] },
      ],
    })

    expect(fired.value).toBe(true)
    expect(opencodeClient.getDirectory()).toBe(PROJ_A)

    expect(promptCalls).toHaveLength(1)
    expect(promptCalls[0].directory).toBe(PROJ_B)
    expect(promptCalls[0].directory).not.toBe(PROJ_A)
  })
})
