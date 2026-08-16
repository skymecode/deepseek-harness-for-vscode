import * as vscode from 'vscode'
import { ConfigurationService } from './config/configuration.js'
import type { ConnectionSettingsInput } from './domain/connection-settings.js'
import { DEEPSEEK_OFFICIAL_PROVIDER } from './domain/provider.js'
import { EditorSelectionService } from './editor/editor-selection-service.js'
import { WorkspaceFileService } from './editor/workspace-file-service.js'
import { HarnessGatewayService } from './gateway/harness-gateway-service.js'
import { DshPluginCatalogService } from './plugins/plugin-catalog.js'
import { DshPluginCenterController } from './plugins/plugin-center-controller.js'
import { DshPluginManager } from './plugins/plugin-manager.js'
import { BundledRuntimeResolver } from './runtime/bundled-runtime.js'
import { HarnessHostRuntime } from './runtime/web-runtime.js'
import { CredentialStore } from './security/credential-store.js'
import { ConnectionSettingsService } from './services/connection-settings-service.js'
import { ConnectionTestService } from './services/connection-test-service.js'
import { WorkbenchViewProvider } from './ui/workbench-view-provider.js'

let activeRuntime: HarnessHostRuntime | undefined

/** Activates one self-contained Harness workbench; no external deployment is required. */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('DeepSeek Harness', { log: true })
  const configuration = new ConfigurationService()
  const credentials = new CredentialStore(context.secrets)
  const resolver = new BundledRuntimeResolver(context, (message, ...args) => vscode.l10n.t(message, ...args))
  const connectionSettings = new ConnectionSettingsService(configuration, credentials)
  const runtime = new HarnessHostRuntime(context, configuration, resolver, output)
  const gateway = new HarnessGatewayService(runtime, configuration, connectionSettings, output)
  const connectionTest = new ConnectionTestService(() => gateway.providerControlClient())
  const pluginManager = new DshPluginManager(context, resolver, output)
  const pluginCatalog = new DshPluginCatalogService()
  const pluginCenter = new DshPluginCenterController(pluginManager, pluginCatalog, gateway)
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
    },
  )

  context.subscriptions.push(
    output,
    configuration,
    runtime,
    gateway,
    pluginCenter,
    editorSelection,
    workspaceFiles,
    provider,
    vscode.window.registerWebviewViewProvider(WorkbenchViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('deepseekHarness.openChat', focusWorkbench),
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
  )
}

export async function deactivate(): Promise<void> {
  await activeRuntime?.stop()
  activeRuntime = undefined
}

async function focusWorkbench(): Promise<void> {
  await vscode.commands.executeCommand(`${WorkbenchViewProvider.viewType}.focus`)
}
