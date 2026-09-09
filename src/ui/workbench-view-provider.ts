/**
 * The native Codex/Cline-style workbench host: owns the webview view/panel
 * lifecycle and the publish queue, and forwards webview messages to
 * `handleWorkbenchMessage` (./workbench/view-messages.ts). The HTML document
 * lives in ./workbench/view-html.ts and the message payload parsers in
 * ./workbench/input-validators.ts.
 */
import * as vscode from 'vscode'
import type { ConfigurationService } from '../config/configuration.js'
import { AGENT_PRESET_OPTIONS, MODEL_OPTIONS, REASONING_OPTIONS } from '../domain/options.js'
import type { EditorSelectionService } from '../editor/editor-selection-service.js'
import type { WorkspaceFileService } from '../editor/workspace-file-service.js'
import type { HarnessGatewayService } from '../gateway/harness-gateway-service.js'
import type { DshPluginCenterController } from '../plugins/plugin-center-controller.js'
import type { ConnectionSettingsService } from '../services/connection-settings-service.js'
import { workbenchHtml } from './workbench/view-html.js'
import { isRecord, isTimeoutError, localizedOption } from './workbench/input-validators.js'
import { handleWorkbenchMessage } from './workbench/view-messages.js'
import type { WorkbenchViewActions } from './workbench/view-messages.js'

export type { WorkbenchViewActions } from './workbench/view-messages.js'

