import { HistoricalReview } from './workbench/historical-review.js'
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
import type { EditorSelectionView } from '../editor/types.js'
import type { WorkspaceFileService } from '../editor/workspace-file-service.js'
import type { HarnessGatewayService } from '../gateway/harness-gateway-service.js'
import type { DshPluginCenterController } from '../plugins/plugin-center-controller.js'
import type { ConnectionSettingsService } from '../services/connection-settings-service.js'
import { workbenchHtml } from './workbench/view-html.js'
import { isRecord, isTimeoutError, localizedOption } from './workbench/input-validators.js'
import { handleWorkbenchMessage } from './workbench/view-messages.js'
import type { SelectionPinRef, WorkbenchViewActions } from './workbench/view-messages.js'

export type { WorkbenchViewActions } from './workbench/view-messages.js'

/** Native Codex/Cline-style workbench. No Harness page or iframe is embedded. */
export class WorkbenchViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'deepseekHarness.chatView'
  static readonly panelViewType = 'deepseekHarness.chatPanel'

  private view: vscode.WebviewView | undefined
  private panel: vscode.WebviewPanel | undefined
  private viewSubscription: vscode.Disposable | undefined
  private readonly subscriptions: vscode.Disposable[]
  private readonly review = new HistoricalReview()
  private publishing: Promise<void> | undefined
  private publishPending = false
  /** Host-owned explicit pins, shared by the sidebar and the editor panel. */
  private pinnedSelections: EditorSelectionView[] = []
  private readonly pinRevisions = new Map<string, number>()
  private nextPinRevision = 0
  private viewReady = false
  private panelReady = false

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
    let mcpSignature = JSON.stringify(configuration.get().mcpServers ?? [])
    this.subscriptions = [gateway.onDidChange(() => {
      void this.publishState().catch(() => undefined)
    }), vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('deepseekHarness.worktreeAutoMerge')) void this.publishState().catch(() => undefined)
    }), configuration.onDidChange((next) => {
      const nextMcpSignature = JSON.stringify(next.mcpServers ?? [])
      if (nextMcpSignature === mcpSignature) return
      mcpSignature = nextMcpSignature
      void this.gateway.restart().catch(() => undefined)
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

  /** Resolves the sidebar webview and starts its message/state lifecycle. */
  resolveWebviewView(view: vscode.WebviewView): void {
    // Drag-to-editor re-resolves this view into a fresh webview (and back
    // again). Drop the previous message subscription so a re-resolved view
    // never dispatches the same message twice or leaks a stale handler.
    this.viewSubscription?.dispose()
    this.view = view
    this.viewReady = false
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'media'),
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
      ],
    }
    view.webview.html = workbenchHtml(view.webview, this.extensionUri)
    this.viewSubscription = view.webview.onDidReceiveMessage((message: unknown) => {
      void this.dispatchMessage(message, 'view')
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

  /** Restarts the Harness gateway and republishes the workbench. */
  async refresh(): Promise<void> {
    await this.gateway.restart()
  }

  /**
   * Pins one editor selection for every open workbench host, retaining its
   * source text until the prompt is accepted or the pin is removed.
   */
  pinSelection(selection: EditorSelectionView): void {
    this.editorSelection.retain(selection.id)
    this.pinRevisions.set(selection.id, ++this.nextPinRevision)
    const next = [...this.pinnedSelections.filter((item) => item.id !== selection.id), selection].slice(-8)
    for (const dropped of this.pinnedSelections) {
      if (next.some((item) => item.id === dropped.id)) continue
      this.pinRevisions.delete(dropped.id)
      this.editorSelection.release(dropped.id)
    }
    this.pinnedSelections = next
    this.postPinnedSelections()
  }

  /** Removes one pin from the host state and from every open workbench host. */
  unpinSelection(selectionId: string): void {
    this.pinnedSelections = this.pinnedSelections.filter((item) => item.id !== selectionId)
    this.pinRevisions.delete(selectionId)
    this.editorSelection.release(selectionId)
    this.postPinnedSelections()
  }

  /** Captures the pin generations consumed by one prompt, ignoring auto-attach cards. */
  snapshotPins(selectionIds: readonly string[]): readonly SelectionPinRef[] {
    const refs: SelectionPinRef[] = []
    for (const id of selectionIds) {
      const revision = this.pinRevisions.get(id)
      if (revision !== undefined) refs.push({ id, revision })
    }
    return refs
  }

  /**
   * Clears the pins consumed by a prompt. With no refs, every pin is cleared;
   * a pin repinned while the prompt was pending keeps its new generation.
   */
  clearPinnedSelections(refs?: readonly SelectionPinRef[]): void {
    const consumed = new Set<string>()
    if (refs === undefined) {
      for (const selection of this.pinnedSelections) consumed.add(selection.id)
    } else {
      for (const ref of refs) {
        if (this.pinRevisions.get(ref.id) === ref.revision) consumed.add(ref.id)
      }
    }
    if (consumed.size === 0) return
    this.pinnedSelections = this.pinnedSelections.filter((item) => !consumed.has(item.id))
    for (const id of consumed) {
      this.pinRevisions.delete(id)
      this.editorSelection.release(id)
    }
    this.postPinnedSelections()
  }

  /** Releases subscriptions, the editor panel and historical documents. */
  dispose(): void {
    this.viewSubscription?.dispose()
    for (const subscription of this.subscriptions) subscription.dispose()
    this.panel?.dispose()
    this.review.dispose()
  }

  /** Opens the workbench in a detachable editor-area panel, like Claude Code. */
  openPanel(): void {
    if (this.panel !== undefined) {
      this.panel.reveal()
      return
    }
    this.panelReady = false
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
      void this.dispatchMessage(message, 'panel')
    })
    panel.onDidDispose(() => {
      if (this.panel !== panel) return
      this.panel = undefined
      this.panelReady = false
    })
    this.panel = panel
    void this.gateway.start()
    void this.publishState().catch(() => undefined)
    void this.publishEditorSelection()
  }

  /** One error surface for every message that fails, view and panel alike. */
  private async dispatchMessage(message: unknown, source: 'view' | 'panel'): Promise<void> {
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
        review: this.review,
        actions: this.actions,
        configuration: this.configuration,
        pluginCenter: this.pluginCenter,
        editorSelection: this.editorSelection,
        workspaceFiles: this.workspaceFiles,
        postToHosts: (payload) => this.postToHosts(payload),
        publishState: () => this.publishState(),
        pinSelection: (selection) => this.pinSelection(selection),
        unpinSelection: (selectionId) => this.unpinSelection(selectionId),
        snapshotPins: (selectionIds) => this.snapshotPins(selectionIds),
        clearPinnedSelections: (refs) => this.clearPinnedSelections(refs),
      }, message)
      if (isRecord(message) && message.type === 'ready') {
        if (source === 'view') this.viewReady = true
        else this.panelReady = true
        this.postPinnedSelections(source)
      }
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

  /** Posts one message to every existing webview host. */
  private postToHosts(message: unknown): void {
    void this.view?.webview.postMessage(message)
    void this.panel?.webview.postMessage(message)
  }

  /**
   * Sends the host-owned pin snapshot to one host after its `ready` message,
   * or to every ready host when no target is given.
   */
  private postPinnedSelections(target?: 'view' | 'panel'): void {
    const message = { type: 'pinnedSelections', selections: this.pinnedSelections }
    if ((target === undefined || target === 'view') && this.view !== undefined && this.viewReady) {
      void this.view.webview.postMessage(message)
    }
    if ((target === undefined || target === 'panel') && this.panel !== undefined && this.panelReady) {
      void this.panel.webview.postMessage(message)
    }
  }

  /** Queues a serialized workbench snapshot for every host. */
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

  /** Drains the latest snapshot while coalescing rapid gateway updates. */
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

  /** Publishes the current editor selection to every host. */
  private async publishEditorSelection(): Promise<void> {
    await this.postToHosts({
      type: 'editorSelection',
      selection: this.editorSelection.current(),
    })
  }
}
