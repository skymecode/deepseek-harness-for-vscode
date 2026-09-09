/**
 * Routes messages from the workbench webview to host capabilities. Each case
 * is one message type; heavy flows (sendPrompt, exportSession, worktree
 * triage) keep their bodies here so the view provider only owns the webview
 * lifecycle.
 */
import * as vscode from 'vscode'
import type { ConfigurationService } from '../../config/configuration.js'
import type { ConnectionSettingsInput, ConnectionTestResult } from '../../domain/connection-settings.js'
import { promptConfiguration } from '../../domain/prompt-configuration.js'
import { referenceFromKey as fileReferenceFromKey } from '../../webview/file-reference.js'
import type { EditorSelectionService } from '../../editor/editor-selection-service.js'
import type { WorkspaceFileService } from '../../editor/workspace-file-service.js'
import type { HarnessGatewayService } from '../../gateway/harness-gateway-service.js'
import type { DshPluginCenterController } from '../../plugins/plugin-center-controller.js'
import {
  exportFilename,
  goalAction,
  isRecord,
  numberValue,
  openFileRequest,
  optionalHttpUrl,
  optionalString,
  promptContextInput,
  promptImageAttachments,
  questionAnswers,
  requiredString,
  safeExternalUri,
  settingsInput,
} from './input-validators.js'

/** The host capabilities one message may reach. */
export interface WorkbenchMessageContext {
  readonly gateway: HarnessGatewayService
  readonly actions: WorkbenchViewActions
  readonly configuration: ConfigurationService
  readonly pluginCenter: DshPluginCenterController
  readonly editorSelection: EditorSelectionService
  readonly workspaceFiles: WorkspaceFileService
  readonly postToHosts: (message: unknown) => void
  readonly publishState: () => Promise<void>
}

