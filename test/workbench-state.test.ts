import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '../src/gateway/gateway-wire.js'
import {
  EXTENSION_COMMANDS,
  projectConversation,
  projectionCommands,
  projectionPermissions,
  projectionTokenUsage,
} from '../src/domain/workbench-state.js'

describe('projectConversation', () => {
  it('projects durable messages, reasoning, tools and the latest todo snapshot', () => {
    const entries = [
      entry(0, 'user/message', {
        id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '修复测试' }],
      }, 'append'),
      entry(1, 'assistant/message', {
        turn: 1, step: 1,
        message: {
          id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
          content: [{ type: 'reasoning', text: '先定位' }, { type: 'text', text: '开始修改。' }],
        },
      }, 'append'),
      entry(2, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }),
      entry(3, 'todo/write', { todos: [{ content: '运行测试', status: 'in_progress' }] }),
    ] as HistoryEntry[]

    const result = projectConversation(entries)
    expect(result.messages.map((message) => message.kind)).toEqual(['message', 'message', 'tool'])
    expect(result.messages[1]?.blocks).toEqual([
      { kind: 'reasoning', text: '先定位' },
      { kind: 'text', text: '开始修改。' },
    ])
    expect(result.todos).toEqual([{ content: '运行测试', status: 'in_progress' }])
  })

  it('merges the tool call and its result into one card', () => {
    const entries = [
      entry(0, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }),
      entry(1, 'tool/result', {
        turn: 1, step: 1, error: undefined,
        message: { id: 'r1', role: 'tool', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'done' }] },
      }),
    ] as HistoryEntry[]

    const messages = projectConversation(entries).messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'tool-c1',
      title: 'bash',
      status: 'success',
      detail: '{\n  "command": "ls"\n}',
      result: 'done',
    })
    expect(messages[0]?.workDuration).toBeUndefined()
  })

  it('keeps a standalone result card when the call is absent from the page', () => {
    const entries = [
      entry(0, 'tool/result', {
        turn: 1, step: 1, error: undefined,
        message: { id: 'r1', role: 'tool', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'ok' }] },
      }),
    ] as HistoryEntry[]

    const messages = projectConversation(entries).messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id: 'tool-c1-result', status: 'success', detail: 'ok' })
  })

  it('shows streamed chunks only until their finalized assistant message exists', () => {
    const partial = [
      entry(0, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }),
      entry(1, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '流式' } }),
    ] as HistoryEntry[]
    expect(projectConversation(partial).messages[0]?.blocks).toEqual([{ kind: 'text', text: '流式', streaming: true }])

    const finalized = [...partial, entry(2, 'assistant/message', {
      turn: 1, step: 1,
      message: {
        id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'text', text: '最终' }],
      },
    }, 'append')] as HistoryEntry[]
    expect(projectConversation(finalized).messages).toHaveLength(1)
    expect(projectConversation(finalized).messages[0]?.blocks).toEqual([{ kind: 'text', text: '最终' }])
  })

  it('marks reasoning complete at block-end while the following text still streams', () => {
    const entries = [
      entry(0, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } }),
      entry(1, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '先分析' } }),
      entry(2, 'assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: '先分析' } },
      }),
      entry(3, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'block-start', index: 1, blockType: 'text' } }),
      entry(4, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: '开始回答' } }),
    ] as HistoryEntry[]

    expect(projectConversation(entries).messages[0]?.blocks).toEqual([
      { kind: 'reasoning', text: '先分析', duration: { startedAt: 1, endedAt: 3 } },
      { kind: 'text', text: '开始回答', streaming: true },
    ])
  })

  it('pairs slash-command lifecycle events into one visible result row', () => {
    const entries = [
      entry(4, 'command/run', {
        commandId: 'cmd-1', name: 'permission', args: ' read-only', source: { kind: 'user' },
      }),
      entry(5, 'command/done', {
        commandId: 'cmd-1', kind: 'success', text: 'preset read-only',
      }),
    ] as HistoryEntry[]

    expect(projectConversation(entries).messages).toEqual([expect.objectContaining({
      id: 'command-cmd-1',
      title: '/permission read-only',
      status: 'success',
      detail: 'preset read-only',
    })])
  })

  it('attaches chunk timing to reasoning blocks of the finalized message', () => {
    const entries = [
      entry(0, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } }),
      entry(1, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '先分析' } }),
      entry(2, 'assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: '先分析' } },
      }),
      entry(3, 'assistant/message', {
        turn: 1, step: 1,
        message: {
          id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
          content: [{ type: 'reasoning', text: '先分析' }, { type: 'text', text: '结论' }],
        },
      }, 'append'),
    ] as HistoryEntry[]

    expect(projectConversation(entries).messages[0]?.blocks).toEqual([
      { kind: 'reasoning', text: '先分析', duration: { startedAt: 1, endedAt: 3 } },
      { kind: 'text', text: '结论' },
    ])
  })

  it('attaches streamed usage reasoning tokens to the live reasoning block', () => {
    const entries = [
      entry(0, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } }),
      entry(1, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '先分析' } }),
      entry(2, 'assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: '先分析' } },
      }),
      entry(3, 'assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 42 } },
      }),
    ] as HistoryEntry[]

    expect(projectConversation(entries).messages[0]?.blocks).toEqual([
      { kind: 'reasoning', text: '先分析', duration: { startedAt: 1, endedAt: 3 }, reasoningTokens: 42 },
    ])
  })

  it('prefers the finalized message usage over the streamed usage record', () => {
    const entries = [
      entry(0, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } }),
      entry(1, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '先分析' } }),
      entry(2, 'assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 42 } },
      }),
      entry(3, 'assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: '先分析' } },
      }),
      entry(4, 'assistant/message', {
        turn: 1, step: 1,
        usage: { inputTokens: 120, outputTokens: 60, reasoningTokens: 77 },
        message: {
          id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
          content: [{ type: 'reasoning', text: '先分析' }, { type: 'text', text: '结论' }],
        },
      }, 'append'),
    ] as HistoryEntry[]

    expect(projectConversation(entries).messages[0]?.blocks).toEqual([
      { kind: 'reasoning', text: '先分析', duration: { startedAt: 1, endedAt: 4 }, reasoningTokens: 77 },
      { kind: 'text', text: '结论' },
    ])
  })

  it('shows one cumulative turn duration below the last tool card', () => {
    const entries = [
      timedEntry(0, 1_000, 'turn/start', { turn: 1 }),
      timedEntry(1, 1_200, 'assistant/message', {
        turn: 1, step: 1,
        message: {
          id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
          content: [{ type: 'text', text: '先检查。' }],
        },
      }, 'append'),
      timedEntry(2, 2_000, 'tool/result', {
        turn: 1, step: 1, error: undefined,
        message: { id: 'r1', role: 'tool', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'ok' }] },
      }),
      timedEntry(3, 4_600, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ] as HistoryEntry[]

    const messages = projectConversation(entries).messages
    // The cumulative counter lives on the turn's last visible item (the tool
    // card), not on the assistant message above it.
    expect(messages[0]?.workDuration).toBeUndefined()
    expect(messages[1]?.workDuration).toEqual({ startedAt: 1_000, endedAt: 4_600 })
  })

  it('keeps one cumulative turn counter across a multi-step run', () => {
    const entries = [
      timedEntry(0, 1_000, 'turn/start', { turn: 1 }),
      timedEntry(1, 1_100, 'assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'block-start', index: 0, blockType: 'reasoning' },
      }),
      timedEntry(2, 1_200, 'assistant/chunk', {
        turn: 1, step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: '分析' },
      }),
      timedEntry(3, 2_000, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }),
      timedEntry(4, 2_500, 'tool/result', {
        turn: 1, step: 1, error: undefined,
        message: { id: 'r1', role: 'tool', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'ok' }] },
      }),
      timedEntry(5, 3_000, 'assistant/chunk', {
        turn: 1, step: 2,
        chunk: { type: 'block-start', index: 0, blockType: 'text' },
      }),
      timedEntry(6, 3_100, 'assistant/chunk', {
        turn: 1, step: 2,
        chunk: { type: 'text-delta', index: 0, text: '结论' },
      }),
    ] as HistoryEntry[]

    const messages = projectConversation(entries).messages
    // The running turn counter starts at turn/start (1_000) on the latest
    // visible item; here the turn still ends with the assistant message, so
    // the tool card stays without its own timer.
    expect(messages.find((message) => message.id === 'partial-1:2')?.workDuration)
      .toEqual({ startedAt: 1_000 })
    expect(messages.find((message) => message.id === 'tool-c1')?.workDuration).toBeUndefined()
    expect(messages.filter((message) => message.workDuration !== undefined)).toHaveLength(1)
  })
})