/** Native Codex/Cline-style workbench. No Harness page or iframe is embedded. */
export class WorkbenchViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'deepseekHarness.chatView'
  static readonly panelViewType = 'deepseekHarness.chatPanel'

  private view: vscode.WebviewView | undefined
  private panel: vscode.WebviewPanel | undefined
  private viewSubscription: vscode.Disposable | undefined
  private readonly subscriptions: vscode.Disposable[]
  private publishing: Promise<void> | undefined
  private publishPending = false

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly configuration: ConfigurationService,
    private readonly gateway: HarnessGatewayService,
    private readonly connectionSettings: ConnectionSettingsService,
    private readonly pluginCenter: DshPluginCenterController,
    private readonly editorSelection: EditorSelectionService,
    private readonly workspaceFiles: WorkspaceFileService,
    private readonly actions: WorkbenchViewActions,
  ) {
    this.subscriptions = [gateway.onDidChange(() => {
      void this.publishState().catch(() => undefined)
    }), connectionSettings.onDidChange(() => {
      void this.publishState().catch(() => undefined)
    }), pluginCenter.onDidChange((snapshot) => {
      void this.postToHosts({ type: 'pluginState', snapshot })
    }), editorSelection.onDidChange((selection) => {
      void this.postToHosts({ type: 'editorSelection', selection })
    }), vscode.workspace.onDidChangeWorkspaceFolders(() => {
      // Re-scope the session history to the newly opened project without
      // restarting the window.
      void this.publishState().catch(() => undefined)
    })]
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    // Drag-to-editor re-resolves this view into a fresh webview (and back
    // again). Drop the previous message subscription so a re-resolved view
    // never dispatches the same message twice or leaks a stale handler.
    this.viewSubscription?.dispose()
    this.view = view
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'media'),
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
      ],
    }
    view.webview.html = workbenchHtml(view.webview, this.extensionUri)
    this.viewSubscription = view.webview.onDidReceiveMessage((message: unknown) => {
      void this.dispatchMessage(message)
    })
    this.subscriptions.push(view.onDidChangeVisibility(() => {
      // Re-push the latest state whenever the view is shown (drag between the
      // sidebar and the editor re-resolves it; a hidden view resumes with an
      // empty DOM otherwise).
      if (view.visible) void this.publishState().catch(() => undefined)
    }))
    // Push immediately as well: the webview's own 'ready' races the gateway
    // baseline, and a view restored into the editor area may resolve while the
    // sidebar (if any) already consumed the last snapshot.
    void this.publishState().catch(() => undefined)
    void this.gateway.start()
  }

  async refresh(): Promise<void> {
    await this.gateway.restart()
  }

  dispose(): void {
    this.viewSubscription?.dispose()
    for (const subscription of this.subscriptions) subscription.dispose()
    this.panel?.dispose()
  }

  /** Opens the workbench in a detachable editor-area panel, like Claude Code. */
  openPanel(): void {
    if (this.panel !== undefined) {
      this.panel.reveal()
      return
    }
    const panel = vscode.window.createWebviewPanel(
      WorkbenchViewProvider.panelViewType,
      vscode.l10n.t('DeepSeek Harness'),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'media'),
          vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        ],
      },
    )
    panel.webview.html = workbenchHtml(panel.webview, this.extensionUri)
    panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.dispatchMessage(message)
    })
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined
    })
    this.panel = panel
    void this.gateway.start()
    void this.publishState().catch(() => undefined)
    void this.publishEditorSelection()
  }

  /** One error surface for every message that fails, view and panel alike. */
  private async dispatchMessage(message: unknown): Promise<void> {
    if (isRecord(message) && message.type === 'webviewError') {
      // Webview-side exceptions (blank panel diagnostics) land in the host
      // log with the same [webview] prefix we can grep for.
      const name = 'deepseekHarness-renderer-error'
      vscode.window.createOutputChannel(name, { log: true }).appendLine(String(message.message ?? 'unknown webview error'))
      return
    }
    try {
      await handleWorkbenchMessage({
        gateway: this.gateway,
        actions: this.actions,
        configuration: this.configuration,
        pluginCenter: this.pluginCenter,
        editorSelection: this.editorSelection,
        workspaceFiles: this.workspaceFiles,
        postToHosts: (payload) => this.postToHosts(payload),
        publishState: () => this.publishState(),
      }, message)
    } catch (cause: unknown) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      if (detail.includes('already owned by an active write handle')) {
        void vscode.window.showInformationMessage(vscode.l10n.t('This conversation is open in another Harness process. You can read its saved history here; close the owning process before continuing, or fork a new conversation.'))
        return
      }
      if (isTimeoutError(cause)) {
        // The transport aborts a request that exceeds its budget with a bare
        // "The operation was aborted due to timeout". Surface that as an
        // actionable message instead of a raw internal error.
        void vscode.window.showErrorMessage(vscode.l10n.t('DeepSeek Harness: The operation timed out. Check the output log and try again.'))
        return
      }
      void vscode.window.showErrorMessage(vscode.l10n.t('DeepSeek Harness: {0}', detail))
    }
  }

  private postToHosts(message: unknown): void {
    void this.view?.webview.postMessage(message)
    void this.panel?.webview.postMessage(message)
  }

  private publishState(): Promise<void> {
    // Gateway frames can arrive every few milliseconds. Serialize snapshots
    // so an older async credentials read can never overtake a newer state and
    // make streamed text visibly jump backwards/forwards.
    this.publishPending = true
    if (this.publishing !== undefined) return this.publishing
    const task = this.drainPublishQueue()
    this.publishing = task.finally(() => {
      this.publishing = undefined
      if (this.publishPending) void this.publishState().catch(() => undefined)
    })
    return this.publishing
  }

  private async drainPublishQueue(): Promise<void> {
    while (this.publishPending) {
      this.publishPending = false
      const state = await this.gateway.snapshot()
      const connectionSettings = this.connectionSettings.state
      await this.postToHosts({
        type: 'state',
        state,
        configuration: this.configuration.get(),
        connectionSettings,
        workspaceFolderOpen: vscode.workspace.workspaceFolders?.[0] !== undefined,
        fallbackOptions: {
          sources: connectionSettings.providers.map((provider) => ({ id: provider.id, label: provider.name })),
          models: MODEL_OPTIONS.map(localizedOption),
          reasoning: REASONING_OPTIONS.map(localizedOption),
          presets: AGENT_PRESET_OPTIONS.map(localizedOption),
        },
      })
    }
  }

  private async publishEditorSelection(): Promise<void> {
    await this.postToHosts({
      type: 'editorSelection',
      selection: this.editorSelection.current(),
    })
  }
}
