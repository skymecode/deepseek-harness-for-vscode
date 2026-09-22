import type { WorkspaceChangesSummary, WorkspaceFileDiff } from '@deepseek-ai/dsh-workspace-changes/types'
import type { SessionChangesView } from '../domain/session-changes.js'

export type ChangesSummary = Omit<WorkspaceChangesSummary, 'cwd' | 'snapshot'>

export function officialChangesView(sessionId: string, seq: number, summary: ChangesSummary): SessionChangesView {
  return {
    official: { sessionId, seq },
    files: summary.files.map((file, index) => ({ path: file.path, added: file.added, removed: file.deleted, index })),
    added: summary.added, removed: summary.deleted,
  }
}

/** Preserve the official hunks, including binary/oversize outcomes; never read current files. */
export function formatWorkspaceDiff(diff: WorkspaceFileDiff): string {
  if (diff.kind !== 'text') return `${diff.display}: ${diff.kind}\n`
  return [
    `--- ${diff.before ? diff.path : '/dev/null'}`,
    `+++ ${diff.after ? diff.path : '/dev/null'}`,
    ...diff.hunks.flatMap((hunk) => [
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines,
    ]), '',
  ].join('\n')
}
