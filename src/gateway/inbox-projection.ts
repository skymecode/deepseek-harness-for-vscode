import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { InboxTarget, InboxWireState } from '@deepseek-ai/dsh-agent/types'

/** Display adapter only; the durable Inbox projection is the source of truth. */
export interface QueuedInboxItem {
  readonly id: MessageId
  readonly placement: InboxTarget
  readonly message: { readonly content: readonly unknown[] }
}

export function inboxQueue(value: unknown): readonly QueuedInboxItem[] {
  if (typeof value !== 'object' || value === null) return []
  const inbox = value as Partial<InboxWireState>
  const result: QueuedInboxItem[] = []
  for (const placement of ['next-step', 'next-turn'] as const) {
    const messages = inbox[placement]
    if (!Array.isArray(messages)) continue
    for (const message of messages) {
      if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
      if (typeof message.id !== 'string' || !Array.isArray(message.content)) continue
      result.push({ id: message.id as MessageId, placement, message: { content: message.content } })
    }
  }
  return result
}
