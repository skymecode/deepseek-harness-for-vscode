import type { HistoryEntry } from '../gateway/gateway-wire.js'
import {
  ENGLISH_WORKBENCH_LABELS,
  projectConversation,
  type WorkbenchLabels,
} from './workbench-state.js'

export type ConversationProjection = ReturnType<typeof projectConversation>

/**
 * Rebuilds only the live assistant-stream suffix and merges it onto a cached
 * durable projection. Streaming frames must not rescan the whole session log.
 */
export function mergeLiveConversationProjection(
  durable: ConversationProjection,
  liveEntries: readonly HistoryEntry[],
  labels: WorkbenchLabels = ENGLISH_WORKBENCH_LABELS,
): ConversationProjection {
  if (liveEntries.length === 0) return durable
  const live = projectConversation(liveEntries, labels)
  if (live.messages.length === 0) {
    return {
      messages: durable.messages,
      todos: durable.todos,
      ...(live.retry === undefined
        ? (durable.retry === undefined ? {} : { retry: durable.retry })
        : { retry: live.retry }),
      ...(durable.turnActivity === undefined ? {} : { turnActivity: durable.turnActivity }),
    }
  }
  const liveKeys = new Set(
    live.messages
      .map((message) => message.streamKey)
      .filter((key): key is string => typeof key === 'string' && key !== ''),
  )
  const base = durable.messages.filter((message) => {
    if (message.status !== 'running' || !message.id.startsWith('partial-')) return true
    return message.streamKey === undefined || !liveKeys.has(message.streamKey)
  })
  const messages = [...base, ...live.messages]
  messages.sort((left, right) => left.seq - right.seq)
  return {
    messages,
    todos: durable.todos,
    ...(live.retry === undefined
      ? (durable.retry === undefined ? {} : { retry: durable.retry })
      : { retry: live.retry }),
    ...(durable.turnActivity === undefined ? {} : { turnActivity: durable.turnActivity }),
  }
}
