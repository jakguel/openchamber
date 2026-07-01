import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import type { ProjectEntry } from "@/lib/api/types"
import { opencodeClient } from "@/lib/opencode/client"
import { invalidateCommandsLoadCache, useCommandsStore } from "@/stores/useCommandsStore"
import { useProjectsStore } from "@/stores/useProjectsStore"

const GLOBAL_DIR = "/projA"
const ACTIVE_PROJECT_DIR = "/projB"

type ListParams = { directory?: string | null }

const sdk = opencodeClient.getSdkClient()
const sdkCommand = sdk.command

const realCommandList = sdkCommand.list
const realDirectory = opencodeClient.getDirectory()
const realProjects = useProjectsStore.getState().projects
const realActiveProjectId = useProjectsStore.getState().activeProjectId

const activeProject: ProjectEntry = { id: "proj-b", path: ACTIVE_PROJECT_DIR }

let commandListCalls: (ListParams | undefined)[] = []

beforeEach(() => {
  commandListCalls = []
  opencodeClient.setDirectory(GLOBAL_DIR)
  useProjectsStore.setState({ projects: [activeProject], activeProjectId: activeProject.id })
  useCommandsStore.setState({ commands: [] })
  invalidateCommandsLoadCache(ACTIVE_PROJECT_DIR)
  invalidateCommandsLoadCache(GLOBAL_DIR)
  sdkCommand.list = (async (parameters?: ListParams) => {
    commandListCalls.push(parameters)
    return { data: [] }
  }) as unknown as typeof sdkCommand.list
})

afterAll(() => {
  sdkCommand.list = realCommandList
  opencodeClient.setDirectory(realDirectory)
  useProjectsStore.setState({ projects: realProjects, activeProjectId: realActiveProjectId })
})

describe("useCommandsStore threads the resolved request directory to the SDK", () => {
  test("loadCommands routes the active project directory, not the global directory", async () => {
    await useCommandsStore.getState().loadCommands()

    expect(commandListCalls).toHaveLength(1)
    expect(commandListCalls[0]?.directory).toBe(ACTIVE_PROJECT_DIR)
    expect(commandListCalls[0]?.directory).not.toBe(GLOBAL_DIR)
  })
})
