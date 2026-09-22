/**
 * Module-level helpers shared by the gateway service: wire payload shaping,
 * id minting, history merging, and the label table. All pure — no service
 * state, no client access.
 */
import * as vscode from 'vscode'
import type { HistoryEntry, QueuedInboxItem, SubagentListEntry } from './gateway-wire.js'
import type { PromptContentPart } from './gateway-wire.js'
import type { PromptAttachment } from '../domain/prompt-context.js'
import type {
  PendingQuestionView,
  QueuedPromptView,
  SubagentView,
  WorkbenchLabels,
} from '../domain/workbench-state.js'

/** The event seq of the last assistant message in the transcript, if any. */
export function lastAssistantSeq(entries: readonly HistoryEntry[]): number | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const event = entries[index]?.event
    if (event?.type === 'assistant/message') {
      return typeof event.seq === 'number' ? event.seq : undefined
    }
  }
  return undefined
}

/**
 * The event seq of the last assistant message belonging to one turn.
 * Scoping by turn keeps the recorded conclusion id correct even when another
 * turn has produced later assistant messages (or when streamed history is
 * replayed out of order after a runtime upgrade).
 */
export function lastAssistantSeqForTurn(
  entries: readonly HistoryEntry[],
  turn: number,
): number | undefined {
  let latest: number | undefined
  for (const { event } of entries) {
    if (event?.type !== 'assistant/message') continue
    const data = event.data as { readonly turn?: unknown } | undefined
    if (data?.turn !== turn) continue
    if (typeof event.seq === 'number' && (latest === undefined || event.seq > latest)) latest = event.seq
  }
  return latest
}

export function attachmentPart(attachment: Exclude<PromptAttachment, { kind: 'binary-file' }>): PromptContentPart {
  if (attachment.kind === 'image') {
    return {
      type: 'image',
      mediaType: attachment.mediaType,
      data: attachment.data,
      ...(attachment.name === undefined ? {} : { name: attachment.name }),
    }
  }
  const name = attachment.file === undefined
    ? vscode.l10n.t('Selection')
    : attachment.file
  const ext = name.includes('.') ? name.split('.').pop() ?? '' : ''
  const range = attachment.startLine !== undefined && attachment.endLine !== undefined
    ? vscode.l10n.t(' (lines {start}-{end})', { start: attachment.startLine, end: attachment.endLine })
    : ''
  const truncated = attachment.tooLong === true ? vscode.l10n.t(' (truncated)') : ''
  const label = attachment.kind === 'file' ? vscode.l10n.t('File') : vscode.l10n.t('Selection')
  return {
    type: 'text',
    text: `[${label}: ${name}${range}${truncated}]\n\`\`\`${ext}\n${attachment.text}\n\`\`\``,
  }
}

export function valueOf<T>(response: { readonly result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly message: string } } }): T {
  if (!response.result.ok) throw new Error(response.result.error.message)
  return response.result.value
}

export function stripQuestionTransport(value: PendingQuestionView & { readonly rpcId: unknown }): PendingQuestionView {
  return { key: value.key, questions: value.questions }
}

/** Reduces one pending inbox item to the small, webview-friendly queue view. */
export function queuedPromptView(item: QueuedInboxItem): QueuedPromptView {
  const blocks = item.message.content.map((block) => {
    const record = typeof block === 'object' && block !== null ? block as Record<string, unknown> : undefined
    return { type: typeof record?.type === 'string' ? record.type : '', text: typeof record?.text === 'string' ? record.text : '' }
  })
  const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  return {
    id: String(item.id),
    placement: item.placement === 'next-step' ? 'steering' : 'queued',
    text,
    hasMedia: blocks.some((block) => block.type === 'image'),
  }
}

export function subagentView(entry: SubagentListEntry): SubagentView {
  if (entry.kind === 'diagnostic') return { kind: 'diagnostic', id: String(entry.id), reason: entry.reason }
  return {
    kind: 'child',
    id: String(entry.id),
    activity: entry.activity,
    hasChildren: entry.hasChildren,
    mode: entry.mode,
    ...('label' in entry && entry.label !== undefined ? { label: entry.label } : {}),
  }
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Mints a session id for A2 worktree isolation. The id is created before the
 * session so the worktree can be laid out under it; the create RPC accepts a
 * preallocated id and echoes it back.
 */
export function newSessionId(): string {
  return `dsh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? { ...value } : {}
}

/** Merge a persistence page with live Mux events that arrived during its read. */
export function mergeHistory(base: readonly HistoryEntry[], live: readonly HistoryEntry[]): HistoryEntry[] {
  const bySeq = new Map<number, HistoryEntry>()
  for (const entry of base) bySeq.set(entry.event.seq, entry)
  for (const entry of live) bySeq.set(entry.event.seq, entry)
  return [...bySeq.values()].sort((left, right) => left.event.seq - right.event.seq)
}

/** Joins one message's content blocks into plain text for the mode-switch carry-over digest. */
export function carryEventText(blocks: readonly unknown[]): string {
  const output: string[] = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null || !('type' in block)) continue
    const record = block as Record<string, unknown>
    if ((record.type === 'text' || record.type === 'reasoning') && typeof record.text === 'string') {
      output.push(record.text)
    }
  }
  return output.join('\n').trim()
}

export function localizedWorkbenchLabels(): WorkbenchLabels {
  return {
    commandModel: vscode.l10n.t('Switch the current session model (Flash / Pro)'),
    commandReasoning: vscode.l10n.t('Switch reasoning effort (off / low / high / max)'),
    commandPreset: vscode.l10n.t('Switch Agent Preset (standard / code / minimal / cordis)'),
    newConversation: vscode.l10n.t('New conversation'),
    toolResult: vscode.l10n.t('Tool result'),
    slashCommand: vscode.l10n.t('Slash command'),
    imageAttachment: vscode.l10n.t('[Image attachment]'),
    completed: vscode.l10n.t('Completed'),
    session: vscode.l10n.t('Session'),
    context: vscode.l10n.t('Context'),
    generationStopped: vscode.l10n.t('Generation stopped'),
    outputLimitReached: vscode.l10n.t('Output limit reached'),
    taskBlocked: vscode.l10n.t('Task blocked'),
    turnFailed: vscode.l10n.t('Turn failed'),
  }
}

