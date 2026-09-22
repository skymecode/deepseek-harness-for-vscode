import type { HistoryEntry } from '../gateway/gateway-wire.js'

export interface SessionFileChangeView {
  readonly index?: number
  readonly path: string
  readonly added: number
  readonly removed: number
}

export interface SessionChangesView {
  readonly official?: { readonly sessionId: string; readonly seq: number }
  readonly files: readonly SessionFileChangeView[]
  readonly added: number
  readonly removed: number
}

interface PendingChange {
  readonly path: string
  readonly added: number
  readonly removed: number
}

/**
 * Accumulates per-file line statistics from the edit-tool events of the most
 * recently concluded turn. A call is staged when it is seen and only booked
 * once its result arrives without an error, so failed or unanswered edits
 * never count. `write`/`create` report added lines only: the previous content
 * is unknown. Raw events remain the source of truth; this function is
 * intentionally pure.
 *
 * The summary follows the conversation, not the whole session: only the last
 * concluded turn's edits are shown. While a new round has started but not yet
 * produced a `turn/end`, the previous round's summary stays hidden, so the
 * bar appears when a conclusion lands, disappears when the next round begins,
 * and returns with the next conclusion.
 */
export function projectSessionChanges(entries: readonly HistoryEntry[], official: ReadonlyMap<number, SessionChangesView | undefined> = new Map()): SessionChangesView | undefined {
  let lastTurnEnd: number | undefined
  let maxTurn: number | undefined
  for (const { event } of entries) {
    if (event.type === 'turn/end') lastTurnEnd = event.data.turn
    const turn = eventTurn(event.data)
    if (turn !== undefined && (maxTurn === undefined || turn > maxTurn)) maxTurn = turn
  }
  // No concluded turn yet (blank session, or streaming in progress) → the bar
  // stays hidden until a conclusion actually lands.
  if (lastTurnEnd === undefined) return undefined
  // A newer round has started but has not concluded yet: hide the previous
  // round's summary until this round's own conclusion arrives.
  if (maxTurn !== undefined && maxTurn > lastTurnEnd) return undefined

  const announcement = entries.findLast(({ event }) => event.type === 'workspace/changes' && event.data.turn === lastTurnEnd)?.event
  const recorded = announcement === undefined ? undefined : official.get(announcement.seq)
  if (recorded !== undefined) return recorded.files.length === 0 ? undefined : recorded

  const pending = new Map<string, PendingChange>()
  const byPath = new Map<string, { added: number; removed: number }>()

  for (const { event } of entries) {
    if (eventTurn(event.data) !== lastTurnEnd) continue
    if (event.type === 'tool/call') {
      const change = toolFileChange(event.data.name, event.data.arguments)
      if (change !== undefined) pending.set(String(event.data.callId), change)
    } else if (event.type === 'tool/result') {
      const callId = String(event.data.message.source.callId)
      const change = pending.get(callId)
      pending.delete(callId)
      if (change === undefined || event.data.error !== undefined) continue
      const file = byPath.get(change.path) ?? { added: 0, removed: 0 }
      byPath.set(change.path, { added: file.added + change.added, removed: file.removed + change.removed })
    }
  }

  if (byPath.size === 0) return undefined
  const files = [...byPath.entries()].map(([path, change]) => ({ path, ...change }))
  return {
    files,
    added: files.reduce((total, file) => total + file.added, 0),
    removed: files.reduce((total, file) => total + file.removed, 0),
  }
}

function toolFileChange(name: string, rawArguments: string): PendingChange | undefined {
  let args: unknown
  try {
    args = JSON.parse(rawArguments)
  } catch {
    return undefined
  }
  if (!isRecord(args)) return undefined

  if (name === 'edit') {
    if (typeof args.file_path !== 'string' || typeof args.old_string !== 'string' || typeof args.new_string !== 'string') {
      return undefined
    }
    return { path: args.file_path, added: countLines(args.new_string), removed: countLines(args.old_string) }
  }
  if (name === 'write') {
    if (typeof args.file_path !== 'string' || typeof args.content !== 'string') return undefined
    return { path: args.file_path, added: countLines(args.content), removed: 0 }
  }
  if (name === 'str_replace_editor') {
    if (typeof args.path !== 'string') return undefined
    if (args.command === 'create' && typeof args.file_text === 'string') {
      return { path: args.path, added: countLines(args.file_text), removed: 0 }
    }
    if (args.command === 'str_replace' && typeof args.old_str === 'string' && typeof args.new_str === 'string') {
      return { path: args.path, added: countLines(args.new_str), removed: countLines(args.old_str) }
    }
    if (args.command === 'insert' && typeof args.insert_text === 'string') {
      return { path: args.path, added: countLines(args.insert_text), removed: 0 }
    }
  }
  return undefined
}

/** Splits on `\n`; an empty string counts as zero lines. */
function countLines(text: string): number {
  return text === '' ? 0 : text.split('\n').length
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Reads the owning turn number when the event data carries one (UserMessage does not). */
function eventTurn(data: unknown): number | undefined {
  if (!isRecord(data)) return undefined
  return typeof data.turn === 'number' ? data.turn : undefined
}
