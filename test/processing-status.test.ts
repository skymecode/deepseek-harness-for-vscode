import { describe, expect, it } from 'vitest'
import type { ActiveSessionView, ChatItem } from '../src/domain/workbench-state.js'
import { shouldShowProcessing } from '../src/domain/processing-status.js'

const active = { running: true, approvals: [], questions: [] }
const user: ChatItem = { id: 'user', seq: 1, time: 1, kind: 'message', role: 'user', blocks: [{ kind: 'text', text: 'Hello' }] }
const tool: ChatItem = { id: 'tool', seq: 3, time: 3, kind: 'tool', title: 'bash', status: 'running' }
const reasoning: ChatItem = { id: 'partial-1:1', seq: 2, time: 2, kind: 'message', role: 'assistant', status: 'running', blocks: [{ kind: 'reasoning', text: 'Checking', streaming: true }] }

describe('silent model handoff detection', () => {
  it('shows before the first visible model delta, including an optimistic send', () => {
    expect(shouldShowProcessing(active, [], 'connected')).toBe(true)
    expect(shouldShowProcessing(active, [user], 'connected')).toBe(true)
    expect(shouldShowProcessing(undefined, [user], 'connected', true)).toBe(true)
    expect(shouldShowProcessing({ ...active, running: false }, [user], 'connected', true)).toBe(true)
    expect(shouldShowProcessing(active, [user, { ...reasoning, blocks: [{ kind: 'reasoning', text: '', streaming: true }] }], 'connected')).toBe(true)
  })

  it('hides when reasoning or text begins and stays hidden after the final answer', () => {
    expect(shouldShowProcessing(active, [user, reasoning], 'connected')).toBe(false)
    for (const streaming of [true, false]) {
      expect(shouldShowProcessing(active, [user, { ...reasoning, blocks: [{ kind: 'text', text: 'Hello!', streaming }] }], 'connected')).toBe(false)
    }
  })

  it('returns after a tool finishes and disappears when the next reasoning step starts', () => {
    const done = { ...tool, status: 'success' as const }
    expect(shouldShowProcessing(active, [user, reasoning, tool], 'connected')).toBe(false)
    expect(shouldShowProcessing(active, [user, reasoning, done], 'connected')).toBe(true)
    expect(shouldShowProcessing(active, [user, reasoning, done, { ...reasoning, id: 'partial-1:2', seq: 4 }], 'connected')).toBe(false)
  })

  it('also bridges completed reasoning and recoverable tool failures', () => {
    const finishedReasoning = { ...reasoning, blocks: [{ kind: 'reasoning' as const, text: 'Checked', duration: { startedAt: 1, endedAt: 2 } }] }
    expect(shouldShowProcessing(active, [user, finishedReasoning], 'connected')).toBe(true)
    expect(shouldShowProcessing(active, [user, { ...tool, status: 'error' }], 'connected')).toBe(true)
  })

  it('does not duplicate progress while another tool in the parallel batch still runs', () => {
    expect(shouldShowProcessing(active, [user, tool, { ...tool, id: 'tool-2', status: 'success' }], 'connected')).toBe(false)
  })

  it('ignores historical running tools before the latest user message and context wrappers', () => {
    const context: ChatItem = { id: 'context', seq: 4, time: 4, kind: 'context' }
    expect(shouldShowProcessing(active, [tool, user, context], 'connected')).toBe(true)
    expect(shouldShowProcessing(active, [user, reasoning, context], 'connected')).toBe(false)
  })

  it.each(['idle', 'starting', 'reconnecting', 'error'] as const)('does not advertise processing when the connection is %s', (phase) => {
    expect(shouldShowProcessing(active, [user], phase, true)).toBe(false)
  })

  it('hides on cancellation, completion and failed optimistic sends', () => {
    expect(shouldShowProcessing({ ...active, running: false }, [user], 'connected')).toBe(false)
    expect(shouldShowProcessing(undefined, [], 'connected')).toBe(false)
    expect(shouldShowProcessing(active, [user, { ...tool, kind: 'notice', status: 'error' }], 'connected')).toBe(false)
  })

  it('defers to approval, question, command and retry indicators', () => {
    expect(shouldShowProcessing({ ...active, approvals: [{ key: 'a', toolName: 'bash' }] }, [user], 'connected')).toBe(false)
    expect(shouldShowProcessing({ ...active, questions: [{ key: 'q', questions: [] }] }, [user], 'connected')).toBe(false)
    expect(shouldShowProcessing(active, [user, { ...tool, kind: 'notice' }], 'connected')).toBe(false)
    const retry: ActiveSessionView['retry'] = { provider: 'deepseek-official', mode: 'normal', attempt: 1, started: false }
    expect(shouldShowProcessing({ ...active, retry }, [user], 'connected')).toBe(false)
  })
})