describe('projectionCommands', () => {
  it('merges host command descriptors with the extension commands, sorted by name', () => {
    const commands = projectionCommands([
      { name: 'plan', description: 'Enter or leave plan mode', input: { hint: '[off|message]' } },
      { name: 'compact', description: '压缩当前会话上下文' },
      { name: 'permission', description: '切换权限预设', input: { hint: '<preset>' } },
    ])
    expect(commands.map((command) => command.name)).toEqual([
      'compact', 'permission', 'plan',
      ...EXTENSION_COMMANDS.map((command) => command.name),
    ])
    expect(EXTENSION_COMMANDS.map((command) => command.name)).toEqual(['model', 'reasoning', 'preset', 'mcp'])
    expect(commands[2]).toMatchObject({ name: 'plan', kind: 'host', input: { hint: '[off|message]' } })
    expect(commands[0]?.input).toBeUndefined()
    expect(commands.filter((command) => command.kind === 'extension')).toHaveLength(EXTENSION_COMMANDS.length)
  })

  it('skips malformed entries and still exposes the extension commands', () => {
    const commands = projectionCommands([
      { name: 42, description: 'broken' },
      { name: 'goal', description: '' },
      { name: 'ok', description: '有效命令', input: { hint: '' } },
    ])
    expect(commands.filter((command) => command.kind === 'host').map((command) => command.name)).toEqual(['ok'])
    expect(commands.at(-1)?.kind).toBe('extension')
  })

  it('returns the extension commands only when the host list is empty or absent', () => {
    expect(projectionCommands([])).toEqual(EXTENSION_COMMANDS)
    expect(projectionCommands(undefined)).toEqual(EXTENSION_COMMANDS)
  })
})

