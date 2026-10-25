import { createHash } from 'node:crypto'
import * as path from 'node:path'
import * as vscode from 'vscode'
import type { PromptAttachment } from '../domain/prompt-context.js'
import type { EditorSelectionView } from './types.js'

const MAX_SELECTION_CHARS = 16_000
// Must comfortably exceed the composer's multi-selection cap (8): each cursor
// move publishes a new id, so a pinned selection can otherwise be evicted
// while the user keeps reading before sending.
const MAX_CACHED_SELECTIONS = 64
const SELECTION_DEBOUNCE_MS = 60

interface CachedSelection {
  readonly view: EditorSelectionView
  readonly attachment: PromptAttachment
}

/**
 * Tracks editor selections in the Extension Host.
 *
 * Only metadata and an opaque identifier cross into the Webview. Source text
 * remains here and can only be recovered from a recently issued identifier.
 */
export class EditorSelectionService implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<EditorSelectionView | undefined>()
  private readonly subscriptions: vscode.Disposable[]
  private readonly cached = new Map<string, CachedSelection>()
  /** Explicitly pinned selections never evict while their composer card exists. */
  private readonly retained = new Map<string, CachedSelection>()
  private publishTimer: NodeJS.Timeout | undefined

  readonly onDidChange = this.changeEmitter.event

  constructor() {
    this.subscriptions = [
      vscode.window.onDidChangeActiveTextEditor(() => this.schedulePublish()),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) this.schedulePublish()
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document) this.schedulePublish()
      }),
    ]
  }

  /** Captures the active editor selection and refreshes the auto-attach cache. */
  current(): EditorSelectionView | undefined {
    const captured = captureActiveSelection()
    if (captured === undefined) return undefined
    // A retained selection already has a stable copy; a later cursor move must
    // not make it evictable again.
    if (!this.retained.has(captured.view.id)) {
      this.cached.delete(captured.view.id)
      this.cached.set(captured.view.id, captured)
      while (this.cached.size > MAX_CACHED_SELECTIONS) {
        const oldest = this.cached.keys().next().value as string | undefined
        if (oldest === undefined) break
        this.cached.delete(oldest)
      }
    }
    return captured.view
  }

  /** Resolves an opaque selection token without trusting Webview-supplied text. */
  attachment(id: string | undefined): PromptAttachment | undefined {
    if (id === undefined) return undefined
    return (this.retained.get(id) ?? this.cached.get(id))?.attachment
  }

  /** Returns the display metadata for an id previously published to the Webview. */
  view(id: string): EditorSelectionView | undefined {
    return (this.retained.get(id) ?? this.cached.get(id))?.view
  }

  /** Keeps one explicitly pinned selection resolvable until it is unpinned or sent. */
  retain(id: string): void {
    const entry = this.cached.get(id) ?? this.retained.get(id)
    if (entry === undefined) return
    this.cached.delete(id)
    this.retained.set(id, entry)
  }

  /** Releases one pin, returning it to the auto-attached cache for reuse. */
  release(id: string): void {
    const entry = this.retained.get(id)
    if (entry === undefined) return
    this.retained.delete(id)
    this.cached.set(id, entry)
    while (this.cached.size > MAX_CACHED_SELECTIONS) {
      const oldest = this.cached.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.cached.delete(oldest)
    }
  }


  dispose(): void {
    if (this.publishTimer !== undefined) clearTimeout(this.publishTimer)
    for (const subscription of this.subscriptions) subscription.dispose()
    this.changeEmitter.dispose()
  }

  private schedulePublish(): void {
    if (this.publishTimer !== undefined) clearTimeout(this.publishTimer)
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined
      this.changeEmitter.fire(this.current())
    }, SELECTION_DEBOUNCE_MS)
  }
}

/** Reads the active editor selection into a cached view and prompt attachment. */
function captureActiveSelection(): CachedSelection | undefined {
  const editor = vscode.window.activeTextEditor
  if (editor === undefined || editor.selection.isEmpty) return undefined
  const { document, selection } = editor
  const source = document.getText(selection)
  if (source === '') return undefined

  const tooLong = source.length > MAX_SELECTION_CHARS
  const text = tooLong ? source.slice(0, MAX_SELECTION_CHARS) : source
  const file = displayPath(document.uri)
  const label = file === undefined
    ? document.isUntitled ? vscode.l10n.t('Untitled') : document.fileName.split(/[\\/]/u).pop() ?? vscode.l10n.t('Selection')
    : file.split('/').pop() ?? file
  const startLine = selection.start.line + 1
  const endLine = selection.end.line + 1
  const id = createHash('sha256')
    .update(document.uri.toString())
    .update(String(document.version))
    .update(`${selection.start.line}:${selection.start.character}:${selection.end.line}:${selection.end.character}`)
    .update(text)
    .digest('hex')
    .slice(0, 24)
  const view: EditorSelectionView = {
    id,
    ...(file === undefined ? {} : { file }),
    label,
    language: document.languageId,
    startLine,
    endLine,
    characterCount: source.length,
    ...(tooLong ? { tooLong: true } : {}),
  }
  return {
    view,
    attachment: {
      kind: 'selection',
      ...(file === undefined ? {} : { file }),
      text,
      startLine,
      endLine,
      ...(tooLong ? { tooLong: true } : {}),
    },
  }
}

/** Returns the workspace-relative display path for a file URI. */
function displayPath(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== 'file') return undefined
  const folder = vscode.workspace.getWorkspaceFolder(uri)
  if (folder === undefined) return undefined
  const relative = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/')
  const folders = vscode.workspace.workspaceFolders ?? []
  return folders.length > 1 ? `${folder.name}/${relative}` : relative
}
