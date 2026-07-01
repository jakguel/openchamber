import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { opencodeClient } from "@/lib/opencode/client"
import { routeMessage } from "@/sync/session-ui-store"

// The only faked seam is the external SDK I/O boundary: the memoized session
// instance's promptAsync/command/shell methods are reassigned on the REAL
// opencodeClient singleton (no mock.module on any internal module). afterAll
// restores the originals so nothing leaks into later test files.

const PROJ_A = "/projA"
const PROJ_B = "/projB"

type SdkSendParams = { sessionID?: string; directory?: string | null }

const sdkSession = opencodeClient.getSdkClient().session
const realPromptAsync = sdkSession.promptAsync
const realCommand = sdkSession.command
const realShell = sdkSession.shell
const realDirectory = opencodeClient.getDirectory()

let promptCalls: SdkSendParams[] = []
let commandCalls: SdkSendParams[] = []
let shellCalls: SdkSendParams[] = []

beforeEach(() => {
  promptCalls = []
  commandCalls = []
  shellCalls = []
  opencodeClient.setDirectory(PROJ_A)
  sdkSession.promptAsync = (async (parameters: SdkSendParams) => {
    promptCalls.push(parameters)
    return { data: true }
  }) as unknown as typeof sdkSession.promptAsync
  sdkSession.command = (async (parameters: SdkSendParams) => {
    commandCalls.push(parameters)
    return { data: true }
  }) as unknown as typeof sdkSession.command
  sdkSession.shell = (async (parameters: SdkSendParams) => {
    shellCalls.push(parameters)
    return { data: { info: { id: "msg_x", time: { created: 1 } }, parts: [] } }
  }) as unknown as typeof sdkSession.shell
})

afterAll(() => {
  sdkSession.promptAsync = realPromptAsync
  sdkSession.command = realCommand
  sdkSession.shell = realShell
  opencodeClient.setDirectory(realDirectory)
})

async function expectRejection(run: () => Promise<unknown>): Promise<void> {
  let threw = false
  try {
    await run()
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
}

describe("client send guard — no resolvable directory is non-sendable (real client + SDK boundary)", () => {
  const base = { id: "session-a", providerID: "test-provider", modelID: "test-model" }

  // Fails if `?? this.currentDirectory` is reintroduced on the prompt path:
  // promptAsync would be called with the poisoned global instead of throwing.
  test("sendMessage throws and never calls promptAsync when no directory resolves", async () => {
    await expectRejection(() => opencodeClient.sendMessage({ ...base, text: "hello", directory: null }))
    expect(promptCalls).toHaveLength(0)
  })

  test("sendCommand throws and never calls session.command when no directory resolves", async () => {
    await expectRejection(() => opencodeClient.sendCommand({ ...base, command: "build", directory: null }))
    expect(commandCalls).toHaveLength(0)
  })

  test("shellSession throws and never calls session.shell when no directory resolves", async () => {
    await expectRejection(() => opencodeClient.shellSession({
      sessionId: "session-a",
      command: "ls",
      agent: "build",
      model: { providerID: "test-provider", modelID: "test-model" },
      directory: null,
    }))
    expect(shellCalls).toHaveLength(0)
  })

  // Happy path: a resolved directory is forwarded to the SDK unchanged, never the global.
  test("sendMessage forwards a resolved directory to the SDK unchanged", async () => {
    const id = await opencodeClient.sendMessage({ ...base, text: "hello", directory: PROJ_B })
    expect(typeof id).toBe("string")
    expect(promptCalls).toHaveLength(1)
    expect(promptCalls[0].directory).toBe(PROJ_B)
  })
})

describe("routeMessage integration — real store dispatch through the real client boundary", () => {
  // End-to-end: real routeMessage -> real opencodeClient.shellSession guard.
  // Fails if a null resolved directory reaches the SDK instead of being blocked.
  test("a null-directory send is blocked and never reaches the SDK", async () => {
    await expectRejection(() => routeMessage({
      sessionId: "session-a",
      directory: null,
      content: "pwd",
      providerID: "test-provider",
      modelID: "test-model",
      inputMode: "shell",
    }))
    expect(shellCalls).toHaveLength(0)
  })

  test("a resolved directory flows store -> client -> SDK shell unchanged", async () => {
    await routeMessage({
      sessionId: "session-a",
      directory: PROJ_B,
      content: "pwd",
      providerID: "test-provider",
      modelID: "test-model",
      inputMode: "shell",
    })
    expect(shellCalls).toHaveLength(1)
    expect(shellCalls[0].directory).toBe(PROJ_B)
  })
})
