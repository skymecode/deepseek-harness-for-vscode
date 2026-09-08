import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../src/domain/workbench-state.js'
import { projectProcessingStatus } from '../src/domain/processing-status.js'

const active = { running: true, approvals: [], questions: [] }
const user: ChatItem = { id: 'user', seq: 1, time: 1, kind: 'message', role: 'user', blocks: [{ kind: 'text', text: 'Hello' }] }
const tool: ChatItem = { id: 'tool', seq: 3, time: 3, kind: 'tool', title: 'bash', status: 'running' }
const reasoning: ChatItem = { id: 'partial-1:1', seq: 2, time: 2, kind: 'message', role: 'assistant', status: 'running', blocks: [{ kind: 'reasoning', text: 'Checking', streaming: true }] }
const command: ChatItem = { id: 'command-compact', seq: 4, time: 4, kind: 'notice', title: '/compact', status: 'running' }
const retry = { provider: 'deepseek-official', mode: 'normal' as const, attempt: 1, started: false }

describe('silent-handoff activity status', () => {
  it('starts immediately for optimistic sends and accepted prompts without output', () => {
    for (const messages of [[], [user], [user, { ...reasoning, blocks: [] }]]) {
      expect(projectProcessingStatus(active, messages, 'connected')).toEqual({ kind: 'working' })
    }
    expect(projectProcessingStatus(undefined, [user], 'connected', true)).toEqual({ kind: 'working' })
    expect(projectProcessingStatus({ ...active, running: false }, [user], 'connected', true)).toEqual({ kind: 'working' })
  })

  it('hides during reasoning/tools/text and bridges the gap after tools finish', () => {
    const done = { ...tool, status: 'success' as const }
    const text = { ...reasoning, blocks: [{ kind: 'text' as const, text: 'Answer', streaming: true }] }
    const history: ChatItem[][] = [
      [user, reasoning],
      [user, reasoning, tool],
      [user, reasoning, done],
      [user, reasoning, done, { ...reasoning, id: 'partial-1:2', seq: 5 }],
      [user, reasoning, done, text],
      [user, reasoning, done, { ...text, status: 'success', blocks: [{ kind: 'text', text: 'Final answer' }] }],
    ]
    for (const [index, messages] of history.entries()) {
      expect(projectProcessingStatus(active, messages, 'connected')).toEqual({ kind: index === 2 ? 'working' : 'hidden' })
    }
    expect(projectProcessingStatus({ ...active, running: false }, history.at(-1)!, 'connected')).toEqual({ kind: 'hidden' })
  })

  it('waits for all parallel tools, but allows a handoff after a recoverable tool failure', () => {
    expect(projectProcessingStatus(active, [user, tool, { ...tool, id: 'tool-2', status: 'success' }], 'connected')).toEqual({ kind: 'hidden' })
    expect(projectProcessingStatus(active, [user, { ...tool, status: 'error' }], 'connected')).toEqual({ kind: 'working' })
  })

  it('hides as soon as the thinking header exists, but waits for an empty text block', () => {
    expect(projectProcessingStatus(active, [user, { ...reasoning, blocks: [{ kind: 'reasoning', text: '', streaming: true }] }], 'connected')).toEqual({ kind: 'hidden' })
    expect(projectProcessingStatus(active, [user, { ...reasoning, blocks: [{ kind: 'text', text: '', streaming: true }] }], 'connected')).toEqual({ kind: 'working' })
    expect(projectProcessingStatus(active, [user, { ...reasoning, blocks: [{ kind: 'reasoning', text: 'Finished thinking', streaming: false }] }], 'connected')).toEqual({ kind: 'working' })
  })

  it('does not show while a final answer is settling, even before the session flag catches up', () => {
    const ended = { ...active, turnActivity: { turn: 1, ended: true } }
    expect(projectProcessingStatus(ended, [user, reasoning], 'connected')).toEqual({ kind: 'hidden' })
    expect(projectProcessingStatus(ended, [user, { ...tool, status: 'success' }], 'connected')).toEqual({ kind: 'hidden' })
    // An explicit new send is different from an old running flag.
    expect(projectProcessingStatus(ended, [user], 'connected', true)).toEqual({ kind: 'working' })
  })

  it('uses the runtime turn so queued followups do not hide ongoing work', () => {
    const current = { ...active, turnActivity: { turn: 1, ended: false } }
    const queued = { ...user, id: 'queued', seq: 8 }
    expect(projectProcessingStatus(current, [user, { ...reasoning, turn: 1 }, queued], 'connected', true)).toEqual({ kind: 'hidden' })
    expect(projectProcessingStatus(current, [user, { ...tool, turn: 1 }, queued], 'connected', true)).toEqual({ kind: 'hidden' })
    expect(projectProcessingStatus(current, [user, { ...tool, turn: 1, status: 'success' }, queued], 'connected', true)).toEqual({ kind: 'working' })
  })

  it('ignores stale activity in older turns and informational context notices', () => {
    const current = { ...active, turnActivity: { turn: 2, ended: false } }
    const old = [user, { ...reasoning, turn: 1 }, { ...tool, turn: 1 }]
    expect(projectProcessingStatus(current, old, 'connected')).toEqual({ kind: 'working' })
    const notice: ChatItem = { id: 'model-change', seq: 9, time: 9, kind: 'notice', contextNotice: { kind: 'model-change', model: 'new' } }
    expect(projectProcessingStatus(current, [...old, { ...reasoning, turn: 2 }, notice], 'connected')).toEqual({ kind: 'hidden' })
    const error: ChatItem = { id: 'error', seq: 8, time: 8, kind: 'notice', status: 'error' }
    expect(projectProcessingStatus(current, [...old, error, notice], 'connected')).toEqual({ kind: 'hidden' })
  })

  it('uses the shared whale for host commands without a model turn, then hides on completion', () => {
    const idle = { ...active, running: false }
    expect(projectProcessingStatus(idle, [user, command], 'connected')).toEqual({ kind: 'working' })
    expect(projectProcessingStatus(idle, [user, { ...command, status: 'success' }], 'connected')).toEqual({ kind: 'hidden' })
    expect(projectProcessingStatus(idle, [user, { ...command, status: 'error' }], 'connected')).toEqual({ kind: 'hidden' })
  })

  it('does not revive stale historical partials, tools or commands when the session is idle', () => {
    const idle = { ...active, running: false }
    expect(projectProcessingStatus(idle, [reasoning, tool], 'connected')).toEqual({ kind: 'hidden' })
    expect(projectProcessingStatus(idle, [command, user], 'connected')).toEqual({ kind: 'hidden' })
  })

  it.each(['idle', 'starting', 'reconnecting', 'error'] as const)('hides when the connection is %s', (phase) => {
    expect(projectProcessingStatus(active, [user, reasoning, tool], phase, true)).toEqual({ kind: 'hidden' })
  })

  it('hides on cancellation, send failure and terminal errors even before running resets', () => {
    expect(projectProcessingStatus({ ...active, running: false }, [user], 'connected')).toEqual({ kind: 'hidden' })
    expect(projectProcessingStatus(undefined, [], 'connected')).toEqual({ kind: 'hidden' })
    expect(projectProcessingStatus(active, [user, { ...tool, kind: 'notice', status: 'error' }], 'connected')).toEqual({ kind: 'hidden' })
  })

  it('keeps genuine retry details in the shared status, but never masks approvals or questions', () => {
    expect(projectProcessingStatus({ ...active, retry }, [user, reasoning], 'connected')).toEqual({ kind: 'retry', retry })
    expect(projectProcessingStatus({ ...active, retry, running: false }, [user], 'connected')).toEqual({ kind: 'hidden' })
    expect(projectProcessingStatus({ ...active, retry }, [user], 'reconnecting')).toEqual({ kind: 'hidden' })
    expect(projectProcessingStatus({ ...active, retry, approvals: [{ key: 'a', toolName: 'bash' }] }, [user], 'connected')).toEqual({ kind: 'hidden' })
    expect(projectProcessingStatus({ ...active, retry, questions: [{ key: 'q', questions: [] }] }, [user], 'connected')).toEqual({ kind: 'hidden' })
  })
})