describe('projectConversation retry projection', () => {
  it('projects a scheduled normal-mode retry and clears it when the model resumes', () => {
    const streaming = [
      entry(0, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }),
      entry(1, 'llm/retry', {
        retryId: 'r1', turn: 1, step: 1, provider: 'deepseek-official', mode: 'normal',
        policyKey: '["normal",5,...]', retry: 1, maxRetries: 5, delayMs: 2500,
        failure: { code: 'TIMEOUT', message: 'request timed out' },
      }),
      entry(2, 'llm/retry-started', { retryId: 'r1', turn: 1, step: 1, retry: 1 }),
      entry(3, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '恢复了' } }),
    ] as HistoryEntry[]

    expect(projectConversation(streaming).retry).toBeUndefined()

    const retrying = streaming.slice(0, 3)
    expect(projectConversation(retrying).retry).toEqual({
      provider: 'deepseek-official',
      mode: 'normal',
      attempt: 1,
      maxRetries: 5,
      code: 'TIMEOUT',
      message: 'request timed out',
      delayMs: 2500,
      started: true,
    })
  })

  it('carries the attempt counter up while the retry chain keeps failing', () => {
    const entries = [
      entry(0, 'llm/retry', {
        retryId: 'r1', turn: 1, step: 1, provider: 'p', mode: 'normal',
        policyKey: 'k', retry: 1, maxRetries: 5, delayMs: 1000,
        failure: { code: 'TRANSPORT', message: 'connect failed' },
      }),
      entry(1, 'llm/retry', {
        retryId: 'r1', turn: 1, step: 1, provider: 'p', mode: 'normal',
        policyKey: 'k', retry: 2, maxRetries: 5, delayMs: 2000,
        failure: { code: 'TRANSPORT', message: 'connect failed' },
      }),
    ] as HistoryEntry[]

    expect(projectConversation(entries).retry).toMatchObject({ attempt: 2, maxRetries: 5, started: false })
  })

  it('projects always mode without a finite budget and clears on turn/end', () => {
    const retrying = [
      entry(0, 'llm/retry', {
        retryId: 'r2', turn: 2, step: 1, provider: 'relay', mode: 'always',
        policyKey: 'k', retry: 4, delayMs: 1000, failure: { code: 'SERVER', message: 'boom' },
      }),
    ] as HistoryEntry[]
    expect(projectConversation(retrying).retry).toEqual({
      provider: 'relay', mode: 'always', attempt: 4, code: 'SERVER', message: 'boom', delayMs: 1000, started: false,
    })

    const ended = [
      ...retrying,
      entry(1, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ] as HistoryEntry[]
    expect(projectConversation(ended).retry).toBeUndefined()
  })

  it('ignores malformed retry payloads instead of crashing', () => {
    const entries = [
      entry(0, 'llm/retry', { retryId: 'x', turn: 1, step: 1, retry: 0 }),
      entry(1, 'llm/retry-started', undefined),
    ] as HistoryEntry[]
    expect(projectConversation(entries).retry).toEqual({ provider: '', mode: 'normal', attempt: 1, started: true })
  })
})

