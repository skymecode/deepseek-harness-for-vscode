import { describe, expect, it } from 'vitest'
import type { SessionAssistantStreamBaseline, SessionAssistantStreamFrame } from '@deepseek-ai/dsh-api-session-controller/types'
import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'
import { AssistantStreamState, presentationHistory } from '../src/gateway/assistant-stream-state.js'
import type { HistoryEntry } from '../src/gateway/gateway-wire.js'
import { projectConversation } from '../src/domain/workbench-state.js'
import { NodeGatewayClient } from '../src/gateway/node-gateway-client.js'

const start = { type: 'start', attemptId: 'attempt-1', revision: 1, startedAfterSeq: 10, turn: 1, step: 1 } as SessionAssistantStreamFrame
const reasoning: StreamChunk = { type: 'block-start', index: 0, blockType: 'reasoning' }
function chunk(index: number, value: StreamChunk): SessionAssistantStreamFrame {
  return { type: 'chunk', attemptId: 'attempt-1', revision: index + 2, index, time: 100 + index, chunk: value } as unknown as SessionAssistantStreamFrame
}

describe('Harness V2 assistant stream adapter', () => {
  it('projects dense live deltas without advancing the durable session cursor', () => {
    const state = new AssistantStreamState()
    state.accept(start)
    state.accept(chunk(0, reasoning))
    state.accept(chunk(1, { type: 'reasoning-delta', index: 0, text: 'Think' }))
    state.accept(chunk(2, { type: 'reasoning-delta', index: 0, text: ' more' }))
    expect(projectConversation(state.entries()).messages[0]).toMatchObject({
      id: 'partial-1:1', streamKey: '1:1', seq: 10.5,
      blocks: [{ kind: 'reasoning', text: 'Think more', streaming: true }],
    })
    expect(state.entries().every(({ event }) => event.seq === 10.5)).toBe(true)
    state.accept(chunk(2, { type: 'reasoning-delta', index: 0, text: ' more' }))
    expect(state.entries()).toHaveLength(3)
  })

  it('restores a compact reconnect baseline and appends only subsequent chunks', () => {
    const state = new AssistantStreamState()
    state.reset({
      revision: 4,
      activeAttempt: {
        attemptId: 'attempt-1', startedAfterSeq: 10, turn: 1, step: 1, nextIndex: 3,
        stream: [
          { type: 'chunk', time: 100, chunk: reasoning },
          { type: 'reasoning-chunks', time0: 101, index: 0, dt: [1], texts: ['Think', ' more'] },
        ],
      },
    } as unknown as SessionAssistantStreamBaseline)
    state.accept(chunk(3, { type: 'reasoning-delta', index: 0, text: ' now' }))
    expect(projectConversation(state.entries()).messages[0]?.blocks?.[0]?.text).toBe('Think more now')
    state.reset({ revision: 5 })
    expect(state.entries()).toEqual([])
  })

  it('requests a reconnect on missing revisions or chunk indexes instead of silently corrupting text', () => {
    const state = new AssistantStreamState()
    state.accept(start)
    expect(() => state.accept(chunk(1, reasoning))).toThrow(/revision gap/)
    state.reset()
    state.accept(start)
    expect(() => state.accept({ ...chunk(1, reasoning), revision: 2 })).toThrow(/index mismatch/)
  })

  it('keeps a committed prefix until its durable event arrives, with the same UI stream key', () => {
    const state = new AssistantStreamState()
    state.accept(start)
    state.accept(chunk(0, reasoning))
    state.accept(chunk(1, { type: 'reasoning-delta', index: 0, text: 'Think' }))
    state.accept({ type: 'end', attemptId: 'attempt-1', revision: 4, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 11 } } as SessionAssistantStreamFrame)
    expect(state.entries()).toHaveLength(2)
    const event = completedMessage().event
    state.settle(event)
    expect(state.entries()).toHaveLength(0)
    const messages = projectConversation(presentationHistory([{ event }], state.entries())).messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id: 'event-11', streamKey: '1:1', blocks: [{ kind: 'reasoning', text: 'Think', duration: { startedAt: 100, endedAt: 110 } }] })
  })

  it('accepts durable-before-end ordering and drops abandoned attempts and session-switch state', () => {
    const state = new AssistantStreamState()
    state.accept(start)
    state.accept(chunk(0, reasoning))
    state.settle(completedMessage().event)
    expect(() => state.accept({ type: 'end', attemptId: 'attempt-1', revision: 3, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 11 } } as SessionAssistantStreamFrame)).not.toThrow()
    state.accept(start)
    state.accept(chunk(0, reasoning))
    state.accept({ type: 'end', attemptId: 'attempt-1', revision: 3, index: 1, outcome: { kind: 'abandoned' } } as SessionAssistantStreamFrame)
    expect(state.entries()).toEqual([])
    state.accept(start)
    state.accept(chunk(0, reasoning))
    state.reset()
    expect(state.entries()).toEqual([])
  })

  it('unwraps durable V2 history without injecting synthetic pagination records', () => {
    const entry = completedMessage()
    const records = [{ type: 'event', ...entry }]
    const durable = NodeGatewayClient.expandRecords(records) as HistoryEntry[]
    expect(durable).toEqual([entry])
    expect(durable[0]?.event).toBe(entry.event)
    const first = presentationHistory(durable)
    const second = presentationHistory(durable)
    expect(first[0]).toBe(second[0])
    expect(durable).toHaveLength(1)
    expect(projectConversation(first).messages).toHaveLength(1)
    expect(() => NodeGatewayClient.expandRecords([{ type: 'chunks' }])).toThrow(/V2 event/)
  })
})

function completedMessage(): HistoryEntry {
  return { event: {
    type: 'assistant/message', seq: 11, time: 111,
    data: {
      turn: 1, step: 1,
      message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'reasoning', text: 'Think' }] },
      stream: [
        { type: 'chunk', time: 100, chunk: reasoning },
        { type: 'reasoning-chunks', time0: 101, index: 0, dt: [], texts: ['Think'] },
        { type: 'chunk', time: 110, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Think' } } },
      ],
    },
  } } as HistoryEntry
}
