import type { WorkspaceChangesSummary } from '@deepseek-ai/dsh-workspace-changes/types'
import type { SessionChangesView } from '../domain/session-changes.js'

export type ChangesSummary = Omit<WorkspaceChangesSummary, 'cwd' | 'snapshot'>

export function officialChangesView(sessionId: string, seq: number, summary: ChangesSummary): SessionChangesView {
  return {
    official: { sessionId, seq },
    files: summary.files.map(({ deleted, ...file }, index) => ({ ...file, removed: deleted, index })),
    total: summary.total,
    added: summary.added, removed: summary.deleted,
  }
}
