import type { ActiveSessionView, ChatItem, ConnectionPhase } from './workbench-state.js'
import { hasVisibleTurnActivity } from './turn-activity.js'

type ProcessingSession = Pick<ActiveSessionView, 'running' | 'approvals' | 'questions' | 'retry' | 'turnActivity'>

export type ProcessingStatus =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'working' }
  | { readonly kind: 'retry'; readonly retry: NonNullable<ActiveSessionView['retry']> }

/**
 * The whale bridges silent gaps only. Reasoning, tools and the answer already
 * show progress, so they own their UI without a duplicate running indicator.
 * Interactions, terminal failures and connection state take precedence.
 */
export function projectProcessingStatus(
  active: ProcessingSession | undefined,
  messages: readonly ChatItem[],
  phase: ConnectionPhase | undefined,
  pendingPrompt = false,
): ProcessingStatus {
  if (phase !== 'connected' || active?.approvals.length || active?.questions.length) return { kind: 'hidden' }
  const latest = messages.findLast((item) => item.kind !== 'context' && item.contextNotice === undefined)
  if (latest?.kind === 'notice' && latest.status === 'error') return { kind: 'hidden' }
  if (active?.running && active.turnActivity?.ended !== true) {
    // A retry describes a genuine paused request; stale partial text is not progress.
    if (active.retry !== undefined) return { kind: 'retry', retry: active.retry }
    return { kind: hasVisibleTurnActivity(messages, active.turnActivity) ? 'hidden' : 'working' }
  }
  if (pendingPrompt || hasRunningCommand(messages)) return { kind: 'working' }
  return { kind: 'hidden' }
}

/** Host commands such as /compact do not set the model turn's running flag. */
function hasRunningCommand(messages: readonly ChatItem[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index]!
    // Ignore stale history before the current prompt, especially after restore.
    if (item.kind === 'message' && item.role === 'user') break
    if (item.kind === 'notice' && item.id.startsWith('command-') && item.status === 'running') return true
  }
  return false
}
