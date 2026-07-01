import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { opencodeClient } from "@/lib/opencode/client"

// The only faked seam is the external SDK I/O boundary: the memoized file /
// session / command / app sub-client methods are reassigned on the REAL
// opencodeClient singleton (no mock.module on any internal module). afterAll
// restores the originals so nothing leaks into later test files.

const PROJ_A = "/projA"
const PROJ_B = "/projB"

type ReadParams = { path?: string; sessionID?: string; directory?: string | null }

const sdk = opencodeClient.getSdkClient()
const sdkFile = sdk.file
const sdkSession = sdk.session
const sdkCommand = sdk.command
const sdkApp = sdk.app

const realFileList = sdkFile.list
const realFileRead = sdkFile.read
const realSessionTodo = sdkSession.todo
const realCommandList = sdkCommand.list
const realAppSkills = sdkApp.skills
const realDirectory = opencodeClient.getDirectory()

let fileListCalls: (ReadParams | undefined)[] = []
let fileReadCalls: (ReadParams | undefined)[] = []
let sessionTodoCalls: (ReadParams | undefined)[] = []
let commandListCalls: (ReadParams | undefined)[] = []
let appSkillsCalls: (ReadParams | undefined)[] = []

beforeEach(() => {
  fileListCalls = []
  fileReadCalls = []
  sessionTodoCalls = []
  commandListCalls = []
  appSkillsCalls = []
  opencodeClient.setDirectory(PROJ_A)
  sdkFile.list = (async (parameters?: ReadParams) => {
    fileListCalls.push(parameters)
    return { data: [] }
  }) as unknown as typeof sdkFile.list
  sdkFile.read = (async (parameters?: ReadParams) => {
    fileReadCalls.push(parameters)
    return { data: "content" }
  }) as unknown as typeof sdkFile.read
  sdkSession.todo = (async (parameters?: ReadParams) => {
    sessionTodoCalls.push(parameters)
    return { data: [] }
  }) as unknown as typeof sdkSession.todo
  sdkCommand.list = (async (parameters?: ReadParams) => {
    commandListCalls.push(parameters)
    return { data: [] }
  }) as unknown as typeof sdkCommand.list
  sdkApp.skills = (async (parameters?: ReadParams) => {
    appSkillsCalls.push(parameters)
    return { data: [] }
  }) as unknown as typeof sdkApp.skills
})

afterAll(() => {
  sdkFile.list = realFileList
  sdkFile.read = realFileRead
  sdkSession.todo = realSessionTodo
  sdkCommand.list = realCommandList
  sdkApp.skills = realAppSkills
  opencodeClient.setDirectory(realDirectory)
})

describe("client read decoupling — a passed directory is routed to the SDK", () => {
  // Fails while listFiles forces this.currentDirectory: the SDK would receive
  // /projA (the global) instead of the passed /projB.
  test("listFiles routes the passed directory to file.list", async () => {
    await opencodeClient.listFiles(PROJ_B)
    expect(fileListCalls).toHaveLength(1)
    expect(fileListCalls[0]?.directory).toBe(PROJ_B)
  })

  test("listFiles falls back to the current directory when none is passed", async () => {
    await opencodeClient.listFiles()
    expect(fileListCalls[0]?.directory).toBe(PROJ_A)
  })

  test("getSessionTodos routes the passed directory to session.todo", async () => {
    await opencodeClient.getSessionTodos("session-a", PROJ_B)
    expect(sessionTodoCalls[0]?.directory).toBe(PROJ_B)
  })

  test("getSessionTodos falls back to the current directory when none is passed", async () => {
    await opencodeClient.getSessionTodos("session-a")
    expect(sessionTodoCalls[0]?.directory).toBe(PROJ_A)
  })

  test("readFile routes the passed directory to file.read", async () => {
    await opencodeClient.readFile("src/a.ts", PROJ_B)
    expect(fileReadCalls[0]?.directory).toBe(PROJ_B)
  })

  test("readFile falls back to the current directory when none is passed", async () => {
    await opencodeClient.readFile("src/a.ts")
    expect(fileReadCalls[0]?.directory).toBe(PROJ_A)
  })

  test("listCommands routes the passed directory to command.list", async () => {
    await opencodeClient.listCommands(PROJ_B)
    expect(commandListCalls[0]?.directory).toBe(PROJ_B)
  })

  test("listCommands falls back to the current directory when none is passed", async () => {
    await opencodeClient.listCommands()
    expect(commandListCalls[0]?.directory).toBe(PROJ_A)
  })

  test("listCommandsWithDetails routes the passed directory to command.list", async () => {
    await opencodeClient.listCommandsWithDetails(PROJ_B)
    expect(commandListCalls[0]?.directory).toBe(PROJ_B)
  })

  test("listCommandsWithDetails falls back to the current directory when none is passed", async () => {
    await opencodeClient.listCommandsWithDetails()
    expect(commandListCalls[0]?.directory).toBe(PROJ_A)
  })

  test("listSkillsWithDetails routes the passed directory to app.skills", async () => {
    await opencodeClient.listSkillsWithDetails(PROJ_B)
    expect(appSkillsCalls[0]?.directory).toBe(PROJ_B)
  })

  test("listSkillsWithDetails falls back to the current directory when none is passed", async () => {
    await opencodeClient.listSkillsWithDetails()
    expect(appSkillsCalls[0]?.directory).toBe(PROJ_A)
  })
})
