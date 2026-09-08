import type { HistoryEntry } from '../gateway/gateway-wire.js'
import type { ChatItem } from './workbench-state.js'

/** Runtime identity prevents a queued prompt or an old partial from owning the status. */
export interface TurnActivityScope {
  readonly turn: number
  readonly ended: boolean
}

/** Recover the latest turn even when its start falls outside the loaded history page. */
export function projectTurnActivityScope(entries: readonly HistoryEntry[]): TurnActivityScope | undefined {
  let latest: TurnActivityScope | undefined
  for (const { event } of entries) {
    switch (event.type) {
      case 'turn/start':
      case 'turn/end':
      case 'assistant/chunk':
      case 'assistant/message':
      case 'tool/call':
      case 'tool/result': {
        const turn = event.data.turn
        if (latest === undefined || turn > latest.turn) latest = { turn, ended: false }
        // Late chunks from the same or an older turn cannot reopen a closed turn.
        if (turn === latest.turn && event.type === 'turn/end') latest = { turn, ended: true }
        break
      }
      default: break
    }
  }
  return latest
}

/**
 * Only currently visible work suppresses the waiting whale. Inspect every tool
 * in the turn: one parallel result must not conceal another still-running call.
 * Older assistant blocks stop owning activity once a later tool/step appears.
 */
export function hasVisibleTurnActivity(messages: readonly ChatItem[], scope?: TurnActivityScope): boolean {
  if (scope?.ended) return false
  const boundary = scope === undefined ? messages.findLastIndex((item) => item.kind === 'message' && item.role === 'user') : -1
  const work = messages.filter((item, index) => {
    if (item.kind !== 'tool' && !(item.kind === 'message' && item.role === 'assistant')) return false
    if (item.workDuration?.endedAt !== undefined) return false
    return scope === undefined ? index > boundary : itemTurn(item) === scope.turn
  })
  if (work.some((item) => item.kind === 'tool' && item.status === 'running')) return true
  const latest = work.at(-1)
  if (latest?.kind !== 'message' || latest.role !== 'assistant') return false
  return latest.blocks?.some((block) => {
    // A reasoning header is already visible at block-start, even before text.
    if (block.kind === 'reasoning') return latest.status === 'running' && block.streaming === true
    // Keep the final answer quiet through block-end/message/turn-end handoff.
    // The UI may still be revealing buffered text after transport deltas stop.
    return block.text.trim() !== ''
  }) ?? false
}

function itemTurn(item: ChatItem): number | undefined {
  const match = item.streamKey?.match(/^(\d+):\d+$/)
  return item.turn ?? (match?.[1] === undefined ? undefined : Number(match[1]))
}
