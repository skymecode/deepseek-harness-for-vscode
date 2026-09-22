import { createHash } from 'node:crypto'
import * as path from 'node:path'
import * as vscode from 'vscode'
import type { PromptAttachment } from '../domain/prompt-context.js'
import { matchBareFileName, rankWorkspaceFiles } from './workspace-file-ranker.js'
import type { OpenWorkspaceFileRequest, WorkspaceFileView } from './types.js'

const MAX_INDEXED_FILES = 5_000
const MAX_ATTACHED_FILES = 8
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_FILE_BYTES = 40 * 1024 * 1024
const FILE_INDEX_TTL_MS = 20_000
const FILE_EXCLUDE = '**/{.git,node_modules,.pnpm-store,.yarn,dist,out,build,coverage,.next,.cache}/**'

interface IndexedFile {
  readonly view: WorkspaceFileView
  readonly uri: vscode.Uri
}

/** Workspace-owned file search, attachment reads, and safe editor navigation. */
export class WorkspaceFileService implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[]
  private readonly filesById = new Map<string, IndexedFile>()
  private index: readonly IndexedFile[] = []
  private indexedAt = 0
  private indexing: Promise<readonly IndexedFile[]> | undefined

  constructor() {
    const invalidate = (): void => { this.indexedAt = 0 }
    this.subscriptions = [
      vscode.workspace.onDidCreateFiles(invalidate),
      vscode.workspace.onDidDeleteFiles(invalidate),
      vscode.workspace.onDidRenameFiles(invalidate),
    ]
  }

  async search(query: string): Promise<readonly WorkspaceFileView[]> {
    const files = await this.ensureIndex()
    const ranked = rankWorkspaceFiles(files.map((file) => file.view), query)
    if (query.trim() !== '') return ranked

    // Empty @ menus start with the active/open editors, then fall back to the
    // deterministic workspace ranking. This mirrors the files users are most
    // likely to reference before they type a query.
    const activeId = vscode.window.activeTextEditor === undefined
      ? undefined
      : fileId(vscode.window.activeTextEditor.document.uri)
    const openIds = [
      ...(activeId === undefined ? [] : [activeId]),
      ...vscode.workspace.textDocuments.map((document) => fileId(document.uri)),
    ]
    const recent = [...new Set(openIds)]
      .map((id) => this.filesById.get(id)?.view)
      .filter((file): file is WorkspaceFileView => file !== undefined)
    const recentIds = new Set(recent.map((file) => file.id))
    return [...recent, ...ranked.filter((file) => !recentIds.has(file.id))].slice(0, 20)
  }

  /** Reads only files selected from a host-issued @ suggestion. */
  async attachments(ids: readonly string[]): Promise<readonly PromptAttachment[]> {
    const uniqueIds = [...new Set(ids)].slice(0, MAX_ATTACHED_FILES)
    const attachments: PromptAttachment[] = []
    let remaining = MAX_TOTAL_FILE_BYTES
    for (const id of uniqueIds) {
      const indexed = this.filesById.get(id)
      if (indexed === undefined || vscode.workspace.getWorkspaceFolder(indexed.uri) === undefined) continue
      const size = (await vscode.workspace.fs.stat(indexed.uri)).size
      if (size > Math.min(MAX_FILE_BYTES, remaining)) throw new Error(vscode.l10n.t('The selected files exceed the attachment size limit.'))
      const bytes = await vscode.workspace.fs.readFile(indexed.uri)
      if (bytes.byteLength > Math.min(MAX_FILE_BYTES, remaining)) throw new Error(vscode.l10n.t('The selected files exceed the attachment size limit.'))
      remaining -= bytes.byteLength
      attachments.push({ kind: 'binary-file', file: indexed.view.path, data: Buffer.from(bytes).toString('base64') })
    }
    return attachments
  }

  async open(request: OpenWorkspaceFileRequest, roots?: readonly string[]): Promise<boolean> {
    const indexed = request.id === undefined ? undefined : this.filesById.get(request.id)
    let uri = request.id === undefined
      ? await resolveWorkspaceReference(request.path, roots)
      : indexed !== undefined && vscode.workspace.getWorkspaceFolder(indexed.uri) !== undefined ? indexed.uri : undefined
    // Bare names from model prose (e.g. `manifest.test.ts`) carry no directory
    // segments, so fall back to an exact basename lookup in the file index.
    if (uri === undefined && request.id === undefined && request.path !== undefined) {
      const matches = matchBareFileName((await this.ensureIndex()).map((file) => file.view), request.path.trim())
      const match = matches[0] === undefined ? undefined : this.filesById.get(matches[0].id)
      if (match !== undefined && vscode.workspace.getWorkspaceFolder(match.uri) !== undefined) uri = match.uri
    }
    if (uri === undefined) return false
    if (/\.(?:pdf|docx?|xlsx?|pptx?|png|jpe?g|webp|gif|svg)$/i.test(uri.path)) {
      await vscode.commands.executeCommand('vscode.open', uri)
      return true
    }
    const document = await vscode.workspace.openTextDocument(uri)
    const editor = await vscode.window.showTextDocument(document, { preview: true })
    const requestedLine = Math.max(1, request.line ?? 1)
    const line = Math.min(requestedLine - 1, Math.max(0, document.lineCount - 1))
    const lineLength = document.lineAt(line).text.length
    const requestedColumn = Math.max(1, request.column ?? 1)
    const column = Math.min(requestedColumn - 1, lineLength)
    const position = new vscode.Position(line, column)
    editor.selection = new vscode.Selection(position, position)
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    return true
  }

  /**
   * Whether one render-time reference names a real workspace file. This is the
   * authority behind clickable chat links: only references that resolve to an
   * existing indexed file (path match or exact bare-name match) are reported
   * resolved; everything else stays plain text in the transcript.
   */
  async referenceExists(request: OpenWorkspaceFileRequest, roots?: readonly string[]): Promise<boolean> {
    const reference = request.path?.trim()
    if (reference === undefined || reference === '') return false
    const folders = vscode.workspace.workspaceFolders ?? []
    if (folders.length === 0) return false
    const uri = await resolveWorkspaceReference(reference, roots)
    if (uri !== undefined) return true
    const matches = matchBareFileName((await this.ensureIndex()).map((file) => file.view), reference)
    const match = matches[0] === undefined ? undefined : this.filesById.get(matches[0].id)
    return match !== undefined && vscode.workspace.getWorkspaceFolder(match.uri) !== undefined
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose()
  }

  private async ensureIndex(): Promise<readonly IndexedFile[]> {
    if (Date.now() - this.indexedAt < FILE_INDEX_TTL_MS && this.index.length > 0) return this.index
    if (this.indexing !== undefined) return this.indexing
    this.indexing = this.buildIndex().finally(() => { this.indexing = undefined })
    return this.indexing
  }

  private async buildIndex(): Promise<readonly IndexedFile[]> {
    const uris = await vscode.workspace.findFiles('**/*', FILE_EXCLUDE, MAX_INDEXED_FILES)
    const folders = vscode.workspace.workspaceFolders ?? []
    const indexed = uris.flatMap((uri): IndexedFile[] => {
      const folder = vscode.workspace.getWorkspaceFolder(uri)
      if (folder === undefined) return []
      const relative = relativeUriPath(folder.uri, uri)
      if (relative === undefined || relative === '') return []
      const displayPath = folders.length > 1 ? `${folder.name}/${relative}` : relative
      const id = fileId(uri)
      return [{
        uri,
        view: {
          id,
          path: displayPath,
          label: relative.split('/').pop() ?? relative,
          ...(folders.length > 1 ? { folder: folder.name } : {}),
        },
      }]
    })
    for (const file of indexed) this.filesById.set(file.view.id, file)
    this.index = indexed
    this.indexedAt = Date.now()
    return indexed
  }
}

