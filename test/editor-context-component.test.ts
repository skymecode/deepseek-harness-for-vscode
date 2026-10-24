// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditorContextComponent } from '../src/webview/editor-context/component.js'
import { createWebviewTranslator } from '../src/webview/localization.js'

const translate = createWebviewTranslator(undefined)

afterEach(() => {
  document.body.replaceChildren()
})

function fixture() {
  document.body.innerHTML = '<div id="editor-context-list"></div><button id="attach-selection"></button>'
  const onRequestSelection = vi.fn()
  const component = createEditorContextComponent({
    document,
    translate,
    onRequestSelection,
    onOpenFile: vi.fn(),
  })
  return { component, onRequestSelection }
}

function selection(id: string, file: string, startLine: number) {
  return {
    id,
    file,
    label: file.split('/').pop() ?? file,
    language: 'typescript',
    startLine,
    endLine: startLine + 4,
    characterCount: 120,
  }
}

const first = selection('selection-1', 'src/first.ts', 3)
const second = selection('selection-2', 'src/second.ts', 20)

describe('editor context selection staging', () => {
  it('does not auto-stage when auto-attach is off', () => {
    const f = fixture()
    f.component.setAutoAttach(false)
    f.component.updateSelection(first)
    expect(f.component.input().selectionIds).toEqual([])
  })

  it('stages an explicitly attached selection even when auto-attach is off', () => {
    const f = fixture()
    f.component.setAutoAttach(false)
    f.component.attachSelection(first)
    expect(f.component.input().selectionIds).toEqual(['selection-1'])
    expect(document.querySelectorAll('#editor-context-list .selection-context-chip')).toHaveLength(1)
  })

  it('keeps multiple selections from different files', () => {
    const f = fixture()
    f.component.setAutoAttach(false)
    f.component.attachSelection(first)
    f.component.attachSelection(second)
    expect(f.component.input().selectionIds).toEqual(['selection-1', 'selection-2'])
    expect(document.querySelectorAll('#editor-context-list .selection-context-chip')).toHaveLength(2)
  })

  it('lets auto-attach move while explicitly pinned selections stay', () => {
    const f = fixture()
    f.component.setAutoAttach(true)
    f.component.attachSelection(first)
    f.component.updateSelection(second)
    expect(f.component.input().selectionIds).toEqual(['selection-1', 'selection-2'])
    f.component.updateSelection(first)
    expect(f.component.input().selectionIds).toEqual(['selection-1'])
  })

  it('clears explicit selections after submit and allows re-adding them', () => {
    const f = fixture()
    f.component.setAutoAttach(false)
    f.component.attachSelection(first)
    f.component.markSubmitted()
    expect(f.component.input().selectionIds).toEqual([])
    f.component.attachSelection(first)
    expect(f.component.input().selectionIds).toEqual(['selection-1'])
  })

  it('removes one chip without touching the others', () => {
    const f = fixture()
    f.component.setAutoAttach(false)
    f.component.attachSelection(first)
    f.component.attachSelection(second)
    const remove = document.querySelectorAll<HTMLButtonElement>('#editor-context-list .editor-context-remove')
    expect(remove).toHaveLength(2)
    remove[1]!.click()
    expect(f.component.input().selectionIds).toEqual(['selection-1'])
  })
})