export interface WorkbenchViewActions {
  readonly setApiKey: () => Promise<void>
  readonly applySettings: (input: ConnectionSettingsInput) => Promise<void>
  readonly removeProvider: (provider: string) => Promise<void>
  readonly testConnection: (input: ConnectionSettingsInput) => Promise<ConnectionTestResult>
  readonly openSettings: () => Promise<void>
  readonly showLogs: () => void
  readonly importSession: () => Promise<void>
}

  export async function handleWorkbenchMessage(ctx: WorkbenchMessageContext, value: unknown): Promise<void> {
  if (!isRecord(value) || typeof value.type !== 'string') return
  switch (value.type) {
    case 'ready':
      await ctx.publishState()
      await ctx.postToHosts({ type: 'editorSelection', selection: ctx.editorSelection.current() })
      break
    case 'retry':
      await ctx.gateway.restart()
      break
    case 'setApiKey':
      await ctx.actions.setApiKey()
      break
    case 'applySettings': {
      await ctx.actions.applySettings(settingsInput(value))
      break
    }
    case 'setExperimentalAutoEffort': {
      const enabled = value.value === true
      await ctx.configuration.setExperimentalAutoEffort(enabled)
      await ctx.publishState()
      break
    }
    case 'removeProvider': {
      await ctx.actions.removeProvider(requiredString(value, 'provider'))
      break
    }
    case 'testConnection': {
      const result = await ctx.actions.testConnection(settingsInput(value))
      await ctx.postToHosts({ type: 'connectionTestResult', ...result })
      break
    }
    case 'openSettings':
      await ctx.actions.openSettings()
      break
    case 'loadPlugins':
      await ctx.pluginCenter.load(value.force === true)
      break
    case 'installPlugin':
      await ctx.pluginCenter.install(
        requiredString(value, 'spec'),
        optionalString(value.name),
        optionalHttpUrl(value.repositoryUrl),
      )
      break
    case 'removePlugin':
      await ctx.pluginCenter.remove(requiredString(value, 'name'))
      break
    case 'showLogs':
      ctx.actions.showLogs()
      break
    case 'refreshSessions':
      await ctx.gateway.ensureStarted()
      await ctx.gateway.reloadSessions()
      break
    case 'newSession':
      try {
        await ctx.gateway.createSession()
      } finally {
        // Re-arm the ＋ button in the webview even when creation failed: the
        // webview disables it on click so a storm cannot fan out, and only the
        // host knows when the flow actually settled.
        await ctx.postToHosts({ type: 'newSessionSettled' })
      }
      break
    case 'searchSessions': {
      const query = typeof value.query === 'string' ? value.query : ''
      const results = await ctx.gateway.searchSessions(query)
      await ctx.postToHosts({ type: 'searchResults', query, results })
      break
    }
    case 'selectSession':
      await ctx.gateway.openSession(requiredString(value, 'sessionId'))
      break
    case 'selectSubagent': {
      const mode = value.mode === 'continuable' ? 'continuable' : 'one-shot'
      await ctx.gateway.selectSubagent(requiredString(value, 'sessionId'), mode)
      break
    }
    case 'selectParent':
      await ctx.gateway.selectParentSession()
      break
    case 'loadOlder':
      await ctx.gateway.loadOlder()
      break
    case 'sendPrompt': {
      const text = typeof value.text === 'string' ? value.text : ''
      const staged = promptConfiguration(value.configuration)
      if (value.configuration !== undefined && staged === undefined) {
        throw new Error(vscode.l10n.t('Invalid model or mode configuration.'))
      }
      const context = promptContextInput(value.context)
      const selectionId = context === undefined && ctx.configuration.get().autoAttachSelection
        ? ctx.editorSelection.current()?.id
        : context?.selectionId
      const selection = ctx.editorSelection.attachment(selectionId)
      const files = await ctx.workspaceFiles.attachments(context?.fileIds ?? [])
      const images = promptImageAttachments(value.images)
      const attachments = [...(selection === undefined ? [] : [selection]), ...files, ...images]
      // Host-computed task signals for the 'auto' reasoning layer, measured
      // after the final attachment set is known: a short question carrying a
      // large @-file or editor selection must never be judged trivial.
      const textChars = attachments.reduce(
        (sum, attachment) => sum + ('text' in attachment ? attachment.text.length : 0),
        text.length,
      )
      const signals = {
        promptTokens: Math.ceil(textChars / 4),
        attachmentCount: attachments.length,
        imageCount: images.length,
      }
      // The gateway owns configuration staging: idle prompts apply it ahead
      // of admission; queued prompts keep it in a FIFO pending queue applied
      // at the next turn boundary. No snapshot check races here.
      try {
        await ctx.gateway.sendPrompt(
          text,
          value.mode === 'steer' ? 'steer' : 'queue',
          attachments,
          staged,
          signals,
        )
      } catch (cause) {
        // The prompt never entered the queue: tell the webview to roll back
        // its optimistic echo so the failed message does not linger as if it
        // had been sent (and later real messages do not stack behind it).
        await ctx.postToHosts({ type: 'sendPromptFailed' })
        throw cause
      }
      break
    }
    case 'cancel':
      await ctx.gateway.cancel()
      break
    case 'steerQueued':
      await ctx.gateway.steerQueued(requiredString(value, 'itemId'))
      break
    case 'removeQueued':
      await ctx.gateway.removeQueued(requiredString(value, 'itemId'))
      break
    case 'editQueued': {
      const itemId = requiredString(value, 'itemId')
      const text = typeof value.text === 'string' ? value.text.trim() : ''
      if (text !== '') await ctx.gateway.editQueued(itemId, text)
      break
    }
    case 'setPermission':
      await ctx.gateway.selectPermission(requiredString(value, 'value'))
      break
    case 'openExternal': {
      // Only http(s) links from rendered markdown are opened, never local
      // paths or custom schemes.
      const raw = typeof value.url === 'string' ? value.url : ''
      const uri = safeExternalUri(raw)
      if (uri !== undefined) void vscode.env.openExternal(uri)
      break
    }
    case 'searchWorkspaceFiles': {
      const query = typeof value.query === 'string' ? value.query.slice(0, 200) : ''
      const requestId = numberValue(value.requestId)
      const files = await ctx.workspaceFiles.search(query)
      await ctx.postToHosts({ type: 'workspaceFileSuggestions', query, requestId, files })
      break
    }
    case 'openFile': {
      const request = openFileRequest(value)
      const roots = ctx.gateway.activeWorktreeRoot()
      if (!await ctx.workspaceFiles.open(request, roots === undefined ? undefined : [roots])) {
        void vscode.window.showWarningMessage(vscode.l10n.t('File is not available in the current workspace.'))
      }
      break
    }
    case 'validateFileReferences': {
      const keys = Array.isArray(value.keys) ? value.keys.filter((key): key is string => typeof key === 'string') : []
      const roots = ctx.gateway.activeWorktreeRoot()
      const rootList = roots === undefined ? undefined : [roots]
      const resolved: string[] = []
      const rejected: string[] = []
      for (const key of keys) {
        const reference = fileReferenceFromKey(key)
        if (reference === undefined) {
          rejected.push(key)
          continue
        }
        const exists = await ctx.workspaceFiles.referenceExists(reference, rootList)
        if (exists) resolved.push(key)
        else rejected.push(key)
      }
      await ctx.postToHosts({ type: 'referenceValidation', resolved, rejected })
      break
    }
    case 'attachSelection': {
      const selection = ctx.editorSelection.current()
      await ctx.postToHosts({ type: 'editorSelection', selection })
      if (selection === undefined) {
        void vscode.window.showInformationMessage(vscode.l10n.t('Select code in an editor first.'))
      }
      break
    }
    case 'loadCommands':
      await ctx.gateway.refreshCommands()
      break
    case 'setPlan':
      await ctx.gateway.setPlanMode(value.active === true)
      break
    case 'createGoal': {
      const objective = await vscode.window.showInputBox({
        title: vscode.l10n.t('Create Harness Goal'),
        prompt: vscode.l10n.t('Harness will pursue this goal until it is completed, paused, or reaches its round limit.'),
        validateInput: (input) => input.trim() === '' ? vscode.l10n.t('The goal cannot be empty.') : undefined,
      })
      if (objective !== undefined) await ctx.gateway.createGoal(objective.trim())
      break
    }
    case 'mutateGoal': {
      const action = goalAction(value.action)
      await ctx.gateway.mutateGoal(action)
      break
    }
    case 'rename': {
      const current = await ctx.gateway.snapshot()
      const title = await vscode.window.showInputBox({
        title: vscode.l10n.t('Rename Harness session'),
        value: current.active?.title ?? '',
        validateInput: (input) => input.trim() === '' ? vscode.l10n.t('The title cannot be empty.') : undefined,
      })
      if (title !== undefined) await ctx.gateway.rename(title)
      break
    }
    case 'fork':
      await ctx.gateway.fork(numberValue(value.atSeq))
      break
    case 'answerApproval': {
      const outcome = value.outcome === 'allowed-once' ? 'allowed-once' : 'rejected'
      await ctx.gateway.answerApproval(requiredString(value, 'key'), outcome)
      break
    }
    case 'answerQuestions':
      await ctx.gateway.answerQuestions(requiredString(value, 'key'), questionAnswers(value.answers))
      break
    case 'importSession':
      await ctx.actions.importSession()
      break
    case 'archiveSession':
      await ctx.gateway.archiveSession(requiredString(value, 'sessionId'))
      break
    case 'restoreSession':
      await ctx.gateway.restoreSession(requiredString(value, 'sessionId'))
      break
    case 'toggleSessionPin':
      await ctx.gateway.toggleSessionPin(requiredString(value, 'sessionId'))
      break
    case 'editSessionTags': {
      const sessionId = requiredString(value, 'sessionId')
      const state = await ctx.gateway.snapshot()
      const session = [...state.sessions, ...state.archivedSessions].find((item) => item.id === sessionId)
      const input = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Tags for this conversation (comma-separated)'),
        value: (session?.meta?.tags ?? []).join(', '),
      })
      if (input === undefined) break
      const tags = input.split(',').map((tag) => tag.trim()).filter((tag) => tag !== '')
      await ctx.gateway.setSessionTags(sessionId, tags)
      break
    }
    case 'worktreeAction':
      await handleWorktreeAction(ctx.gateway, requiredString(value, 'sessionId'))
      break
    case 'exportSession': {
      const sessionId = optionalString(value.sessionId)
      const exportId = sessionId === undefined ? (await ctx.gateway.snapshot()).active?.id : sessionId
      if (exportId === undefined) throw new Error(vscode.l10n.t('Create or select a session first.'))
      const filename = exportFilename(exportId)
      // Ask for the destination before downloading so a cancelled dialog
      // does not waste a potentially large ZIP transfer. Uri.file needs an
      // absolute path, so anchor the default name in the workspace folder.
      const defaultFolder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.cwd())
      const target = await vscode.window.showSaveDialog({
        title: vscode.l10n.t('Export Harness session'),
        defaultUri: vscode.Uri.joinPath(defaultFolder, filename),
        filters: { 'ZIP archive': ['zip'] },
      })
      if (target === undefined) break
      const bytes = await ctx.gateway.exportSession(exportId, value.includeDescendants !== false)
      await vscode.workspace.fs.writeFile(target, bytes)
      void vscode.window.showInformationMessage(vscode.l10n.t('Session exported: {0}', target.fsPath))
      break
    }
    case 'compact': {
      // The command catalog can lag a freshly opened session; refresh it so
      // the availability check is against the live registration.
      await ctx.gateway.refreshCommands()
      if (!ctx.gateway.hasHostCommand('compact')) {
        throw new Error(vscode.l10n.t('Compact is not available for this session.'))
      }
      await ctx.gateway.prompt('/compact')
      break
    }
    case 'sessionChangesReview': {
      // Open a real unified-diff document for the latest turn's edits —
      // the worktree diff when the session is isolated, else the main
      // checkout's uncommitted diff. Falls back to VS Code's Source
      // Control review when no diff text is available.
      const diff = await ctx.gateway.recentTurnDiff(ctx.gateway.openSessionId())
      if (diff !== undefined && diff.trim() !== '') {
        const document = await vscode.workspace.openTextDocument({ language: 'diff', content: diff })
        await vscode.window.showTextDocument(document, { preview: true })
        break
      }
      await vscode.commands.executeCommand('workbench.view.scm')
      break
    }
    case 'sessionChangesUndo': {
      const sessionId = ctx.gateway.openSessionId()
      if (sessionId !== undefined && (await ctx.gateway.worktreeDiscard(sessionId)).ok) {
        void vscode.window.showInformationMessage(vscode.l10n.t('The session worktree changes were discarded.'))
      } else {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('Undo of the last turn is only available for isolated sessions.'),
        )
      }
      break
    }
  }
  }

  /**
   * End-of-session triage for an isolated (worktree-backed) session: Review
   * diff, Merge back to the base branch, or Discard the worktree.
   */
  async function handleWorktreeAction(gateway: HarnessGatewayService, sessionId: string): Promise<void> {
  const record = gateway.worktreeRecord(sessionId)
  if (record === undefined) {
    void vscode.window.showInformationMessage(vscode.l10n.t('This session does not have an isolated worktree.'))
    return
  }
  const review = vscode.l10n.t('Review diff')
  const merge = vscode.l10n.t('Merge back to {0}', record.baseBranch)
  const discard = vscode.l10n.t('Discard worktree')
  const choice = await vscode.window.showQuickPick([review, merge, discard], {
    title: vscode.l10n.t('Session worktree (branch {0})', record.branch),
    placeHolder: vscode.l10n.t("Choose what to do with this session's isolated worktree"),
  })
  if (choice === review) {
    const diff = await gateway.worktreeDiff(sessionId)
    if (diff === undefined || diff === '') {
      void vscode.window.showInformationMessage(vscode.l10n.t('The session branch has no diff against {0}.', record.baseBranch))
      return
    }
    const document = await vscode.workspace.openTextDocument({ language: 'diff', content: diff })
    await vscode.window.showTextDocument(document, { preview: true })
    return
  }
  if (choice === merge) {
    const confirm = await vscode.window.showWarningMessage(
      vscode.l10n.t('Merge branch {0} into {1}?', record.branch, record.baseBranch),
      { modal: true },
      vscode.l10n.t('Merge'),
    )
    if (confirm === undefined) return
    const outcome = await gateway.worktreeMerge(sessionId)
    if (!outcome.ok) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Merge failed: {0}', outcome.message))
      return
    }
    if (outcome.message === 'no-changes') {
      void vscode.window.showInformationMessage(vscode.l10n.t('Nothing to merge: the session worktree has no changes.'))
      return
    }
    const note = outcome.message === 'merged-dirty'
      ? vscode.l10n.t(' The branch was updated, but your working tree had uncommitted changes and still trails the branch.')
      : ''
    void vscode.window.showInformationMessage(vscode.l10n.t('Merged {0} into {1}.', record.branch, record.baseBranch) + note)
    return
  }
  if (choice === discard) {
    const confirm = await vscode.window.showWarningMessage(
      vscode.l10n.t('Discard the worktree for this session? The session log is kept.'),
      { modal: true },
      vscode.l10n.t('Discard'),
    )
    if (confirm === undefined) return
    const outcome = await gateway.worktreeDiscard(sessionId)
    if (!outcome.ok) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Discard failed: {0}', outcome.message))
      return
    }
    void vscode.window.showInformationMessage(vscode.l10n.t('Worktree discarded.'))
  }
  }
