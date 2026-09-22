/** Official workspace archive state, with a one-time migration of legacy restores. */
import * as vscode from 'vscode'
import type { SessionSummary } from './gateway-wire.js'
import { RESTORED_ARCHIVE_STATE_KEY, partitionSessionLists, readRestoredArchiveIds } from '../domain/archived-sessions.js'
import { errorMessage } from './gateway-helpers.js'

export interface ArchiveStateOptions {
  readonly globalState: vscode.Memento
  readonly output: vscode.OutputChannel
  /** `workspace.list` RPC returning the official archived-id set. */
  readonly listArchived: () => Promise<string[]>
  /** `workspace.archiveSession` RPC for one session. */
  readonly archiveSession: (sessionId: string, stopActivity?: boolean) => Promise<string[]>
  readonly unarchiveSession: (sessionId: string) => Promise<string[]>
  /** Opens the first suitable visible session after leaving an archived one. */
  readonly openSession: (sessionId: string) => Promise<void>
  /** Falls back to a fresh session when nothing visible remains. */
  readonly createSession: () => Promise<string>
  /** The sessions considered visible (not archived, in-workspace), ordered. */
  readonly visibleSummaries: () => readonly SessionSummary[]
  /** The currently selected session id, if any. */
  readonly activeSessionId: () => string | undefined
  /** Whether a session is effectively archived (set + no restore overlay). */
  readonly isArchived: (sessionId: string) => boolean
  /** Notifies the host that the archive overlay changed. */
  readonly fireChange: () => void
}

export class ArchiveState {
  private archivedIds = new Set<string>()
  private restoredIds: Set<string>
  private revision = 0
  private baselineLoaded = false
  private migration: Promise<void> | undefined

  constructor(private readonly options: ArchiveStateOptions) {
    this.restoredIds = new Set(readRestoredArchiveIds(options.globalState.get(RESTORED_ARCHIVE_STATE_KEY)))
  }

  partition<T extends { readonly id: string }>(sessions: readonly T[]) {
    return partitionSessionLists(sessions, this.archivedIds, this.restoredIds)
  }

  isArchived(sessionId: string): boolean {
    return this.baselineLoaded && this.archivedIds.has(sessionId) && !this.restoredIds.has(sessionId)
  }

  async refresh(): Promise<void> {
    const revision = this.revision
    try {
      const ids = await this.options.listArchived()
      if (revision !== this.revision) return
      this.installFromHost(ids)
      await this.migration
    } catch (cause) {
      this.options.output.appendLine(`[gateway] Archive refresh failed: ${errorMessage(cause)}`)
    }
    this.options.fireChange()
  }

  install(ids: readonly string[]): void {
    this.archivedIds = new Set(ids)
    this.revision += 1
    this.sweepArchivedSelection()
  }

  installFromHost(ids: readonly string[]): void {
    this.baselineLoaded = true
    this.install(ids)
    // Migrate only saved legacy restores. New restores never write an overlay.
    if (this.restoredIds.size > 0 && this.migration === undefined) {
      this.migration = Promise.resolve().then(() => this.migrateRestores()).finally(() => { this.migration = undefined })
    }
  }

  async archive(sessionId: string, sessionExists: (id: string) => boolean, stopActivity = false): Promise<void> {
    if (!sessionExists(sessionId)) return
    await this.migration
    const ids = await this.options.archiveSession(sessionId, stopActivity)
    this.restoredIds.delete(sessionId)
    this.baselineLoaded = true
    this.install(ids)
    await this.persistLegacyRestores()
    this.options.fireChange()
  }

  async restore(sessionId: string): Promise<void> {
    await this.migration
    if (!this.isArchived(sessionId)) return
    const ids = await this.options.unarchiveSession(sessionId)
    this.baselineLoaded = true
    this.install(ids)
    this.options.fireChange()
  }

  markDisconnected(): void {
    this.revision += 1
    this.baselineLoaded = false
  }

  private async migrateRestores(): Promise<void> {
    for (const id of [...this.restoredIds]) {
      if (!this.baselineLoaded) return
      try {
        if (this.archivedIds.has(id)) {
          const ids = await this.options.unarchiveSession(id)
          if (ids.includes(id)) continue
          this.install(ids)
        }
        this.restoredIds.delete(id)
        await this.persistLegacyRestores()
      } catch (cause) {
        // Keep failed ids for the next connection; never discard a user's restore intent.
        this.restoredIds.add(id)
        this.options.output.appendLine(`[gateway] Legacy restore migration failed: ${errorMessage(cause)}`)
      }
    }
    this.options.fireChange()
  }

  private async persistLegacyRestores(): Promise<void> {
    await this.options.globalState.update(RESTORED_ARCHIVE_STATE_KEY, [...this.restoredIds])
  }

  private sweepArchivedSelection(): void {
    // A sweep exists to leave a selection that became archived. With nothing
    // selected or the selection still visible, there is nothing to sweep —
    // creating a fresh session here on an empty/fresh archive set would
    // cascade into an unbounded run of blank sessions.
    const active = this.options.activeSessionId()
    if (active === undefined || !this.options.isArchived(active)) return
    void this.leaveArchivedSelection().catch((cause: unknown) => {
      this.options.output.appendLine(vscode.l10n.t('[gateway] Failed to leave the archived session: {0}', errorMessage(cause)))
    })
  }

  private async leaveArchivedSelection(): Promise<void> {
    const next = this.options.visibleSummaries()[0]
    if (next !== undefined) {
      // openSession resolves sub-agent rows through their parent; selectSession
      // would route a sub-agent through the ordinary session APIs.
      await this.options.openSession(String(next.sessionId))
      return
    }
    await this.options.createSession()
  }

}
