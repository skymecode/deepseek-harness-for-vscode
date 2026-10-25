import type { EditorSelectionView, WorkspaceFileView } from '../../editor/types.js'
import type { MessageArguments, WebviewMessageKey } from '../localization.js'

interface EditorContextComponentOptions {
  readonly document: Document
  readonly translate: (key: WebviewMessageKey, args?: MessageArguments) => string
  readonly onRequestSelection: () => void
  readonly onPinSelection: (selectionId: string) => void
  readonly onUnpinSelection: (selectionId: string) => void
  readonly onOpenFile: (reference: { readonly id?: string; readonly path?: string; readonly line?: number }) => void
}

export interface PromptContextInput {
  readonly selectionIds: readonly string[]
  readonly fileIds: readonly string[]
}

export interface EditorContextComponent {
  readonly updateSelection: (selection: EditorSelectionView | undefined) => void
  readonly setPinnedSelections: (selections: readonly EditorSelectionView[]) => void
  readonly setAutoAttach: (enabled: boolean) => void
  readonly addFile: (file: WorkspaceFileView) => void
  readonly input: () => PromptContextInput
  readonly markSubmitted: () => void
}

/**
 * Renders removable selection/@file chips. Explicit pins are host-owned and
 * arrive through `setPinnedSelections`; this component owns only the one
 * auto-attach card that follows the active selection.
 */
export function createEditorContextComponent(options: EditorContextComponentOptions): EditorContextComponent {
  const root = requiredElement(options.document, 'editor-context-list')
  const attach = requiredButton(options.document, 'attach-selection')
  const MAX_SELECTIONS = 8
  let availableSelection: EditorSelectionView | undefined
  let autoSelection: EditorSelectionView | undefined
  let pinnedSelections: readonly EditorSelectionView[] = []
  let files: WorkspaceFileView[] = []
  let autoAttach = false
  let ignoredSelectionId: string | undefined
  let attachRequested = false

  /** Explicit pins take priority; the moving auto card only fills spare slots. */
  const selectedSelections = (): EditorSelectionView[] => {
    const explicit = pinnedSelections.slice(0, MAX_SELECTIONS)
    if (explicit.length >= MAX_SELECTIONS) return explicit
    const result = [...explicit]
    if (autoSelection !== undefined && !result.some((item) => item.id === autoSelection?.id)) {
      result.push(autoSelection)
    }
    return result
  }

  attach.addEventListener('click', () => {
    if (availableSelection === undefined) {
      attachRequested = true
      options.onRequestSelection()
      return
    }
    options.onPinSelection(availableSelection.id)
  })

  /** Applies the active selection, moving the auto card and satisfying a pending attach request. */
  const updateSelection = (selection: EditorSelectionView | undefined): void => {
    const changed = selection?.id !== availableSelection?.id
    availableSelection = selection
    if (selection !== undefined && !attachRequested && changed && autoAttach && selection.id !== ignoredSelectionId) {
      // Auto-attach follows the active selection (one chip that moves with the
      // cursor); explicit pins stay put beside it.
      autoSelection = selection
    }
    attachRequested = false
    render()
  }

  /** Replaces the host-owned pin list, dropping a duplicate auto card or restoring one after consumption. */
  const setPinnedSelections = (selections: readonly EditorSelectionView[]): void => {
    pinnedSelections = selections.slice(0, MAX_SELECTIONS)
    if (autoSelection !== undefined && pinnedSelections.some((item) => item.id === autoSelection?.id)) {
      autoSelection = undefined
    } else if (autoSelection === undefined && autoAttach && availableSelection !== undefined
      && availableSelection.id !== ignoredSelectionId
      && !pinnedSelections.some((item) => item.id === availableSelection?.id)) {
      // The pin that replaced the automatic card was consumed; show the
      // still-active selection again instead of silently dropping it.
      autoSelection = availableSelection
    }
    render()
  }

  /** Toggles follow-the-selection mode, pinning the current card only when it has a free slot. */
  const setAutoAttach = (enabled: boolean): void => {
    const changed = enabled !== autoAttach
    autoAttach = enabled
    if (changed && !enabled && autoSelection !== undefined) {
      const pinned = pinnedSelections.some((item) => item.id === autoSelection?.id)
      if (pinned) autoSelection = undefined
      else if (pinnedSelections.length < MAX_SELECTIONS) options.onPinSelection(autoSelection.id)
      else autoSelection = undefined
    } else if (changed && enabled && availableSelection !== undefined && availableSelection.id !== ignoredSelectionId) {
      autoSelection = availableSelection
    }
    render()
  }

  /** Paints selection and file chips, including the attach-button state. */
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

  /** Builds one removable selection chip; removal is delegated to the host. */
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
      if (pinnedSelections.some((item) => item.id === selection.id)) options.onUnpinSelection(selection.id)
      if (autoSelection?.id === selection.id) {
        ignoredSelectionId = selection.id
        autoSelection = undefined
      }
      render()
    }))
    return chip
  }

  /** Builds one removable @file chip. */
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

  /** Creates the shared article shell for context chips. */
  const chipShell = (kind: string): HTMLElement => {
    const chip = options.document.createElement('article')
    chip.className = `editor-context-chip ${kind}`
    return chip
  }

  /** Builds the two-line label/detail block used inside chips. */
  const contextCopy = (label: string, detail: string): HTMLElement => {
    const copy = text('span', 'editor-context-copy')
    copy.append(text('strong', '', label), text('small', '', detail))
    return copy
  }

  /** Builds the × control used to remove a chip. */
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

  /** Creates a text element with optional class and content. */
  const text = (tag: string, className: string, value = ''): HTMLElement => {
    const element = options.document.createElement(tag)
    element.className = className
    element.textContent = value
    return element
  }

  return {
    updateSelection,
    setPinnedSelections,
    setAutoAttach,
    /** Adds one @file chip, keeping at most eight. */
    addFile: (file) => {
      if (!files.some((item) => item.id === file.id)) files = [...files, file].slice(-8)
      render()
    },
    /** Returns the selection and file ids to send with the prompt. */
    input: () => ({
      selectionIds: selectedSelections().map((selection) => selection.id),
      fileIds: files.map((file) => file.id),
    }),
    /** Clears transient input after sending; explicit pins are host-owned. */
    markSubmitted: () => {
      // The host clears explicit pins only after the prompt is accepted.
      if (!autoAttach) {
        ignoredSelectionId = autoSelection?.id
        autoSelection = undefined
      }
      files = []
      render()
    },
  }
}

/** Returns a required element by id or fails the component initialization. */
function requiredElement(document: Document, id: string): HTMLElement {
  const element = document.getElementById(id)
  if (element === null) throw new Error(`Missing #${id}`)
  return element
}

/** Returns a required button element by id or fails the component initialization. */
function requiredButton(document: Document, id: string): HTMLButtonElement {
  const element = document.getElementById(id)
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing button #${id}`)
  return element
}
