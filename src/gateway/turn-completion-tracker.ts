export interface TurnCompletion {
  readonly sessionId: string
  readonly failed: boolean
}

/** Tracks live running -> idle edges, never history snapshots or reconnect replays. */
export class TurnCompletionTracker {
  private readonly turns = new Map<string, { failed: boolean; cancelled: boolean }>()

  status(sessionId: string, running: boolean): TurnCompletion | undefined {
    if (sessionId === '') return undefined
    if (running) {
      // Duplicate starts must not erase a pending failure/cancellation.
      if (!this.turns.has(sessionId)) this.turns.set(sessionId, { failed: false, cancelled: false })
      return undefined
    }
    const turn = this.turns.get(sessionId)
    this.turns.delete(sessionId)
    if (turn === undefined || turn.cancelled) return undefined
    return { sessionId, failed: turn.failed }
  }

  fail(sessionId: string): void {
    const turn = this.turns.get(sessionId)
    if (turn !== undefined) turn.failed = true
  }

  /** Returns a rollback tied to this run, not a later run of the same session. */
  cancel(sessionId: string): () => void {
    const turn = this.turns.get(sessionId)
    if (turn !== undefined) turn.cancelled = true
    return () => { if (turn !== undefined) turn.cancelled = false }
  }

  remove(sessionId: string): void { this.turns.delete(sessionId) }
  clear(): void { this.turns.clear() }
}
