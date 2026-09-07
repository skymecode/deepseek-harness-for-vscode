import type { ChatItem } from './workbench-state.js'

/** A reasoning header is the only timeline anchor; tools remain inside the step. */
export interface ReasoningTimelinePoint {
  readonly key: string
  readonly groupId: string
  readonly messageId: string
  readonly blockIndex: number
  readonly running: boolean
}

/**
 * Build decorations from the transcript, not the session's running flag. DSH's
 * stable `<turn>:<step>` stream key survives partial -> final and history replay.
 * Unknown/legacy identities stay isolated rather than joining unrelated turns.
 */
export function projectReasoningTimeline(messages: readonly ChatItem[], sessionRunning: boolean): readonly ReasoningTimelinePoint[] {
  const tail = messages.findLast((item) => item.kind !== 'context')
  return messages.flatMap((item) => {
    if (item.kind !== 'message' || item.role !== 'assistant') return []
    const turn = item.streamKey?.match(/^(\d+):\d+$/)?.[1]
    const groupId = turn === undefined ? `message:${item.id}` : `turn:${turn}`
    return (item.blocks ?? []).flatMap((block, blockIndex) => block.kind === 'reasoning' ? [{
      key: `${item.streamKey === undefined ? `message:${item.id}` : `step:${item.streamKey}`}#${blockIndex}`,
      groupId,
      messageId: item.id,
      blockIndex,
      // Starting another turn must not reactivate stale historical partials.
      running: sessionRunning && item === tail && item.status === 'running' && block.streaming === true,
    }] : [])
  })
}
