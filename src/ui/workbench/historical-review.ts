import * as vscode from 'vscode'
import type { WorkspaceFileDiff } from '@deepseek-ai/dsh-workspace-changes/types'

/** DSH serves hunks, not complete historical files. Mark omissions explicitly. */
export function historicalExcerpts(diff: Extract<WorkspaceFileDiff, { kind: 'text' }>): { before: string; after: string } {
  const side = (before: boolean): string => diff.hunks.map(hunk => {
    const start = before ? hunk.oldStart : hunk.newStart
    const count = before ? hunk.oldLines : hunk.newLines
    return [`@@ ${start},${count} @@`, ...hunk.lines.filter(line => !line.startsWith(before ? '+' : '-')).map(line => line.startsWith('\\') ? line : line.slice(1))].join('\n')
  }).join('\n\n[…]\n\n')
  return { before: side(true), after: side(false) }
}

/** Read-only documents: opening history must never imply editing current files. */
export class HistoricalReview implements vscode.Disposable {
  private readonly contents = new Map<string, string>()
  private nextId = 0
  private readonly provider = vscode.workspace.registerTextDocumentContentProvider('dsh-review', {
    provideTextDocumentContent: uri => this.contents.get(uri.toString()) ?? '',
  })

  async open(diff: WorkspaceFileDiff): Promise<void> {
    if (diff.kind !== 'text') {
      await vscode.window.showInformationMessage(vscode.l10n.t('This historical file cannot be previewed: {0}.', diff.kind))
      return
    }
    const value = historicalExcerpts(diff)
    const id = String(++this.nextId)
    const filename = diff.path.split(/[\\/]/u).pop() || 'change'
    const before = vscode.Uri.from({ scheme: 'dsh-review', authority: id, path: `/before/${filename}` })
    const after = vscode.Uri.from({ scheme: 'dsh-review', authority: id, path: `/after/${filename}` })
    this.contents.set(before.toString(), value.before)
    this.contents.set(after.toString(), value.after)
    await vscode.commands.executeCommand('vscode.diff', before, after, vscode.l10n.t('{0} — historical excerpts (read-only)', diff.display), { preview: true })
    const open = new Set(vscode.workspace.textDocuments.map(doc => doc.uri.toString()))
    for (const key of this.contents.keys()) {
      if (this.contents.size <= 40) break
      if (!open.has(key)) this.contents.delete(key)
    }
  }

  dispose(): void { this.provider.dispose(); this.contents.clear() }
}
