import * as vscode from 'vscode'
import { ConfigurationService } from './config/configuration.js'
import type { ConnectionSettingsInput } from './domain/connection-settings.js'
import { DEEPSEEK_OFFICIAL_PROVIDER } from './domain/provider.js'
import { EditorSelectionService } from './editor/editor-selection-service.js'
import { WorkspaceFileService } from './editor/workspace-file-service.js'
import { WorktreeService } from './editor/worktree-service.js'
import { HarnessGatewayService } from './gateway/harness-gateway-service.js'
import { DshPluginCatalogService } from './plugins/plugin-catalog.js'
import { DshPluginCenterController } from './plugins/plugin-center-controller.js'
import { DshPluginManager } from './plugins/plugin-manager.js'
import { BundledRuntimeResolver } from './runtime/bundled-runtime.js'
import { HarnessHostRuntime } from './runtime/web-runtime.js'
import { CredentialStore } from './security/credential-store.js'
import { ConnectionSettingsService } from './services/connection-settings-service.js'
import { ConnectionTestService } from './services/connection-test-service.js'
import { SessionImportService } from './import/session-import-service.js'
import { WorkbenchViewProvider } from './ui/workbench-view-provider.js'
import { CompletionNotifications } from './notifications/completion-notifications.js'

let activeRuntime: HarnessHostRuntime | undefined

