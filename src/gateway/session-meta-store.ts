/**
 * Locally-owned per-session state that the harness never persists for us:
 * reasoning-effort intents, session metadata (pin/tags), and the auto-title
 * marker. Edited-file cards are derived from history, not persisted seq ids.
 * Every mutation is transactional — the
 * candidate map is persisted to the Memento first, then committed to memory —
 * so a failed write can never leave a ghost state the UI echoes as durable.
 */
import * as vscode from 'vscode'
import type { EffortIntent } from '../domain/session-effort.js'
import { readSessionMeta, type SessionMeta } from '../domain/session-meta.js'
import { metaSortRank } from '../domain/session-meta.js'

const EFFORT_INTENT_STATE_KEY = 'deepseekHarness.sessionEffortIntents'
const SESSION_META_STATE_KEY = 'deepseekHarness.sessionMeta'

export class SessionMetaStore {
  /** Per-session reasoning-effort intent ('auto' is an extension-side layer). */
  private readonly effortIntents = new Map<string, EffortIntent>()
  /** Locally-owned session metadata (pin / tags). */
  private readonly metaBySession = new Map<string, SessionMeta>()
  // Sessions whose title was generated from their first user message. A
  // session is only auto-named once; after that the title is the user's to
  // edit, so a later message never overwrites a manual rename.
  private readonly autoTitledSessions = new Set<string>()

  constructor(
    private readonly globalState: vscode.Memento,
    private readonly output: vscode.OutputChannel,
  ) {
    loadEffortIntents(globalState.get(EFFORT_INTENT_STATE_KEY), this.effortIntents)
    loadSessionMeta(globalState.get(SESSION_META_STATE_KEY), this.metaBySession)
    // Legacy sessionTurnChanges is deliberately left on disk for rollback,
    // but never read: a runtime migration may have renumbered its anchors.
  }

  effortIntentFor(sessionId: string): EffortIntent | undefined {
    return this.effortIntents.get(sessionId)
  }

  /**
   * Commits one reasoning-effort intent after the harness accepted it.
   * Persistence failure keeps the previous in-memory intent, so the UI never
   * claims a durable change that was not written.
   */
  async setEffortIntent(sessionId: string, intent: EffortIntent): Promise<void> {
    const candidate = new Map(this.effortIntents)
    candidate.set(sessionId, intent)
    try {
      await this.persistEffortIntents(candidate)
      this.effortIntents.clear()
      for (const [key, value] of candidate) this.effortIntents.set(key, value)
    } catch {
      // persistEffortIntents already logged the failure.
    }
  }

  metaFor(sessionId: string): SessionMeta | undefined {
    return this.metaBySession.get(sessionId)
  }

  /** Pin/tags sort rank, or 0 when the session carries no meta. */
  metaSortRankFor(sessionId: string): number {
    return metaSortRank(this.metaBySession.get(sessionId))
  }

  /**
   * Persists the candidate meta before committing it to memory: a failed write
   * must not leave a ghost state that the UI would echo as if it had worked.
   */
  async updateMeta(sessionId: string, update: (meta: SessionMeta | undefined) => SessionMeta): Promise<void> {
    const next = update(this.metaFor(sessionId))
    const candidate = new Map(this.metaBySession)
    if (readSessionMeta(next) === undefined) candidate.delete(sessionId)
    else candidate.set(sessionId, next)
    await this.persistSessionMeta(candidate)
    this.metaBySession.clear()
    for (const [key, value] of candidate) this.metaBySession.set(key, value)
  }

  /** Drops every trace of one removed session; persistence is best-effort. */
  removeSession(sessionId: string): void {
    if (this.effortIntents.delete(sessionId)) void this.persistEffortIntents().catch(() => undefined)
    if (this.metaBySession.delete(sessionId)) void this.persistSessionMeta().catch(() => undefined)
  }

  /** True once the session has been auto-named; a manual rename marks it too. */
  markAutoTitled(sessionId: string): boolean {
    if (this.autoTitledSessions.has(sessionId)) return false
    this.autoTitledSessions.add(sessionId)
    return true
  }

  isAutoTitled(sessionId: string): boolean {
    return this.autoTitledSessions.has(sessionId)
  }

  clearAutoTitled(sessionId: string): void {
    this.autoTitledSessions.delete(sessionId)
  }

  private async persistEffortIntents(source: ReadonlyMap<string, EffortIntent> = this.effortIntents): Promise<void> {
    try {
      await this.globalState.update(EFFORT_INTENT_STATE_KEY, Object.fromEntries(source))
    } catch (cause) {
      this.output.appendLine(vscode.l10n.t('[gateway] Failed to save the session reasoning intent: {0}', errorMessageFor(cause)))
      throw cause
    }
  }

  private async persistSessionMeta(source: ReadonlyMap<string, SessionMeta> = this.metaBySession): Promise<void> {
    try {
      await this.globalState.update(SESSION_META_STATE_KEY, Object.fromEntries(source))
    } catch (cause) {
      this.output.appendLine(vscode.l10n.t('[gateway] Failed to save the session metadata: {0}', errorMessageFor(cause)))
      throw cause
    }
  }

}

function errorMessageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function isEffortIntent(value: unknown): value is EffortIntent {
  return value === 'auto' || value === 'off' || value === 'low' || value === 'high' || value === 'max'
}

function loadEffortIntents(raw: unknown, target: Map<string, EffortIntent>): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
  for (const [sessionId, value] of Object.entries(raw)) {
    if (isEffortIntent(value)) target.set(sessionId, value)
  }
}

function loadSessionMeta(raw: unknown, target: Map<string, SessionMeta>): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
  for (const [sessionId, value] of Object.entries(raw)) {
    const meta = readSessionMeta(value)
    if (meta !== undefined) target.set(sessionId, meta)
  }
}
