import type { PendingApprovalView, PendingQuestionView } from '../domain/workbench-state.js'
import { projectInteractionRequest, type InteractionView } from './interaction-request.js'
import { isNonEmptyString, type RemoteWaterfallEvent } from './remote-event-protocol.js'

export type PendingInteraction = InteractionView & {
  readonly key: string
  readonly clientId: string
  readonly eventId: string
  readonly sessionId: string
  readonly generation: number
}

/**
 * Connection-owned pending interactions, independent of the visible session.
 * A new `$events` client replays only requests still alive at the host; local
 * records must not survive a disconnect or be merged into that replay.
 */
export class PendingInteractions {
  private revision = 0
  private connection: { readonly generation: number; readonly clientId: string } | undefined
  private readonly pending = new Map<string, PendingInteraction>()
  private readonly replying = new Set<string>()

  beginConnection(clientId: string): number {
    this.disconnect()
    const generation = ++this.revision
    if (isNonEmptyString(clientId)) this.connection = { generation, clientId }
    return generation
  }

  /** An old pump's finally block must never erase the replacement connection. */
  disconnect(generation?: number): boolean {
    if (generation !== undefined && this.connection?.generation !== generation) return false
    const changed = this.pending.size > 0
    this.connection = undefined
    this.pending.clear()
    this.replying.clear()
    return changed
  }

  receive(frame: RemoteWaterfallEvent, generation: number): PendingInteraction | undefined {
    const connection = this.connection
    if (connection?.generation !== generation || !isNonEmptyString(frame.agentId) || !isNonEmptyString(frame.eventId)) return undefined
    // Include the generation so a delayed click cannot answer a replayed event.
    const key = `interaction:${generation}:${frame.eventId}`
    if (this.pending.has(key)) return undefined
    const interaction = projectInteractionRequest(frame, key)
    if (interaction === undefined) return undefined
    const pending: PendingInteraction = {
      ...interaction, key, ...connection, eventId: frame.eventId, sessionId: frame.agentId,
    }
    this.pending.set(key, pending)
    return pending
  }

  forSession(sessionId: string | undefined): { readonly approvals: PendingApprovalView[]; readonly questions: PendingQuestionView[] } {
    const approvals: PendingApprovalView[] = []
    const questions: PendingQuestionView[] = []
    for (const pending of this.pending.values()) {
      if (pending.sessionId !== sessionId) continue
      if (pending.kind === 'approval') approvals.push(pending.view)
      else questions.push(pending.view)
    }
    return { approvals, questions }
  }

  has(key: string): boolean {
    return this.pending.has(key)
  }

  cancel(eventId: string, generation: number): boolean {
    if (this.connection?.generation !== generation) return false
    return this.remove(`interaction:${generation}:${eventId}`)
  }

  removeSession(sessionId: string): void {
    for (const pending of this.pending.values()) {
      if (pending.sessionId === sessionId) this.remove(pending.key)
    }
  }

  /** Only one reply may be in flight, and only for the requested interaction kind. */
  beginResponse(key: string, kind: PendingInteraction['kind']): PendingInteraction | undefined {
    const pending = this.pending.get(key)
    if (pending?.kind !== kind || this.replying.has(key)) return undefined
    this.replying.add(key)
    return pending
  }

  /** Retry a failed RPC only while the very same delivery is still alive. */
  finishResponse(pending: PendingInteraction, succeeded: boolean): void {
    if (this.pending.get(pending.key) !== pending) return
    if (succeeded) this.remove(pending.key)
    else this.replying.delete(pending.key)
  }

  private remove(key: string): boolean {
    this.replying.delete(key)
    return this.pending.delete(key)
  }
}