/** Activates one self-contained Harness workbench; no external deployment is required. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // The bundled Gateway always listens on 127.0.0.1, and undici (the fetch
  // used by the Gateway client) honors system proxy env vars. A global proxy
  // (Clash/Surge/company VPN) would otherwise route loopback requests through
  // the proxy and fail with `fetch failed`, leaving the workbench stuck on
  // "Starting Harness". Loopback must never go through a proxy.
  const noProxy = new Set((process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').map((item) => item.trim()).filter((item) => item !== ''))
  noProxy.add('127.0.0.1')
  noProxy.add('localhost')
  process.env.NO_PROXY = [...noProxy].join(',')
  process.env.no_proxy = [...noProxy].join(',')

  const output = vscode.window.createOutputChannel('DeepSeek Harness', { log: true })
  const configuration = new ConfigurationService()
  const credentials = new CredentialStore(context.secrets)
  const resolver = new BundledRuntimeResolver(context, (message, ...args) => vscode.l10n.t(message, ...args))
  const connectionSettings = new ConnectionSettingsService(configuration, credentials)
  const runtime = new HarnessHostRuntime(context, configuration, resolver, output)
  const worktrees = new WorktreeService(context.globalState)
  const gateway = new HarnessGatewayService(runtime, configuration, connectionSettings, output, context.globalState, worktrees)
  const notifications = new CompletionNotifications(output)
  const connectionTest = new ConnectionTestService(() => gateway.providerControlClient())
  const pluginManager = new DshPluginManager(context, resolver, output)
  const pluginCatalog = new DshPluginCatalogService()
  const pluginCenter = new DshPluginCenterController(pluginManager, pluginCatalog, gateway)
  const sessionImport = new SessionImportService(pluginManager, gateway)
  const editorSelection = new EditorSelectionService()
  const workspaceFiles = new WorkspaceFileService()
  activeRuntime = runtime

  const setApiKey = async (): Promise<void> => {
    const value = await vscode.window.showInputBox({
      title: vscode.l10n.t('Configure DeepSeek API Key'),
      prompt: vscode.l10n.t('The key will be stored by the local Harness credential service.'),
      password: true,
      ignoreFocusOut: true,
      validateInput: (input) => input.trim() === '' ? vscode.l10n.t('The API Key cannot be empty.') : undefined,
    })
    if (value === undefined) return
    if (connectionSettings.connected) await connectionSettings.setOfficialApiKey(value.trim())
    else await credentials.setApiKey(value.trim())
    void vscode.window.showInformationMessage(vscode.l10n.t('DeepSeek API Key was saved to the local Harness credential store.'))
  }

  const applySettings = async (input: ConnectionSettingsInput): Promise<void> => {
    const route = await connectionSettings.apply(input)
    await configuration.setProvider(route)
    await gateway.refreshModelCatalog()
  }

  const removeProvider = async (route: string): Promise<void> => {
    if (gateway.isProviderInUse(route)) {
      throw new Error(vscode.l10n.t('The provider used by the current conversation cannot be removed.'))
    }
    if (configuration.get().provider === route) await configuration.setProvider(DEEPSEEK_OFFICIAL_PROVIDER)
    await connectionSettings.remove(route)
    await gateway.refreshModelCatalog()
  }

  const provider = new WorkbenchViewProvider(
    context.extensionUri,
    configuration,
    gateway,
    connectionSettings,
    pluginCenter,
    editorSelection,
    workspaceFiles,
    {
      setApiKey,
      applySettings,
      removeProvider,
      testConnection: (input) => connectionTest.test(input),
      openSettings: async () => {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'deepseekHarness')
      },
      showLogs: () => output.show(true),
      importSession: () => sessionImport.runInteractive(),
    },
  )

  context.subscriptions.push(
    output,
    configuration,
    runtime,
    gateway,
    notifications,
    gateway.onDidCompleteTurn((notice) => notifications.complete(notice)),
    worktrees,
    pluginCenter,
    editorSelection,
    workspaceFiles,
    provider,
    vscode.window.registerWebviewViewProvider(WorkbenchViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('deepseekHarness.openChat', focusWorkbench),
    vscode.commands.registerCommand('deepseekHarness.openChatWindow', () => provider.openPanel()),
    vscode.commands.registerCommand('deepseekHarness.reloadRuntime', () => provider.refresh()),
    vscode.commands.registerCommand('deepseekHarness.setApiKey', setApiKey),
    vscode.commands.registerCommand('deepseekHarness.clearApiKey', async () => {
      const clear = vscode.l10n.t('Clear')
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t('Clear the DeepSeek API Key from the local Harness credential store?'),
        { modal: true },
        clear,
      )
      if (answer !== clear) return
      if (connectionSettings.connected) await connectionSettings.clearOfficialApiKey()
      await credentials.clearApiKey()
    }),
    vscode.commands.registerCommand('deepseekHarness.showLogs', () => output.show(true)),
    vscode.commands.registerCommand('deepseekHarness.testSystemNotification', () => notifications.test()),
    vscode.commands.registerCommand('deepseekHarness.importSession', () => sessionImport.runInteractive()),
  )

  // First-run default-plugin seeding must never block activation: installing
  // the two built-ins (Super Injector + Chat Import) runs pnpm and downloads
  // from GitHub/npm, which can take a minute or two on a fresh machine.
  // Blocking left the workbench blank behind VS Code's activation progress
  // bar. Seed in the background after the first successful connect and
  // restart the runtime once through mutateRuntime so the profile change
  // takes effect cleanly.
  void seedDefaultPluginsAfterConnect(pluginManager, gateway, output)
}

/**
 * Runs the first-run default plugin seed behind a progress notification,
 * after the gateway baseline has settled. The runtime is stopped for the
 * pnpm mutation and restarted afterwards, so the newly installed plugins
 * are live without requiring a window reload.
 */
async function seedDefaultPluginsAfterConnect(
  pluginManager: DshPluginManager,
  gateway: HarnessGatewayService,
  output: vscode.OutputChannel,
): Promise<void> {
  try {
    await gateway.ensureStarted()
    if (!(await pluginManager.hasPendingDefaultPluginsSeed())) return
    output.appendLine(vscode.l10n.t('[plugin] Seeding default plugins (first run)…'))
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('DeepSeek Harness: installing default plugins…'),
    }, async () => {
      await gateway.mutateRuntime(() => pluginManager.ensureDefaultPlugins())
    })
    output.appendLine(vscode.l10n.t('[plugin] Default plugins ready.'))
  } catch (cause) {
    output.appendLine('[plugin] Failed to ensure default plugins: ' + (cause instanceof Error ? cause.message : String(cause)))
  }
}

export async function deactivate(): Promise<void> {
  await activeRuntime?.stop()
  activeRuntime = undefined
}

async function focusWorkbench(): Promise<void> {
  await vscode.commands.executeCommand(`${WorkbenchViewProvider.viewType}.focus`)
}
