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
  const onPinSelection = vi.fn()
  const onUnpinSelection = vi.fn()
  const component = createEditorContextComponent({
    document,
    translate,
    onRequestSelection,
    onPinSelection,
    onUnpinSelection,
    onOpenFile: vi.fn(),
  })
  return { component, onRequestSelection, onPinSelection, onUnpinSelection }
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
const third = selection('selection-3', 'src/third.ts', 40)

describe('editor context selection staging', () => {
  it('does not auto-stage when auto-attach is off', () => {
    const f = fixture()
    f.component.setAutoAttach(false)
    f.component.updateSelection(first)
    expect(f.component.input().selectionIds).toEqual([])
  })

  it('renders the host-owned pinned selections', () => {
    const f = fixture()
    f.component.setPinnedSelections([first, second])
    expect(f.component.input().selectionIds).toEqual(['selection-1', 'selection-2'])
    expect(document.querySelectorAll('#editor-context-list .selection-context-chip')).toHaveLength(2)
  })

  it('asks the host to pin the available selection instead of staging it locally', () => {
    const f = fixture()
    f.component.setAutoAttach(false)
    f.component.updateSelection(first)
    document.getElementById('attach-selection')!.click()
    expect(f.onPinSelection).toHaveBeenCalledExactlyOnceWith('selection-1')
    expect(f.component.input().selectionIds).toEqual([])
    f.component.setPinnedSelections([first])
    expect(f.component.input().selectionIds).toEqual(['selection-1'])
  })

  it('lets auto-attach move while host-owned pins stay', () => {
    const f = fixture()
    f.component.setPinnedSelections([first])
    f.component.setAutoAttach(true)
    f.component.updateSelection(second)
    expect(f.component.input().selectionIds).toEqual(['selection-1', 'selection-2'])
    f.component.updateSelection(first)
    expect(f.component.input().selectionIds).toEqual(['selection-1'])
  })

  it('keeps all eight explicit pins and drops the auto card when full', () => {
    const f = fixture()
    const pins = Array.from({ length: 8 }, (_, index) => selection(`pin-${index}`, `src/pin-${index}.ts`, index + 1))
    f.component.setPinnedSelections(pins)
    f.component.setAutoAttach(true)
    f.component.updateSelection(third)
    expect(f.component.input().selectionIds).toEqual(pins.map((item) => item.id))
    expect(document.querySelectorAll('#editor-context-list .selection-context-chip')).toHaveLength(8)
  })

  it('asks the host to unpin a chip and follows the returned snapshot', () => {
    const f = fixture()
    f.component.setPinnedSelections([first, second])
    const remove = document.querySelectorAll<HTMLButtonElement>('#editor-context-list .editor-context-remove')
    expect(remove).toHaveLength(2)
    remove[1]!.click()
    expect(f.onUnpinSelection).toHaveBeenCalledExactlyOnceWith('selection-2')
    f.component.setPinnedSelections([first])
    expect(f.component.input().selectionIds).toEqual(['selection-1'])
  })

  it('keeps pins after submit until the host clears them', () => {
    const f = fixture()
    f.component.setPinnedSelections([first])
    f.component.setAutoAttach(false)
    f.component.updateSelection(second)
    f.component.markSubmitted()
    expect(f.component.input().selectionIds).toEqual(['selection-1'])
  })

  it('converts the auto card into a host-owned pin when auto-attach is disabled', () => {
    const f = fixture()
    f.component.setAutoAttach(true)
    f.component.updateSelection(first)
    f.component.setAutoAttach(false)
    expect(f.onPinSelection).toHaveBeenCalledExactlyOnceWith('selection-1')
    f.component.setPinnedSelections([first])
    expect(f.component.input().selectionIds).toEqual(['selection-1'])
  })

  it('restores the auto card after the matching pin is consumed', () => {
    const f = fixture()
    f.component.setAutoAttach(true)
    f.component.updateSelection(first)
    f.component.setPinnedSelections([first])
    expect(f.component.input().selectionIds).toEqual(['selection-1'])
    f.component.setPinnedSelections([])
    expect(f.component.input().selectionIds).toEqual(['selection-1'])
    expect(document.querySelectorAll('#editor-context-list .selection-context-chip')).toHaveLength(1)
  })

  it('does not displace an explicit pin when disabling auto-attach with eight pins', () => {
    const f = fixture()
    const pins = Array.from({ length: 8 }, (_, index) => selection(`pin-${index}`, `src/pin-${index}.ts`, index + 1))
    f.component.setPinnedSelections(pins)
    f.component.setAutoAttach(true)
    f.component.updateSelection(third)
    f.component.setAutoAttach(false)
    expect(f.onPinSelection).not.toHaveBeenCalled()
    expect(f.component.input().selectionIds).toEqual(pins.map((item) => item.id))
  })
})
