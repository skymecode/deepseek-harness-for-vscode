import type { SessionChangesView } from '../domain/session-changes.js'
import { officialChangesView, type ChangesSummary } from './workspace-changes.js'

interface SessionChanges {
  readonly views: Map<number, SessionChangesView | undefined>
  readonly requested: Set<number>
  readonly failed: Set<number>
  readonly timers: Set<ReturnType<typeof setTimeout>>
}

/** Connection-scoped native summaries. A 404 is final; transport failures retry twice. */
export class WorkspaceChangesCache {
  private readonly sessions = new Map<string, SessionChanges>()

  constructor(private readonly changed: () => void, private readonly failed: (cause: unknown) => void) {}

  get(sessionId: string): ReadonlyMap<number, SessionChangesView | undefined> | undefined {
    return this.sessions.get(sessionId)?.views
  }

  load(sessionId: string, seq: number, fetch: () => Promise<ChangesSummary | undefined>): void {
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = { views: new Map(), requested: new Set(), failed: new Set(), timers: new Set() }
      this.sessions.set(sessionId, state)
    }
    if (state.requested.has(seq)) return
    state.requested.add(seq)
    const current = state
    const request = async (attempt: number): Promise<void> => {
      try {
        const summary = await fetch()
        if (this.sessions.get(sessionId) !== current) return
        current.views.set(seq, summary === undefined ? undefined : officialChangesView(sessionId, seq, summary))
        this.changed()
      } catch (cause) {
        if (this.sessions.get(sessionId) !== current) return
        if (attempt >= 2) { current.failed.add(seq); this.failed(cause); return }
        const timer = setTimeout(() => {
          current.timers.delete(timer)
          void request(attempt + 1)
        }, attempt === 0 ? 500 : 2_000)
        current.timers.add(timer)
      }
    }
    void request(0)
  }

  /** Reopening a conversation retries exhausted transport failures without restarting its Host. */
  retryFailed(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state) return
    for (const seq of state.failed) state.requested.delete(seq)
    state.failed.clear()
  }

  remove(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state) for (const timer of state.timers) clearTimeout(timer)
    this.sessions.delete(sessionId)
  }

  clear(): void {
    for (const sessionId of this.sessions.keys()) this.remove(sessionId)
  }
}
