import { describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => ({ l10n: { t: (value: string) => value } }))

import { promptContextInput } from '../src/ui/workbench/input-validators.js'

describe('prompt context input', () => {
  it('keeps multiple selection ids and de-duplicates them', () => {
    expect(promptContextInput({
      selectionIds: ['selection-1', 'selection-2', 'selection-1', ''],
      fileIds: ['file-1', 'file-1', 'file-2'],
    })).toEqual({
      selectionIds: ['selection-1', 'selection-2'],
      fileIds: ['file-1', 'file-2'],
    })
  })

  it('accepts the legacy single selectionId alongside selectionIds', () => {
    expect(promptContextInput({ selectionIds: ['selection-2'], selectionId: 'selection-1' })?.selectionIds)
      .toEqual(['selection-2', 'selection-1'])
  })

  it('caps selections at eight and ignores a non-object context', () => {
    const ids = Array.from({ length: 10 }, (_, index) => `selection-${index}`)
    expect(promptContextInput({ selectionIds: ids })?.selectionIds).toHaveLength(8)
    expect(promptContextInput(undefined)).toBeUndefined()
  })
})
