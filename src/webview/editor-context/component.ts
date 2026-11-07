import type { EditorSelectionView, WorkspaceFileView } from '../../editor/types.js'
import type { MessageArguments, WebviewMessageKey } from '../localization.js'

interface EditorContextComponentOptions {
  readonly document: Document
  readonly translate: (key: WebviewMessageKey, args?: MessageArguments) => string
  readonly onRequestSelection: () => void
  readonly onOpenFile: (reference: { readonly id?: string; readonly path?: string; readonly line?: number }) => void
}

export interface PromptContextInput {
  readonly selectionId?: string
  readonly fileIds: readonly string[]
}

export interface EditorContextComponent {
  readonly updateSelection: (selection: EditorSelectionView | undefined) => void
  readonly setAutoAttach: (enabled: boolean) => void
  readonly addFile: (file: WorkspaceFileView) => void
  readonly input: () => PromptContextInput
  readonly markSubmitted: () => void
  readonly resetForSession: () => void
}

/** Renders removable selection/@file chips and owns their staged state. */
export function createEditorContextComponent(options: EditorContextComponentOptions): EditorContextComponent {
  const root = requiredElement(options.document, 'editor-context-list')
  const attach = requiredButton(options.document, 'attach-selection')
  let availableSelection: EditorSelectionView | undefined
  let stagedSelection: EditorSelectionView | undefined
  let files: WorkspaceFileView[] = []
  let autoAttach = false
  let ignoredSelectionId: string | undefined
  let attachRequested = false

  attach.addEventListener('click', () => {
    if (availableSelection === undefined) {
      attachRequested = true
      options.onRequestSelection()
      return
    }
    stagedSelection = availableSelection
    ignoredSelectionId = undefined
    render()
  })

  const updateSelection = (selection: EditorSelectionView | undefined): void => {
    const changed = selection?.id !== availableSelection?.id
    availableSelection = selection
    if (selection !== undefined && (attachRequested || (changed && autoAttach && selection.id !== ignoredSelectionId))) {
      stagedSelection = selection
    }
    attachRequested = false
    render()
  }

  const setAutoAttach = (enabled: boolean): void => {
    const changed = enabled !== autoAttach
    autoAttach = enabled
    if (changed && enabled && availableSelection !== undefined && availableSelection.id !== ignoredSelectionId) {
      stagedSelection = availableSelection
    }
    render()
  }

  const render = (): void => {
    const fragment = options.document.createDocumentFragment()
    if (stagedSelection !== undefined) fragment.append(selectionChip(stagedSelection))
    for (const file of files) fragment.append(fileChip(file))
    root.replaceChildren(fragment)
    root.classList.toggle('hidden', stagedSelection === undefined && files.length === 0)
    attach.classList.toggle('active', stagedSelection !== undefined)
    attach.setAttribute('aria-pressed', String(stagedSelection !== undefined))
  }

  const selectionChip = (selection: EditorSelectionView): HTMLElement => {
    const chip = chipShell('selection-context-chip')
    const open = options.document.createElement('button')
    open.type = 'button'
    open.className = 'editor-context-open'
    open.disabled = selection.file === undefined
    open.title = options.translate('openSelectedFile')
    open.append(
      text('span', 'editor-context-icon', '⌁'),
      contextCopy(selection.label, options.translate('selectionContextMeta', {
        language: selection.language,
        start: selection.startLine,
        end: selection.endLine,
      })),
    )
    const selectionFile = selection.file
    if (selectionFile !== undefined) {
      open.addEventListener('click', () => options.onOpenFile({ path: selectionFile, line: selection.startLine }))
    }
    chip.append(open, removeButton(options.translate('removeSelectionContext'), () => {
      ignoredSelectionId = selection.id
      stagedSelection = undefined
      render()
    }))
    return chip
  }

  const fileChip = (file: WorkspaceFileView): HTMLElement => {
    const chip = chipShell('file-context-chip')
    const open = options.document.createElement('button')
    open.type = 'button'
    open.className = 'editor-context-open'
    open.title = options.translate('openReferencedFile')
    open.append(text('span', 'editor-context-icon', '@'), contextCopy(file.label, file.path))
    open.addEventListener('click', () => options.onOpenFile({ id: file.id }))
    chip.append(open, removeButton(options.translate('removeFileContext'), () => {
      files = files.filter((item) => item.id !== file.id)
      render()
    }))
    return chip
  }

  const chipShell = (kind: string): HTMLElement => {
    const chip = options.document.createElement('article')
    chip.className = `editor-context-chip ${kind}`
    return chip
  }

  const contextCopy = (label: string, detail: string): HTMLElement => {
    const copy = text('span', 'editor-context-copy')
    copy.append(text('strong', '', label), text('small', '', detail))
    return copy
  }

  const removeButton = (label: string, onRemove: () => void): HTMLButtonElement => {
    const button = options.document.createElement('button')
    button.type = 'button'
    button.className = 'editor-context-remove'
    button.textContent = '×'
    button.title = label
    button.setAttribute('aria-label', label)
    button.addEventListener('click', onRemove)
    return button
  }

  const text = (tag: string, className: string, value = ''): HTMLElement => {
    const element = options.document.createElement(tag)
    element.className = className
    element.textContent = value
    return element
  }

  return {
    updateSelection,
    setAutoAttach,
    addFile: (file) => {
      if (!files.some((item) => item.id === file.id)) files = [...files, file].slice(-8)
      render()
    },
    input: () => ({
      ...(stagedSelection === undefined ? {} : { selectionId: stagedSelection.id }),
      fileIds: files.map((file) => file.id),
    }),
    resetForSession: () => {
      stagedSelection = undefined
      files = []
      autoAttach = false
      ignoredSelectionId = undefined
      attachRequested = false
      render()
    },
    markSubmitted: () => {
      if (!autoAttach) {
        ignoredSelectionId = stagedSelection?.id
        stagedSelection = undefined
      }
      files = []
      render()
    },
  }
}

function requiredElement(document: Document, id: string): HTMLElement {
  const element = document.getElementById(id)
  if (element === null) throw new Error(`Missing #${id}`)
  return element
}

function requiredButton(document: Document, id: string): HTMLButtonElement {
  const element = document.getElementById(id)
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing button #${id}`)
  return element
}
