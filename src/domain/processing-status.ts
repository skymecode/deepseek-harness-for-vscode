import type { ActiveSessionView, ChatItem, ConnectionPhase } from './workbench-state.js'

type ProcessingSession = Pick<ActiveSessionView, 'running' | 'approvals' | 'questions' | 'retry'>

/**
 * Fill silent model handoffs, not every busy state. Tool/command cards already
 * have their own progress UI, and approval/retry states require a different
 * action. This projection is independent of DOM, animation and scrolling.
 */
export function shouldShowProcessing(
  active: ProcessingSession | undefined,
  messages: readonly ChatItem[],
  phase: ConnectionPhase | undefined,
  pendingPrompt = false,
): boolean {
  if (phase !== 'connected' || (!active?.running && !pendingPrompt)) return false
  if (active?.approvals.length || active?.questions.length || active?.retry !== undefined) return false

  let latest: ChatItem | undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index]!
    // An optimistic prompt also establishes this boundary, before the host
    // publishes running=true. Never let stale historical tools mask the wait.
    if (item.kind === 'message' && item.role === 'user') break
    if (item.kind === 'context') continue
    // Parallel tools can finish out of order; any still-running tool owns the
    // progress indication until the entire tool batch has completed.
    if ((item.kind === 'tool' || item.kind === 'notice') && item.status === 'running') return false
    latest ??= item
  }
  if (latest?.kind === 'notice' && latest.status === 'error') return false
  if (latest?.kind !== 'message' || latest.role !== 'assistant') return true

  return !latest.blocks?.some((block) => block.text.trim() !== '' && (
    block.kind !== 'reasoning' || block.streaming === true
  ))
}
