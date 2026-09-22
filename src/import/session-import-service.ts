import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'
import type { HarnessGatewayService } from '../gateway/harness-gateway-service.js'
import { NodeGatewayClient } from '../gateway/node-gateway-client.js'
import type { DshPluginManager } from '../plugins/plugin-manager.js'
import {
  MAX_ARCHIVE_BYTES,
  chatgptConversationsPath,
  dshSessionJsonlPaths,
  extractSessionArchive,
  inspectSessionArchive,
} from './session-archive.js'
import type { ImportDiscoverResult, ImportDiscoveryItem, ImportRequestItem, ImportResultItem } from './types.js'

const CHAT_IMPORT_PACKAGE = 'dsh-chat-import'

/** Maps dsh-chat-import discovery format ids to the panel API `source` field. */
const FORMAT_TO_SOURCE: Readonly<Record<string, string>> = {
  claude: 'claude-code',
  codex: 'codex',
  chatgpt: 'chatgpt',
  cursor: 'cursor',
  gemini: 'gemini',
  reasonix: 'reasonix',
  opencode: 'opencode',
  mimocode: 'mimocode',
  zcode: 'zcode',
  grokbuild: 'grokbuild',
  openclaw: 'openclaw',
  pi: 'pi',
  hermes: 'hermes',
  kimi: 'kimi',
  qoder: 'qoder',
  dsh: 'dsh',
}

/** Native import UX that reuses dsh-chat-import and adds official DSH ZIP support. */
export class SessionImportService {
  constructor(
    private readonly pluginManager: DshPluginManager,
    private readonly gateway: HarnessGatewayService,
  ) {}

