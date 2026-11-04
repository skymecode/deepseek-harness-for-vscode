import type { HistoryEntry } from '../gateway/gateway-wire.js'

export interface SessionFileChangeView {
  readonly index: number
  readonly path: string
  readonly display: string
  readonly added: number
  readonly removed: number
  readonly binary?: true
  readonly oversized?: true
}

/** Presentation metadata only. Counts and comparisons belong to DSH. */
export interface SessionChangesView {
  readonly official: { readonly sessionId: string; readonly seq: number }
  readonly files: readonly SessionFileChangeView[]
  readonly total: number
  readonly added: number
  readonly removed: number
}

/**
 * Select the latest official announcement for the last finished turn. An
 * unavailable, pending, or empty summary means no card, matching the native
 * client. Never reconstruct changes from tool arguments or today's checkout.
 */
export function projectSessionChanges(entries: readonly HistoryEntry[], official: ReadonlyMap<number, SessionChangesView | undefined> = new Map()): SessionChangesView | undefined {
  let lastTurnEnd: number | undefined
  let maxTurn: number | undefined
  for (const { event } of entries) {
    if (event.type === 'turn/end') lastTurnEnd = event.data.turn
    const data = event.data
    if ('turn' in data && typeof data.turn === 'number' && (maxTurn === undefined || data.turn > maxTurn)) maxTurn = data.turn
  }
  if (lastTurnEnd === undefined || (maxTurn !== undefined && maxTurn > lastTurnEnd)) return undefined
  const announcement = entries.findLast(({ event }) => event.type === 'workspace/changes' && event.data.turn === lastTurnEnd)?.event
  const recorded = announcement === undefined ? undefined : official.get(announcement.seq)
  return recorded !== undefined && recorded.files.length > 0 ? recorded : undefined
}
