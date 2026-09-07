import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '../src/gateway/gateway-wire.js'
import { projectTurnChanges } from '../src/domain/turn-changes.js'
import { projectConversation } from '../src/domain/workbench-state.js'
import { completedEditTurn, historyEvent } from './helpers/turn-history.js'

const project = (entries: readonly HistoryEntry[]) => projectTurnChanges(entries, projectConversation(entries).messages)

describe('history-derived turn change cards', () => {
  it('restores every completed turn, including turns finished while the extension was closed', () => {
    const cards = project([...completedEditTurn(1, 10), ...completedEditTurn(2, 30)])
    expect(cards.map((card) => [card.turn, card.conclusionId, card.changes.files[0]?.path])).toEqual([
      [1, 'event-15', 'turn-1.ts'], [2, 'event-35', 'turn-2.ts'],
    ])
    expect(cards.map((card) => [card.changes.added, card.changes.removed])).toEqual([[2, 1], [2, 1]])
  })

  it('keeps historical anchors when a new turn starts thinking or calling tools', () => {
    const old = completedEditTurn(1, 10)
    const active = completedEditTurn(2, 30).slice(0, -1)
    expect(project([...old, ...active])).toEqual(project(old))
  })

  it('rebuilds renumbered anchors from the current log instead of persisted event numbers', () => {
    const old = project(completedEditTurn(4, 1_000))
    const migrated = project(completedEditTurn(4, 20))
    expect(old[0]?.conclusionId).toBe('event-1005')
    expect(migrated[0]?.conclusionId).toBe('event-25')
    expect(migrated[0]?.changes).toEqual(old[0]?.changes)
  })

  it('defers a page-edge turn until its complete edit history is loaded', () => {
    const older = completedEditTurn(1, 10)
    const newer = completedEditTurn(2, 30)
    expect(project([...older.slice(2), ...newer]).map((card) => card.turn)).toEqual([2])
    expect(project([...older, ...newer]).map((card) => card.turn)).toEqual([1, 2])
  })

  it('uses the ending notice for an interrupted turn rather than a previous answer', () => {
    const interrupted = [...completedEditTurn(2, 30).slice(0, -2), historyEvent(36, 'turn/end', { turn: 2, reason: { kind: 'interrupted' } })]
    expect(project([...completedEditTurn(1, 10), ...interrupted])[1]?.conclusionId).toBe('turn-2-end')
  })

  it('anchors tool-only completion after the tool, not after an earlier reasoning block', () => {
    const entries = completedEditTurn(1, 10).filter(({ event }) => event.seq !== 15)
    expect(project(entries)[0]?.conclusionId).toBe('tool-edit-1')
  })

  it('does not invent cards for failed edits, unfinished turns, or missing visible anchors', () => {
    const entries = completedEditTurn(1, 10)
    expect(project(entries.slice(0, -1))).toEqual([])
    expect(projectTurnChanges(entries, [])).toEqual([])
    const failed = entries.map((entry) => entry.event.type === 'tool/result'
      ? { event: { ...entry.event, data: { ...entry.event.data, error: { name: 'Error', code: 'DENIED' } } } }
      : entry)
    expect(project(failed)).toEqual([])
  })
})