  async runInteractive(): Promise<void> {
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: vscode.l10n.t('Import from file…'),
          description: vscode.l10n.t('DSH session ZIP, ChatGPT export ZIP, JSONL, or conversations.json'),
          id: 'file',
        },
        {
          label: vscode.l10n.t('Import from folder…'),
          description: vscode.l10n.t('Scan a directory of agent transcripts'),
          id: 'folder',
        },
        {
          label: vscode.l10n.t('Discover local agent sessions…'),
          description: vscode.l10n.t('Claude Code, Codex, Cursor, and other default data roots'),
          id: 'discover',
        },
      ],
      { title: vscode.l10n.t('Import sessions'), ignoreFocusOut: true },
    )
    if (choice === undefined) return
    if (choice.id === 'discover') await this.importDiscovered()
    else await this.importPicked(choice.id === 'folder')
  }

  private async importPicked(folders: boolean): Promise<void> {
    const targets = await vscode.window.showOpenDialog({
      title: folders
        ? vscode.l10n.t('Select a folder of session logs')
        : vscode.l10n.t('Select session logs to import'),
      canSelectFiles: !folders,
      canSelectFolders: folders,
      canSelectMany: true,
      ...(folders ? {} : {
        filters: {
          'Session archives': ['zip', 'jsonl', 'json'],
          'ZIP archive': ['zip'],
          'JSONL transcript': ['jsonl'],
          'JSON': ['json'],
        },
      }),
    })
    if (targets === undefined || targets.length === 0) return
    const leftovers: string[] = []
    try {
      await this.runImport(async (client) => {
        const items: ImportRequestItem[] = []
        for (const target of targets) {
          items.push(...await this.itemsFromUri(client, target, leftovers))
        }
        return await this.importItems(client, items, true)
      })
    } finally {
      await Promise.all(leftovers.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)))
    }
  }

  private async importDiscovered(): Promise<void> {
    if (!await this.prepareImport()) return
    const client = this.requireClient()
    let discovered: ImportDiscoverResult
    try {
      discovered = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t('Looking for local agent sessions…'),
        },
        async () => client.discoverImportSessions({}),
      )
    } catch (cause) {
      throw userFacingImportError(cause)
    }
    const importable = discovered.sessions.filter((session) => discoveryToRequest(session).source !== '')
    if (importable.length === 0) {
      throw new Error(vscode.l10n.t('No local agent sessions were found.'))
    }
    const selected = await vscode.window.showQuickPick(
      importable.map((session) => ({
        label: session.title?.trim() || session.sessionId,
        description: formatSourceLabel(session),
        detail: session.sourcePath,
        session,
      })),
      {
        title: vscode.l10n.t('Select sessions to import'),
        canPickMany: true,
        ignoreFocusOut: true,
        matchOnDescription: true,
        matchOnDetail: true,
      },
    )
    if (selected === undefined || selected.length === 0) return
    await this.runImport(async () => (
      this.importItems(this.requireClient(), selected.map((item) => discoveryToRequest(item.session)), false)
    ))
  }

  private async prepareImport(): Promise<boolean> {
    if (!await this.ensureChatImportPlugin()) return false
    await this.gateway.ensureStarted()
    return true
  }

  private async runImport(
    work: (client: NodeGatewayClient) => Promise<readonly ImportResultItem[] | undefined>,
  ): Promise<void> {
    if (!await this.prepareImport()) return
    let results: readonly ImportResultItem[] | undefined
    try {
      results = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t('Importing sessions…'),
        },
        async () => work(this.requireClient()),
      )
    } catch (cause) {
      throw userFacingImportError(cause)
    }
    if (results === undefined) return
    await this.gateway.reloadSessions(firstImportedSessionId(results))
    void vscode.window.showInformationMessage(summarizeImport(results))
  }

  private async itemsFromUri(
    client: NodeGatewayClient,
    target: vscode.Uri,
    leftovers: string[],
  ): Promise<readonly ImportRequestItem[]> {
    const stat = await vscode.workspace.fs.stat(target)
    if (stat.type === vscode.FileType.Directory) {
      return await this.discoverPath(client, target.fsPath)
    }
    if (target.fsPath.toLowerCase().endsWith('.zip')) {
      if (stat.size > MAX_ARCHIVE_BYTES) {
        throw new Error(vscode.l10n.t('This ZIP is too large to import ({0} bytes).', String(stat.size)))
      }
      return await this.itemsFromZip(target, leftovers)
    }
    return await this.discoverPath(client, target.fsPath)
  }

  private async itemsFromZip(target: vscode.Uri, leftovers: string[]): Promise<readonly ImportRequestItem[]> {
    const bytes = await vscode.workspace.fs.readFile(target)
    const archive = inspectSessionArchive(bytes)
    if (archive.kind === 'unknown') {
      throw new Error(vscode.l10n.t('This ZIP is not a DeepSeek Harness session export or a ChatGPT conversations archive.'))
    }
    const wanted = archive.kind === 'dsh-export'
      ? new Set(dshSessionJsonlPaths(archive.entries))
      : new Set(([chatgptConversationsPath(archive.entries)].filter((name): name is string => name !== undefined)))
    if (wanted.size === 0) {
      throw new Error(vscode.l10n.t('This ZIP is not a DeepSeek Harness session export or a ChatGPT conversations archive.'))
    }
    const extracted = extractSessionArchive(bytes, (name) => wanted.has(name))
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-import-'))
    leftovers.push(root)
    await writeExtractedFiles(root, extracted)
    if (archive.kind === 'dsh-export') {
      return [...wanted].map((relative) => ({
        source: 'dsh',
        sourcePath: path.join(root, ...relative.split('/')),
      }))
    }
    const conversations = chatgptConversationsPath(archive.entries)
    if (conversations === undefined) {
      throw new Error(vscode.l10n.t('This ZIP is not a DeepSeek Harness session export or a ChatGPT conversations archive.'))
    }
    return [{ source: 'chatgpt', sourcePath: path.join(root, ...conversations.split('/')) }]
  }

  private async discoverPath(client: NodeGatewayClient, sourcePath: string): Promise<readonly ImportRequestItem[]> {
    const discovered = await client.discoverImportSessions({ path: sourcePath })
    if (discovered.sessions.length === 0) {
      throw new Error(vscode.l10n.t('No importable sessions were found in {0}.', sourcePath))
    }
    const items = discovered.sessions.map(discoveryToRequest).filter((item) => item.source !== '')
    if (items.length === 0) {
      throw new Error(vscode.l10n.t('No importable sessions were found in {0}.', sourcePath))
    }
    return items
  }

  private async importItems(
    client: NodeGatewayClient,
    items: readonly ImportRequestItem[],
    force: boolean,
  ): Promise<readonly ImportResultItem[]> {
    if (items.length === 0) throw new Error(vscode.l10n.t('No importable sessions were selected.'))
    const imported = await client.importDiscoveredSessions({ items, force })
    return imported.results
  }

  /** Returns false when the user declines to install the importer plugin. */
  private async ensureChatImportPlugin(): Promise<boolean> {
    const installed = await this.pluginManager.listInstalled()
    const importer = installed.find((plugin) => plugin.name === CHAT_IMPORT_PACKAGE)
    if (importer !== undefined) {
      if (importer.enabled === false) await this.pluginManager.setEnabled(CHAT_IMPORT_PACKAGE, true)
      return this.importerReady()
    }
    const install = vscode.l10n.t('Install')
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Session import uses the dsh-chat-import plugin. Install it now?'),
      { modal: true, detail: vscode.l10n.t('The official plugin manager will install and activate the importer.') },
      install,
    )
    if (answer !== install) return false
    await this.pluginManager.install(CHAT_IMPORT_PACKAGE)
    return this.importerReady()
  }

  private importerReady(): boolean {
    const notice = this.pluginManager.takeNotice()
    if (notice === undefined) return true
    void vscode.window.showInformationMessage(notice)
    return false
  }

  private requireClient(): NodeGatewayClient {
    const client = this.gateway.providerControlClient()
    if (!(client instanceof NodeGatewayClient)) {
      throw new Error(vscode.l10n.t('The current Gateway does not support session import.'))
    }
    return client
  }
}

