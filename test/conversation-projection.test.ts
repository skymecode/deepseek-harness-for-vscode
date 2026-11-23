import { describe, expect, it } from 'vitest'
import { mergeLiveConversationProjection } from '../src/domain/conversation-projection.js'
import { projectConversation } from '../src/domain/workbench-state.js'
import type { HistoryEntry } from '../src/gateway/gateway-wire.js'

function entry(seq: number, type: string, data: unknown, surfaceOp?: 'append'): HistoryEntry {
  return { event: { seq, time: seq + 1, type, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) } } as HistoryEntry
}

describe('mergeLiveConversationProjection', () => {
  it('reuses the durable transcript and only projects the live stream suffix', () => {
    const durableEntries = [
      entry(0, 'turn/start', { turn: 1 }),
      entry(1, 'user/message', {
        id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }],
      }, 'append'),
    ]
    const live = [
      entry(2, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }),
      entry(3, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '流式' } }),
    ]
    const durable = projectConversation(durableEntries)
    const merged = mergeLiveConversationProjection(durable, live)
    expect(merged.messages.map((message) => message.kind)).toEqual(['message', 'message'])
    expect(merged.messages[0]).toMatchObject({ role: 'user' })
    expect(merged.messages[1]).toMatchObject({
      id: 'partial-1:1',
      status: 'running',
      streamKey: '1:1',
      blocks: [{ kind: 'text', text: '流式', streaming: true }],
    })
    expect(merged.turnActivity).toEqual({ turn: 1, ended: false })
  })

  it('replaces a durable running partial for the same stream key', () => {
    const durable = projectConversation([
      entry(0, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }),
      entry(1, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '旧' } }),
    ])
    const live = [
      entry(2, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }),
      entry(3, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '新' } }),
    ]
    const merged = mergeLiveConversationProjection(durable, live)
    expect(merged.messages).toHaveLength(1)
    expect(merged.messages[0]).toMatchObject({
      id: 'partial-1:1',
      blocks: [{ kind: 'text', text: '新', streaming: true }],
    })
  })

  it('returns the durable projection unchanged when the live stream is empty', () => {
    const durable = projectConversation([
      entry(0, 'user/message', {
        id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }],
      }, 'append'),
    ])
    expect(mergeLiveConversationProjection(durable, [])).toBe(durable)
  })
})
