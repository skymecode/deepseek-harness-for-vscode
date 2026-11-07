// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { createEditorContextComponent } from '../src/webview/editor-context/component.js'

it('clears automatic selections and file chips when switching to another working directory', () => {
  document.body.innerHTML = '<div id="editor-context-list"></div><button id="attach-selection"></button>'
  const context = createEditorContextComponent({ document, translate: key => key, onRequestSelection: vi.fn(), onOpenFile: vi.fn() })
  context.setAutoAttach(true)
  context.updateSelection({ id: 'main-selection', label: 'a.ts', language: 'typescript', startLine: 1, endLine: 2, characterCount: 10 })
  context.addFile({ id: 'file-a', path: 'src/a.ts', label: 'a.ts' })
  expect(context.input()).toEqual({ selectionId: 'main-selection', fileIds: ['file-a'] })
  context.resetForSession()
  context.setAutoAttach(false)
  expect(context.input()).toEqual({ fileIds: [] })
})
