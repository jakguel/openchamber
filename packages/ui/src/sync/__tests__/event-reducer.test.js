import { describe, expect, it } from 'bun:test'
import { applyDirectoryEvent, finalizeOrphanedRunningParts } from '../event-reducer'
import { INITIAL_STATE } from '../types'

describe('applyDirectoryEvent', () => {
  it('does not duplicate overlapping delta text after a newer part.updated replaces an older one', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-1'
    const partID = 'part-1'

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          messageID,
          text: 'Fix typo in ToolOutputDialog — ',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          messageID,
          text: 'Fix typo in ToolOutputDialog — toolFailedToReadDiagram vs toolFailedReadDiagram • Let me fix it.',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: 'toolFailedToReadDiagram vs toolFailedReadDiagram • Let me fix it.',
      },
    })

    expect(state.part[messageID]).toHaveLength(1)
    expect(state.part[messageID]?.[0]?.text).toBe(
      'Fix typo in ToolOutputDialog — toolFailedToReadDiagram vs toolFailedReadDiagram • Let me fix it.',
    )
  })

  it('appends only the non-overlapping suffix of a streaming delta', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-2'
    const partID = 'part-2'

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          messageID,
          text: 'toolFailedToReadDiagram vs toolFailedRead',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          messageID,
          text: 'toolFailedToReadDiagram vs toolFailedReadDiagra',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: 'Diagram • Let me fix it.',
      },
    })

    expect(state.part[messageID]?.[0]?.text).toBe(
      'toolFailedToReadDiagram vs toolFailedReadDiagram • Let me fix it.',
    )
  })

  it('appends a non-overlapping delta unchanged', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-3'
    const partID = 'part-3'

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          messageID,
          text: 'PR comment done — ',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: 'Let me fix it.',
      },
    })

    expect(state.part[messageID]?.[0]?.text).toBe('PR comment done — Let me fix it.')
  })

  it('preserves legitimate repeated output when no updated-to-delta dedupe window is active', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-4'
    const partID = 'part-4'

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          messageID,
          text: 'ha',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: 'ha',
      },
    })

    expect(state.part[messageID]?.[0]?.text).toBe('haha')
  })

  it('does not let a stale running tool update overwrite a completed tool part', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-5'
    const partID = 'part-5'

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'tool',
          messageID,
          tool: 'apply_patch',
          state: {
            status: 'completed',
            time: {
              start: 10,
              end: 20,
            },
          },
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'tool',
          messageID,
          tool: 'apply_patch',
          state: {
            status: 'running',
            time: {
              start: 10,
            },
          },
        },
      },
    })

    expect(state.part[messageID]?.[0]?.state?.status).toBe('completed')
    expect(state.part[messageID]?.[0]?.state?.time?.end).toBe(20)
  })
})

describe('finalizeOrphanedRunningParts — return contract', () => {
  it('reports a mutation on the first finalize and a no-op (false) on a second pass over already-finalized parts', () => {
    const state = structuredClone(INITIAL_STATE)
    const sessionID = 'ses_x'
    const messageID = 'msg_x'
    state.message = {
      [sessionID]: [{ id: messageID, sessionID, role: 'assistant', time: { created: 1 } }],
    }
    state.part = {
      [messageID]: [
        {
          id: 'prt_x',
          sessionID,
          messageID,
          type: 'tool',
          callID: 'call_x',
          tool: 'bash',
          state: { status: 'running', input: { command: 'sleep 999' }, time: { start: 5_000 } },
        },
      ],
    }

    const firstPass = finalizeOrphanedRunningParts(state, sessionID)
    expect(firstPass).toBe(true)
    const finalizedPart = state.part[messageID][0]
    expect(finalizedPart.state.status).toBe('error')

    const secondPass = finalizeOrphanedRunningParts(state, sessionID)
    expect(secondPass).toBe(false)
    expect(state.part[messageID][0]).toBe(finalizedPart)
    expect(state.part[messageID][0].state.status).toBe('error')
  })
})
