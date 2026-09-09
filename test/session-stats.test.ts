import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { HistoryEntry } from '../src/gateway/gateway-wire.js'
import { projectSessionStats, projectionSessionStats } from '../src/domain/session-stats.js'

function entry(seq: number, time: number, event: HistoryEntry['event']): HistoryEntry {
  return { seq, time, event } as HistoryEntry
}

function turnStart(turn: number, time: number): HistoryEntry['event'] {
  return { type: 'turn/start', data: { turn }, time } as HistoryEntry['event']
}

function turnEnd(turn: number, time: number): HistoryEntry['event'] {
  return { type: 'turn/end', data: { turn, reason: { kind: 'completed' } }, time } as HistoryEntry['event']
}

describe('projectSessionStats', () => {
  it('reports zero turns and duration for an empty session', () => {
    expect(projectSessionStats([], 5_000)).toEqual({ turns: 0, durationMs: 0, windowScoped: true })
  })

  it('aggregates completed turns into a cumulative duration', () => {
    const entries = [
      entry(1, 1_000, turnStart(10, 1_000)),
      entry(2, 4_000, turnEnd(10, 4_000)),
      entry(3, 5_000, turnStart(11, 5_000)),
      entry(4, 8_000, turnEnd(11, 8_000)),
    ]
    expect(projectSessionStats(entries, 8_000)).toEqual({ turns: 2, durationMs: 6_000, windowScoped: true })
  })

  it('counts a running turn as elapsed up to the reference time', () => {
    const entries = [
      entry(1, 1_000, turnStart(20, 1_000)),
    ]
    expect(projectSessionStats(entries, 6_000)).toEqual({ turns: 1, durationMs: 5_000, windowScoped: true })
  })

  it('ignores non-turn events and is stable for completed-only histories', () => {
    const unrelated: HistoryEntry['event'] = { type: 'user/message', seq: SessionSeq(2), surfaceOp: 'append', data: { id: MessageId('user-test'), role: 'user', source: { kind: 'user' }, content: [] }, time: 2_000 }
    const entries = [
      entry(1, 1_000, turnStart(30, 1_000)),
      entry(2, 2_000, unrelated),
      entry(3, 7_000, turnEnd(30, 7_000)),
    ]
    expect(projectSessionStats(entries, 100_000)).toEqual({ turns: 1, durationMs: 6_000, windowScoped: true })
  })
})

describe('projectionSessionStats', () => {
  it('accepts the whole-log harness projection and sums model + tool time', () => {
    expect(projectionSessionStats({
      turns: 7,
      steps: 9,
      llmMs: 12_000,
      toolMs: 3_500,
      ttftMs: 800,
      ttftSteps: 3,
      decodeMs: 2_000,
      decodeTokens: 1_500,
    })).toEqual({ turns: 7, durationMs: 15_500 })
  })

  it('rejects invalid or missing projection values', () => {
    expect(projectionSessionStats(undefined)).toBeUndefined()
    expect(projectionSessionStats({ turns: -1, llmMs: 1, toolMs: 1 })).toBeUndefined()
    expect(projectionSessionStats({ turns: 1, llmMs: 'x', toolMs: 1 })).toBeUndefined()
    expect(projectionSessionStats({ turns: 1, llmMs: 1 })).toBeUndefined()
  })
})