async function resolveWorkspaceReference(raw: string | undefined, roots?: readonly string[]): Promise<vscode.Uri | undefined> {
  const reference = raw?.trim()
  if (reference === undefined || reference === '' || reference.includes('\0')) return undefined
  const folders = vscode.workspace.workspaceFolders ?? []
  if (folders.length === 0) return undefined

  if (path.isAbsolute(reference)) {
    const candidate = path.resolve(reference)
    const folder = folders.find((item) => item.uri.scheme === 'file' && isWithin(item.uri.fsPath, candidate))
    return folder === undefined ? undefined : existingFile(vscode.Uri.file(candidate))
  }

  const segments = reference.replaceAll('\\', '/').split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.includes('..')) return undefined
  // Isolated sessions resolve relative references against their own worktree
  // first (the copy the agent actually edited), then the workspace folders.
  const rootCandidates = [
    ...(roots ?? []).filter((root) => root !== ''),
    ...folders.filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath),
  ]
  const matchingFolder = rootCandidates.length > 1 && segments[0] !== undefined
    ? rootCandidates.find((root) => path.basename(root) === segments[0])
    : undefined
  const candidates = matchingFolder === undefined
    ? rootCandidates.map((root) => vscode.Uri.file(path.join(root, ...segments)))
    : [vscode.Uri.file(path.join(matchingFolder, ...segments.slice(1)))]
  for (const candidate of candidates) {
    if (await existingFile(candidate) !== undefined) return candidate
  }
  return undefined
}

async function existingFile(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
  try {
    const stat = await vscode.workspace.fs.stat(uri)
    return (stat.type & vscode.FileType.Directory) === 0 ? uri : undefined
  } catch {
    return undefined
  }
}

function relativeUriPath(root: vscode.Uri, target: vscode.Uri): string | undefined {
  if (root.scheme !== target.scheme || root.authority !== target.authority) return undefined
  const prefix = root.path.endsWith('/') ? root.path : `${root.path}/`
  if (!target.path.startsWith(prefix)) return undefined
  return target.path.slice(prefix.length)
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function fileId(uri: vscode.Uri): string {
  return createHash('sha256').update(uri.toString()).digest('hex').slice(0, 24)
}
