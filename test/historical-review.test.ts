import { describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => ({
  workspace: { registerTextDocumentContentProvider: vi.fn(), textDocuments: [] },
  window: { showInformationMessage: vi.fn() },
  l10n: { t: (message: string) => message },
}))

import { historicalExcerpts } from '../src/ui/workbench/historical-review.js'

describe('historical diff excerpts', () => {
  it('keeps before and after content separate and marks omitted areas', () => {
    const result = historicalExcerpts({
      kind: 'text', path: 'src/a.ts', display: 'src/a.ts', before: true, after: true, coarse: false,
      hunks: [
        { oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [' context', '-before', '+after'] },
        { oldStart: 20, oldLines: 1, newStart: 20, newLines: 1, lines: ['-old', '+new'] },
      ],
    })
    expect(result.before).toBe('@@ 3,2 @@\ncontext\nbefore\n\n[…]\n\n@@ 20,1 @@\nold')
    expect(result.after).toBe('@@ 3,2 @@\ncontext\nafter\n\n[…]\n\n@@ 20,1 @@\nnew')
  })
})
