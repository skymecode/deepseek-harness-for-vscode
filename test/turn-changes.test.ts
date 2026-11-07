import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '../src/gateway/gateway-wire.js'
import { projectTurnChanges } from '../src/domain/turn-changes.js'
import { projectConversation } from '../src/domain/workbench-state.js'
import { completedEditTurn as legacyEditTurn, historyEvent } from './helpers/turn-history.js'

import { officialChangesView } from '../src/gateway/workspace-changes.js'

function completedEditTurn(turn: number, base: number) {
  const entries = legacyEditTurn(turn, base)
  const end = entries.pop()!
  return [...entries, historyEvent(base + 6, 'workspace/changes', { turn }), historyEvent(base + 7, end.event.type, end.event.data)]
}
const project = (entries: readonly HistoryEntry[]) => projectTurnChanges(entries, projectConversation(entries).messages,
  new Map(entries.filter(({ event }) => event.type === 'workspace/changes').map(({ event }) => {
    const turn = (event.data as { turn: number }).turn
    return [event.seq, officialChangesView('s', event.seq, { turn, total: 1, added: 2, deleted: 1,
      files: [{ path: `turn-${turn}.ts`, display: `turn-${turn}.ts`, added: 2, deleted: 1 }],
    })]
  })))

describe('history-derived turn change cards', () => {
  it('restores completed turns whose official snapshots still exist', () => {
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
    expect(migrated[0]?.changes.files).toEqual(old[0]?.changes.files)
    expect(migrated[0]?.changes.official.seq).toBe(26)
  })

  it('uses complete official totals even when the turn start is on an older page', () => {
    const older = completedEditTurn(1, 10)
    const newer = completedEditTurn(2, 30)
    expect(project([...older.slice(5), ...newer]).map((card) => card.turn)).toEqual([1, 2])
    expect(project([...older, ...newer]).map((card) => card.turn)).toEqual([1, 2])
  })

  it('uses the ending notice for an interrupted turn rather than a previous answer', () => {
    const interrupted = [...completedEditTurn(2, 30).filter(({ event }) => event.seq !== 35 && event.type !== 'turn/end'), historyEvent(37, 'turn/end', { turn: 2, reason: { kind: 'interrupted' } })]
    expect(project([...completedEditTurn(1, 10), ...interrupted])[1]?.conclusionId).toBe('turn-2-end')
  })

  it('anchors tool-only completion after the tool, not after an earlier reasoning block', () => {
    const entries = completedEditTurn(1, 10).filter(({ event }) => event.seq !== 15)
    expect(project(entries)[0]?.conclusionId).toBe('tool-edit-1')
  })

  it('does not invent cards for missing snapshots, unfinished turns, or missing visible anchors', () => {
    const entries = completedEditTurn(1, 10)
    expect(project(entries.slice(0, -1))).toEqual([])
    expect(projectTurnChanges(entries, [])).toEqual([])
    expect(projectTurnChanges(entries, projectConversation(entries).messages)).toEqual([])
  })
})
