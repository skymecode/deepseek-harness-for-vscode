import type { HistoryEntry } from '../gateway/gateway-wire.js'
import type { ChatItem } from './workbench-state.js'
import { projectSessionChanges, type SessionChangesView } from './session-changes.js'

/** A finished turn's edits, anchored to its last visible item in this history. */
export interface TurnChangesView {
  readonly seq: number
  readonly turn: number
  readonly conclusionId: string
  readonly changes: SessionChangesView
}

/**
 * Rebuild cards from the same durable history as the transcript. Saved event
 * numbers cannot be reused across Harness log migrations or forks: both the
 * turn coordinates and conclusion ids must come from the current log.
 *
 * A page cut through a turn cannot prove its complete edit totals. Defer that
 * card until its turn/start is loaded, instead of showing a partial total or
 * attaching an old cached card to a newer reply. Never mutate the source log.
 */
export function projectTurnChanges(entries: readonly HistoryEntry[], messages: readonly ChatItem[]): TurnChangesView[] {
  const turns = new Map<number, HistoryEntry[]>()
  for (const entry of entries) {
    const data = entry.event.data
    if (!('turn' in data) || typeof data.turn !== 'number') continue
    const group = turns.get(data.turn)
    if (group === undefined) turns.set(data.turn, [entry])
    else group.push(entry)
  }
  const visible = new Map(messages.map((message) => [message.seq, message.id]))
  const cards: TurnChangesView[] = []
  for (const [turn, group] of turns) {
    if (!group.some(({ event }) => event.type === 'turn/start')) continue
    const end = group.findLast(({ event }) => event.type === 'turn/end')?.event
    if (end === undefined) continue
    const changes = projectSessionChanges(group)
    if (changes === undefined) continue
    // Usually the final answer; for interrupted/tool-only turns this can be
    // the ending notice or final tool card. Never cross the turn boundary.
    const tail = group.findLast(({ event }) => event.seq <= end.seq && visible.has(event.seq))?.event
    const conclusionId = tail === undefined ? undefined : visible.get(tail.seq)
    if (conclusionId !== undefined) cards.push({ seq: end.seq, turn, conclusionId, changes })
  }
  return cards.sort((left, right) => left.seq - right.seq)
}