async function writeExtractedFiles(
  root: string,
  entries: readonly { readonly name: string; readonly data: Uint8Array }[],
): Promise<void> {
  for (const entry of entries) {
    const target = path.join(root, ...entry.name.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, entry.data)
  }
}

function userFacingImportError(cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause)
  if (detail === 'SESSION_IMPORT_UNAVAILABLE') {
    return new Error(vscode.l10n.t('Session import is unavailable. Reload the workbench after installing dsh-chat-import.'))
  }
  return cause instanceof Error ? cause : new Error(detail)
}

function discoveryToRequest(session: ImportDiscoveryItem): ImportRequestItem {
  const format = session.format ?? ''
  const source = session.source || FORMAT_TO_SOURCE[format] || format
  return {
    source,
    sourcePath: session.sourcePath,
    ...(session.sessionId === '' ? {} : { sessionId: session.sessionId }),
  }
}

function formatSourceLabel(session: ImportDiscoveryItem): string {
  const source = session.format || session.source || 'session'
  const project = session.project?.trim()
  return project === undefined || project === '' ? source : `${source} · ${project}`
}

function firstImportedSessionId(results: readonly ImportResultItem[]): string | undefined {
  return results.find((item) => typeof item.sessionId === 'string' && item.sessionId !== '' && item.sessionId !== 'none')?.sessionId
}

function summarizeImport(results: readonly ImportResultItem[]): string {
  const imported = results.filter((item) => item.status !== 'failed' && item.alreadyImported !== true && item.sessionId !== 'none').length
  const skipped = results.filter((item) => item.alreadyImported === true || item.status === 'skipped').length
  const failed = results.filter((item) => item.status === 'failed' || typeof item.error === 'string').length
  if (failed > 0 && imported === 0) {
    const first = results.find((item) => item.error !== undefined)
    return vscode.l10n.t('Session import failed: {0}', first?.error ?? String(failed))
  }
  return vscode.l10n.t('Imported {imported} sessions, skipped {skipped}, failed {failed}.', {
    imported: String(imported),
    skipped: String(skipped),
    failed: String(failed),
  })
}
