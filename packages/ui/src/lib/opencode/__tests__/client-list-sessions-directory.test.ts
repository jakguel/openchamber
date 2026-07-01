import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { opencodeClient } from "@/lib/opencode/client"

// The only faked seam is the external SDK I/O boundary: session.list on the
// REAL opencodeClient singleton is reassigned to capture the params it
// receives (no mock.module on any internal module). The REAL listSessions
// production method is exercised. afterAll restores the original so nothing
// leaks into later test files.

const PROJ_A = "/projA"
const PROJ_B = "/projB"

type ListParams = { directory?: string | null }

const sdk = opencodeClient.getSdkClient()
const sdkSession = sdk.session
const realSessionList = sdkSession.list
const realDirectory = opencodeClient.getDirectory()

let sessionListCalls: (ListParams | undefined)[] = []

beforeEach(() => {
  sessionListCalls = []
  opencodeClient.setDirectory(PROJ_A)
  sdkSession.list = (async (parameters?: ListParams) => {
    sessionListCalls.push(parameters)
    return { data: [] }
  }) as unknown as typeof sdkSession.list
})

afterAll(() => {
  sdkSession.list = realSessionList
  opencodeClient.setDirectory(realDirectory)
})

describe("listSessions — a passed directory is routed to the SDK", () => {
  // Fails while listSessions forces this.currentDirectory: the SDK would
  // receive /projA (the global) instead of the passed /projB.
  test("routes the passed directory to session.list", async () => {
    await opencodeClient.listSessions(PROJ_B)
    expect(sessionListCalls).toHaveLength(1)
    expect(sessionListCalls[0]?.directory).toBe(PROJ_B)
  })

  test("falls back to the current directory when none is passed", async () => {
    await opencodeClient.listSessions()
    expect(sessionListCalls).toHaveLength(1)
    expect(sessionListCalls[0]?.directory).toBe(PROJ_A)
  })
})
