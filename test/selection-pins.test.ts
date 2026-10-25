import { describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => ({
  EventEmitter: class {
    readonly event = () => ({ dispose: () => undefined })
    fire(): void {}
    dispose(): void {}
  },
  Uri: { joinPath: () => ({}) },
  commands: { executeCommand: async () => undefined },
  l10n: { t: (value: string) => value },
  window: {},
  workspace: {
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    onDidChangeWorkspaceFolders: () => ({ dispose: () => undefined }),
    registerTextDocumentContentProvider: () => ({ dispose: () => undefined }),
  },
}))

import { WorkbenchViewProvider } from '../src/ui/workbench-view-provider.js'
import type { EditorSelectionView } from '../src/editor/types.js'

function selection(id: string): EditorSelectionView {
  return {
    id,
    file: `${id}.ts`,
    label: `${id}.ts`,
    language: 'typescript',
    startLine: 1,
    endLine: 2,
    characterCount: 10,
  }
}

function fixture() {
  const viewPost = vi.fn()
  const panelPost = vi.fn()
  const editorSelection = {
    retain: vi.fn(),
    release: vi.fn(),
    onDidChange: () => ({ dispose: () => undefined }),
  }
  const gateway = { onDidChange: () => ({ dispose: () => undefined }), start: vi.fn() }
  const configuration = {
    get: () => ({ mcpServers: [] }),
    onDidChange: () => ({ dispose: () => undefined }),
  }
  const provider = new WorkbenchViewProvider(
    {} as never,
    configuration as never,
    gateway as never,
    { onDidChange: () => ({ dispose: () => undefined }) } as never,
    { onDidChange: () => ({ dispose: () => undefined }) } as never,
    editorSelection as never,
    {} as never,
    {} as never,
  )
  ;(provider as unknown as { view: unknown }).view = { webview: { postMessage: viewPost } }
  ;(provider as unknown as { panel: unknown }).panel = { webview: { postMessage: panelPost } }
  return { provider, editorSelection, viewPost, panelPost }
}

describe('host-owned selection pins', () => {
  it('queues a pin until a host is ready, then hydrates it', () => {
    const f = fixture()
    f.provider.pinSelection(selection('a'))
    expect(f.viewPost).not.toHaveBeenCalled()
    expect(f.panelPost).not.toHaveBeenCalled()

    ;(f.provider as unknown as { viewReady: boolean }).viewReady = true
    ;(f.provider as unknown as { postPinnedSelections: (target?: string) => void }).postPinnedSelections('view')
    expect(f.viewPost).toHaveBeenCalledWith({ type: 'pinnedSelections', selections: [selection('a')] })
  })

  it('broadcasts a pin to every ready host and hydrates a later panel', () => {
    const f = fixture()
    ;(f.provider as unknown as { viewReady: boolean }).viewReady = true
    f.provider.pinSelection(selection('a'))
    expect(f.viewPost).toHaveBeenLastCalledWith({ type: 'pinnedSelections', selections: [selection('a')] })
    expect(f.panelPost).not.toHaveBeenCalled()

    ;(f.provider as unknown as { panelReady: boolean }).panelReady = true
    ;(f.provider as unknown as { postPinnedSelections: (target?: string) => void }).postPinnedSelections('panel')
    expect(f.panelPost).toHaveBeenCalledWith({ type: 'pinnedSelections', selections: [selection('a')] })
  })

  it('broadcasts unpin and clear to every ready host', () => {
    const f = fixture()
    ;(f.provider as unknown as { viewReady: boolean }).viewReady = true
    ;(f.provider as unknown as { panelReady: boolean }).panelReady = true
    f.provider.pinSelection(selection('a'))
    f.provider.pinSelection(selection('b'))
    f.provider.unpinSelection('a')
    expect(f.viewPost).toHaveBeenLastCalledWith({ type: 'pinnedSelections', selections: [selection('b')] })
    expect(f.panelPost).toHaveBeenLastCalledWith({ type: 'pinnedSelections', selections: [selection('b')] })

    f.provider.clearPinnedSelections()
    expect(f.editorSelection.release.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])
    expect(f.viewPost).toHaveBeenLastCalledWith({ type: 'pinnedSelections', selections: [] })
    expect(f.panelPost).toHaveBeenLastCalledWith({ type: 'pinnedSelections', selections: [] })
  })

  it('clears only the pin generations consumed by one prompt', () => {
    const f = fixture()
    ;(f.provider as unknown as { viewReady: boolean }).viewReady = true
    f.provider.pinSelection(selection('a'))
    f.provider.pinSelection(selection('b'))
    const consumed = f.provider.snapshotPins(['a'])
    f.provider.clearPinnedSelections(consumed)
    expect(f.viewPost).toHaveBeenLastCalledWith({ type: 'pinnedSelections', selections: [selection('b')] })
    expect(f.editorSelection.release).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('does not clear a pin repinned while the prompt is pending', () => {
    const f = fixture()
    ;(f.provider as unknown as { viewReady: boolean }).viewReady = true
    f.provider.pinSelection(selection('a'))
    const consumed = f.provider.snapshotPins(['a'])
    f.provider.pinSelection(selection('a'))
    f.provider.clearPinnedSelections(consumed)
    expect(f.viewPost).toHaveBeenLastCalledWith({ type: 'pinnedSelections', selections: [selection('a')] })
    expect(f.editorSelection.release).not.toHaveBeenCalled()
  })

  it('retains new pins and releases the oldest when the ninth arrives', () => {
    const f = fixture()
    for (let index = 0; index < 9; index++) f.provider.pinSelection(selection(`pin-${index}`))
    expect(f.editorSelection.retain).toHaveBeenCalledTimes(9)
    expect(f.editorSelection.release).toHaveBeenCalledExactlyOnceWith('pin-0')
  })
})
