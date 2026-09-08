import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../src/domain/workbench-state.js'
import { projectTurnProcesses } from '../src/domain/turn-process.js'

const user = (id: string): ChatItem => ({ id, seq: 0, time: 0, kind: 'message', role: 'user', blocks: [{ kind: 'text', text: id }] })
const assistant = (id: string, turn = 1, reasoning = false): ChatItem => ({ id, turn, seq: 1, time: 1, kind: 'message', role: 'assistant', streamKey: `${turn}:1`, blocks: [...(reasoning ? [{ kind: 'reasoning' as const, text: 'Thinking' }] : []), { kind: 'text', text: id }] })
const tool = (id: string, turn = 1): ChatItem => ({ id, turn, seq: 2, time: 2, kind: 'tool', status: 'success', title: 'bash', detail: 'npm test' })
const duration = { startedAt: 1000, endedAt: 9100 }

describe('completed-turn process projection', () => {
  it('keeps reasoning, tools and commentary live until the actual turn completes', () => {
    const items = [user('u'), assistant('thinking', 1, true), tool('bash'), assistant('answer')]
    expect(projectTurnProcesses(items, true)).toEqual({ messages: items, groups: [] })
    const finished = [...items.slice(0, -1), { ...items.at(-1)!, workDuration: duration }]
    const result = projectTurnProcesses(finished, true)
    expect(result.groups).toEqual([{ key: 'turn:1', messageIds: ['thinking', 'bash'], elapsedMs: 8100 }])
    expect(result.messages.at(-1)?.id).toBe('answer')
    expect(result.messages.at(-1)?.workDuration).toBeUndefined()
  })

  it('splits reasoning out of a mixed final answer without rewriting the source', () => {
    const answer = { ...assistant('answer', 1, true), workDuration: duration }
    const original = JSON.stringify(answer)
    const result = projectTurnProcesses([user('u'), answer], false)
    expect(result.groups[0]?.messageIds).toEqual(['process:answer'])
    expect(result.messages.map(item => item.id)).toEqual(['u', 'process:answer', 'answer'])
    expect(result.messages[1]?.blocks?.map(block => block.kind)).toEqual(['reasoning'])
    expect(result.messages[2]?.blocks?.map(block => block.kind)).toEqual(['text'])
    expect(result.messages[2]?.streamKey).toBeUndefined()
    expect(JSON.stringify(answer)).toBe(original)
  })

  it('leaves plain answers and their real timing alone', () => {
    const items = [user('u'), { ...assistant('answer'), workDuration: duration }]
    expect(projectTurnProcesses(items, false)).toEqual({ messages: items, groups: [] })
  })

  it('keeps historical groups while a newer turn is running', () => {
    const items = [user('u1'), assistant('old-think', 1, true), tool('old-tool'), assistant('old-answer'), user('u2'), assistant('new-think', 2, true), tool('new-tool', 2)]
    const result = projectTurnProcesses(items, true)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]?.messageIds).toEqual(['old-think', 'old-tool'])
    expect(result.messages.at(-1)).toBe(items.at(-1))
  })

  it('does not fold a live runtime turn just because a queued user message appears', () => {
    const items = [user('u1'), assistant('thinking', 1, true), user('queued'), tool('tool')]
    expect(projectTurnProcesses(items, true).groups).toEqual([])
  })

  it('separates adjacent runtime turns even when the page omits user messages', () => {
    const result = projectTurnProcesses([tool('t1'), assistant('a1'), tool('t2', 2), assistant('a2', 2)], false)
    expect(result.groups.map(group => group.key)).toEqual(['turn:1', 'turn:2'])
    expect(result.groups.map(group => group.messageIds)).toEqual([['t1'], ['t2']])
  })

  it('uses human boundaries for legacy transcripts, never merges two completed rounds', () => {
    const legacy = (item: ChatItem) => { const result = { ...item }; delete result.turn; delete result.streamKey; return result }
    const result = projectTurnProcesses([user('u1'), legacy(tool('t1')), legacy(assistant('a1')), user('u2'), legacy(tool('t2')), legacy(assistant('a2'))], false)
    expect(result.groups.map(group => group.messageIds)).toEqual([['t1'], ['t2']])
    expect(new Set(result.groups.map(group => group.key)).size).toBe(2)
  })

  it('keeps failures/stops outside the folded process and does not invent a final answer', () => {
    const failure: ChatItem = { id: 'turn-1-end', turn: 1, seq: 3, time: 3, kind: 'notice', status: 'error', title: 'Failed', detail: 'Disconnected', workDuration: duration }
    const result = projectTurnProcesses([user('u'), assistant('commentary'), tool('tool'), failure], false)
    expect(result.groups[0]?.messageIds).toEqual(['commentary', 'tool'])
    expect(result.messages.at(-1)).toBe(failure)
  })

  it('settles stale streaming markers and does not fabricate elapsed time for old imports', () => {
    const result = projectTurnProcesses([{ ...assistant('a', 1, true), status: 'running', blocks: [{ kind: 'reasoning', text: 'Old', streaming: true }] }], false)
    expect(result.groups[0]?.elapsedMs).toBeUndefined()
    expect(result.messages[0]?.status).toBe('info')
    expect(result.messages[0]?.blocks?.[0]?.streaming).toBe(false)
  })

  it('leaves host command results standalone', () => {
    const command: ChatItem = { id: 'command-1', seq: 1, time: 1, kind: 'notice', status: 'success', title: '/compact', detail: 'Compacted' }
    expect(projectTurnProcesses([command], false)).toEqual({ messages: [command], groups: [] })
  })
})
