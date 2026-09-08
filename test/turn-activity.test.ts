import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '../src/gateway/gateway-wire.js'
import { hasVisibleTurnActivity, projectTurnActivityScope } from '../src/domain/turn-activity.js'
import { projectConversation, type ChatItem } from '../src/domain/workbench-state.js'
import { projectProcessingStatus } from '../src/domain/processing-status.js'

function entry(seq: number, type: string, data: unknown): HistoryEntry {
  return { event: { seq, time: seq + 1, type, data, surfaceOp: 'append' } } as HistoryEntry
}

describe('runtime turn activity', () => {
  it('projects a fresh turn before its first visible message and retains its end marker', () => {
    expect(projectTurnActivityScope([])).toBeUndefined()
    const start = entry(0, 'turn/start', { turn: 1 })
    const end = entry(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(projectTurnActivityScope([start])).toEqual({ turn: 1, ended: false })
    expect(projectTurnActivityScope([start, end])).toEqual({ turn: 1, ended: true })
    expect(projectTurnActivityScope([start, end, entry(3, 'turn/start', { turn: 2 })])).toEqual({ turn: 2, ended: false })
  })

  it('recovers a live paged turn from tools, and never reopens it for late chunks', () => {
    const tool = entry(8, 'tool/call', { turn: 4, callId: 'a', name: 'bash', arguments: '{}' })
    expect(projectTurnActivityScope([tool])).toEqual({ turn: 4, ended: false })
    const end = entry(9, 'turn/end', { turn: 4, reason: { kind: 'aborted' } })
    const late = entry(10, 'assistant/chunk', { turn: 4, step: 1, chunk: { type: 'text-delta', index: 0, text: 'late' } })
    expect(projectTurnActivityScope([tool, end, late])).toEqual({ turn: 4, ended: true })
    expect(projectTurnActivityScope([entry(11, 'turn/start', { turn: 5 }), end, late])).toEqual({ turn: 5, ended: false })
  })

  it('uses the stream key for legacy assistant identity and keeps a completed older turn quiet', () => {
    const message: ChatItem = { id: 'old', seq: 1, time: 1, kind: 'message', role: 'assistant', status: 'running', streamKey: '2:1', blocks: [{ kind: 'text', text: 'answer', streaming: true }] }
    expect(hasVisibleTurnActivity([message], { turn: 2, ended: false })).toBe(true)
    expect(hasVisibleTurnActivity([message], { turn: 2, ended: true })).toBe(false)
    expect(hasVisibleTurnActivity([message], { turn: 3, ended: false })).toBe(false)
    expect(hasVisibleTurnActivity([{ ...message, workDuration: { startedAt: 0, endedAt: 1 } }], { turn: 2, ended: false })).toBe(false)
  })

  it('follows real projected chunks and parallel tool results through a complete turn', () => {
    const entries: HistoryEntry[] = []
    const active = { running: true, approvals: [], questions: [] }
    const push = (type: string, data: unknown, expected: 'working' | 'hidden') => {
      entries.push(entry(entries.length, type, data))
      const projection = projectConversation(entries)
      expect(projectProcessingStatus({ ...active, ...projection }, projection.messages, 'connected'), type).toEqual({ kind: expected })
    }
    const chunk = (value: object, expected: 'working' | 'hidden', step = 1) => push('assistant/chunk', { turn: 1, step, chunk: value }, expected)
    const result = (id: string, expected: 'working' | 'hidden') => push('tool/result', { turn: 1, step: 1, message: { id: `r-${id}`, role: 'tool', source: { kind: 'tool', callId: id }, content: [{ type: 'text', text: 'done' }] } }, expected)
    push('turn/start', { turn: 1 }, 'working')
    push('user/message', { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }, 'working')
    chunk({ type: 'block-start', index: 0, blockType: 'reasoning' }, 'hidden')
    chunk({ type: 'reasoning-delta', index: 0, text: 'Think' }, 'hidden')
    chunk({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Think' } }, 'working')
    push('tool/call', { turn: 1, step: 1, callId: 'a', name: 'bash', arguments: '{}' }, 'hidden')
    push('tool/call', { turn: 1, step: 1, callId: 'b', name: 'read', arguments: '{}' }, 'hidden')
    result('b', 'hidden')
    result('a', 'working')
    chunk({ type: 'block-start', index: 0, blockType: 'text' }, 'working', 2)
    chunk({ type: 'text-delta', index: 0, text: 'Final answer' }, 'hidden', 2)
    chunk({ type: 'block-end', index: 0, block: { type: 'text', text: 'Final answer' } }, 'hidden', 2)
    push('assistant/message', { turn: 1, step: 2, message: { id: 'final', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'Final answer' }] } }, 'hidden')
    push('turn/end', { turn: 1, reason: { kind: 'completed' } }, 'hidden')
    // No response in the next turn yet, despite a complete prior answer.
    push('turn/start', { turn: 2 }, 'working')
  })
})
