import { describe, expect, it } from 'vitest'
import { projectReasoningTimeline } from '../src/domain/reasoning-timeline.js'
import { projectConversation, type ChatItem } from '../src/domain/workbench-state.js'
import { completedEditTurn } from './helpers/turn-history.js'

const thought = (id = 'partial-2:1', streamKey = '2:1'): ChatItem => ({
  id, seq: 1, time: 1, kind: 'message', role: 'assistant', streamKey, status: 'running',
  blocks: [{ kind: 'reasoning', text: 'Checking…', streaming: true }],
})

describe('per-turn reasoning timeline projection', () => {
  it('only creates points for assistant reasoning, never prompts, tools, text or notices', () => {
    const item = thought()
    const unrelated: ChatItem[] = [
      { ...item, role: 'user' }, { ...item, kind: 'tool' }, { ...item, kind: 'notice' },
      { ...item, kind: 'context' }, { ...item, blocks: [{ kind: 'text', text: 'Answer' }] },
    ]
    expect(projectReasoningTimeline(unrelated, true)).toEqual([])
    expect(projectReasoningTimeline([...unrelated, item], true)).toEqual([{
      key: 'step:2:1#0', groupId: 'turn:2', messageId: item.id, blockIndex: 0, running: true,
    }])
  })

  it('keeps stable points as a partial finalizes and the session stops', () => {
    const item = thought()
    const live = projectReasoningTimeline([item], true)
    const done = projectReasoningTimeline([{ ...item, id: 'event-40', status: 'success' }], false)
    expect(done).toEqual([{ ...live[0], messageId: 'event-40', running: false }])
  })

  it('restores completed turns directly from durable history without starting a new turn', () => {
    const messages = projectConversation([...completedEditTurn(1, 10), ...completedEditTurn(2, 30)]).messages
    const points = projectReasoningTimeline(messages, false)
    expect(points.map((point) => [point.key, point.groupId, point.running])).toEqual([
      ['step:1:1#0', 'turn:1', false], ['step:2:1#0', 'turn:2', false],
    ])
    expect(projectReasoningTimeline(messages, true)).toEqual(points)
  })

  it('adds only new reasoning steps and retains original block indices', () => {
    const first = { ...thought('a', '1:1'), status: 'success' as const }
    const next = { ...thought('b', '1:2'), blocks: [
      { kind: 'text' as const, text: 'Checking the result' },
      { kind: 'reasoning' as const, text: 'More thought', streaming: true },
    ] }
    const points = projectReasoningTimeline([first, next], true)
    expect(points.map(({ key, groupId, blockIndex }) => [key, groupId, blockIndex])).toEqual([
      ['step:1:1#0', 'turn:1', 0], ['step:1:2#1', 'turn:1', 1],
    ])
    expect(points.map(({ running }) => running)).toEqual([false, true])
  })

  it.each(['user', 'tool', 'notice'] as const)('does not reactivate stale partials when the tail is %s', (kind) => {
    const stale = thought()
    const tail: ChatItem = { id: 'new', seq: 2, time: 2, kind: kind === 'user' ? 'message' : kind, role: 'user' }
    expect(projectReasoningTimeline([stale, tail], true)[0]?.running).toBe(false)
  })

  it('ignores context metadata at the tail and stops pulsing a finished block', () => {
    const item = thought()
    const context: ChatItem = { id: 'ctx', seq: 2, time: 2, kind: 'context' }
    expect(projectReasoningTimeline([item, context], true)[0]?.running).toBe(true)
    expect(projectReasoningTimeline([{ ...item, blocks: [{ kind: 'reasoning', text: 'Done' }] }], true)[0]?.running).toBe(false)
  })

  it('isolates legacy or unrecognized identities instead of connecting different turns', () => {
    const legacy = { ...thought('legacy') }
    delete legacy.streamKey
    const points = projectReasoningTimeline([legacy, thought('unknown', 'opaque-key')], false)
    expect(points.map(({ groupId }) => groupId)).toEqual(['message:legacy', 'message:unknown'])
  })
})
