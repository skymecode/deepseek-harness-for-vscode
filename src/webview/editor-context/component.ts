import type { EditorSelectionView, WorkspaceFileView } from '../../editor/types.js'
import type { MessageArguments, WebviewMessageKey } from '../localization.js'

interface EditorContextComponentOptions {
  readonly document: Document
  readonly translate: (key: WebviewMessageKey, args?: MessageArguments) => string
  readonly onRequestSelection: () => void
  readonly onOpenFile: (reference: { readonly id?: string; readonly path?: string; readonly line?: number }) => void
}

export interface PromptContextInput {
  readonly selectionIds: readonly string[]
  readonly fileIds: readonly string[]
}

export interface EditorContextComponent {
  readonly updateSelection: (selection: EditorSelectionView | undefined) => void
  readonly attachSelection: (selection: EditorSelectionView) => void
  readonly setAutoAttach: (enabled: boolean) => void
  readonly addFile: (file: WorkspaceFileView) => void
  readonly input: () => PromptContextInput
  readonly markSubmitted: () => void
}

/** Renders removable selection/@file chips and owns their staged state. */
export function createEditorContextComponent(options: EditorContextComponentOptions): EditorContextComponent {
  const root = requiredElement(options.document, 'editor-context-list')
  const attach = requiredButton(options.document, 'attach-selection')
  const MAX_SELECTIONS = 8
  let availableSelection: EditorSelectionView | undefined
  let autoSelection: EditorSelectionView | undefined
  let explicitSelections: EditorSelectionView[] = []
  let files: WorkspaceFileView[] = []
  let autoAttach = false
  let ignoredSelectionId: string | undefined
  let attachRequested = false

  const selectedSelections = (): EditorSelectionView[] => {
    const result: EditorSelectionView[] = []
    for (const selection of [...explicitSelections, ...(autoSelection === undefined ? [] : [autoSelection])]) {
      if (!result.some((item) => item.id === selection.id)) result.push(selection)
    }
    // Keep the newest explicit pins; the moving auto selection is appended
    // last so it survives when the explicit list is already full.
    return result.slice(-MAX_SELECTIONS)
  }

  const addExplicitSelection = (selection: EditorSelectionView): void => {
    explicitSelections = [...explicitSelections.filter((item) => item.id !== selection.id), selection].slice(-MAX_SELECTIONS)
    if (autoSelection?.id === selection.id) autoSelection = undefined
    ignoredSelectionId = undefined
  }

  attach.addEventListener('click', () => {
    if (availableSelection === undefined) {
      attachRequested = true
      options.onRequestSelection()
      return
    }
    addExplicitSelection(availableSelection)
    render()
  })

  const updateSelection = (selection: EditorSelectionView | undefined): void => {
    const changed = selection?.id !== availableSelection?.id
    availableSelection = selection
    if (selection !== undefined && attachRequested) {
      addExplicitSelection(selection)
    } else if (selection !== undefined && changed && autoAttach && selection.id !== ignoredSelectionId) {
      // Auto-attach follows the active selection (one chip that moves with the
      // cursor); explicit right-click adds stay pinned alongside it.
      autoSelection = selection
    }
    attachRequested = false
    render()
  }

  const attachSelection = (selection: EditorSelectionView): void => {
    availableSelection = selection
    addExplicitSelection(selection)
    attachRequested = false
    render()
  }

  const setAutoAttach = (enabled: boolean): void => {
    const changed = enabled !== autoAttach
    autoAttach = enabled
    if (changed && !enabled && autoSelection !== undefined) {
      // Turning auto-attach off keeps the current chip as an explicit one.
      addExplicitSelection(autoSelection)
      autoSelection = undefined
    } else if (changed && enabled && availableSelection !== undefined && availableSelection.id !== ignoredSelectionId) {
      autoSelection = availableSelection
    }
    render()
  }

  const render = (): void => {
    const fragment = options.document.createDocumentFragment()
    const selections = selectedSelections()
    for (const selection of selections) fragment.append(selectionChip(selection))
    for (const file of files) fragment.append(fileChip(file))
    root.replaceChildren(fragment)
    root.classList.toggle('hidden', selections.length === 0 && files.length === 0)
    attach.classList.toggle('active', selections.length > 0)
    attach.setAttribute('aria-pressed', String(selections.length > 0))
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
      explicitSelections = explicitSelections.filter((item) => item.id !== selection.id)
      if (autoSelection?.id === selection.id) {
        ignoredSelectionId = selection.id
        autoSelection = undefined
      }
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
    attachSelection,
    setAutoAttach,
    addFile: (file) => {
      if (!files.some((item) => item.id === file.id)) files = [...files, file].slice(-8)
      render()
    },
    input: () => ({
      selectionIds: selectedSelections().map((selection) => selection.id),
      fileIds: files.map((file) => file.id),
    }),
    markSubmitted: () => {
      explicitSelections = []
      if (!autoAttach) {
        ignoredSelectionId = autoSelection?.id
        autoSelection = undefined
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