describe('projectionPermissions', () => {
  it('preserves the Harness value/name transport shape for the Webview adapter', () => {
    expect(projectionPermissions({
      currentValue: 'workspace-write',
      options: [
        { value: 'read-only', name: 'read-only' },
        { value: 'workspace-write', name: 'Workspace', description: 'Workspace writes.' },
        { value: 42, name: 'broken' },
      ],
    })).toEqual({
      currentValue: 'workspace-write',
      options: [
        { value: 'read-only', name: 'read-only' },
        { value: 'workspace-write', name: 'Workspace', description: 'Workspace writes.' },
      ],
    })
  })

  it('rejects malformed projection roots', () => {
    expect(projectionPermissions(undefined)).toBeUndefined()
    expect(projectionPermissions({ currentValue: 1, options: [] })).toBeUndefined()
    expect(projectionPermissions({ currentValue: 'read-only', options: {} })).toBeUndefined()
  })
})

describe('projectionTokenUsage', () => {
  it('accepts complete non-negative integer counters', () => {
    expect(projectionTokenUsage({
      uncachedInputTokens: 120,
      outputTokens: 80,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
    })).toEqual({
      uncachedInputTokens: 120,
      outputTokens: 80,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
    })
  })

  it('rejects missing, negative, fractional and non-finite counters', () => {
    expect(projectionTokenUsage({ uncachedInputTokens: 1 })).toBeUndefined()
    expect(projectionTokenUsage({
      uncachedInputTokens: -1,
      outputTokens: 1,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
    })).toBeUndefined()
    expect(projectionTokenUsage({
      uncachedInputTokens: 1.5,
      outputTokens: 1,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
    })).toBeUndefined()
    expect(projectionTokenUsage({
      uncachedInputTokens: Number.POSITIVE_INFINITY,
      outputTokens: 1,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
    })).toBeUndefined()
  })
})

function entry(seq: number, type: string, data: unknown, surfaceOp?: 'append'): unknown {
  return { event: { seq, time: seq + 1, type, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) } }
}

function timedEntry(seq: number, time: number, type: string, data: unknown, surfaceOp?: 'append'): unknown {
  return { event: { seq, time, type, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) } }
}
