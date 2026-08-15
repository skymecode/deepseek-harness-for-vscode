import * as vscode from 'vscode'
import { ConfigurationService } from './config/configuration.js'
import { validateBaseUrl } from './domain/base-url.js'
import { EditorSelectionService } from './editor/editor-selection-service.js'
import { WorkspaceFileService } from './editor/workspace-file-service.js'
import { HarnessGatewayService } from './gateway/harness-gateway-service.js'
import { DshPluginCatalogService } from './plugins/plugin-catalog.js'
import { DshPluginCenterController } from './plugins/plugin-center-controller.js'
import { DshPluginManager } from './plugins/plugin-manager.js'
import { BundledRuntimeResolver } from './runtime/bundled-runtime.js'
import { HarnessHostRuntime } from './runtime/web-runtime.js'
import { CredentialStore } from './security/credential-store.js'
import { WorkbenchViewProvider, type ConnectionTestResult } from './ui/workbench-view-provider.js'

let activeRuntime: HarnessHostRuntime | undefined

/** Activates one self-contained Harness workbench; no external deployment is required. */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('DeepSeek Harness', { log: true })
  const configuration = new ConfigurationService()
  const credentials = new CredentialStore(context.secrets)
  const resolver = new BundledRuntimeResolver(context, (message, ...args) => vscode.l10n.t(message, ...args))
  const runtime = new HarnessHostRuntime(context, configuration, credentials, resolver, output)
  const gateway = new HarnessGatewayService(runtime, configuration, credentials, output)
  const pluginManager = new DshPluginManager(context, resolver, output)
  const pluginCatalog = new DshPluginCatalogService()
  const pluginCenter = new DshPluginCenterController(pluginManager, pluginCatalog, gateway)
  const editorSelection = new EditorSelectionService()
  const workspaceFiles = new WorkspaceFileService()
  activeRuntime = runtime

  const setApiKey = async (): Promise<void> => {
    const value = await vscode.window.showInputBox({
      title: vscode.l10n.t('Configure DeepSeek API Key'),
      prompt: vscode.l10n.t('The key will be written to deepseekHarness.apiKey in your local VS Code user settings.json.'),
      password: true,
      ignoreFocusOut: true,
      validateInput: (input) => input.trim() === '' ? vscode.l10n.t('The API Key cannot be empty.') : undefined,
    })
    if (value === undefined) return
    await credentials.setApiKey(value.trim())
    await provider.refresh()
    void vscode.window.showInformationMessage(vscode.l10n.t('DeepSeek API Key was saved to the local VS Code settings.json.'))
  }

  const persistSettings = async (baseUrl: string, apiKey: string | undefined): Promise<void> => {
    const normalized = baseUrl.trim()
    if (!validateBaseUrl(normalized).valid) {
      throw new Error(vscode.l10n.t('The Base URL must be a valid http(s) URL.'))
    }
    if (apiKey === undefined) {
      // No apiKey field was sent: leave the existing key untouched.
    } else if (apiKey.trim() === '') {
      await credentials.clearApiKey()
    } else {
      await credentials.setApiKey(apiKey.trim())
    }
    if (normalized !== (configuration.get().baseUrl ?? '')) {
      await configuration.setBaseUrl(normalized)
    }
  }

  const applySettings = async (baseUrl: string, apiKey: string | undefined): Promise<void> => {
    await persistSettings(baseUrl, apiKey)
    await provider.refresh()
  }

  const testConnection = async (baseUrl: string, apiKey: string | undefined): Promise<ConnectionTestResult> => {
    const endpoint = baseUrl.trim() === '' ? DEFAULT_BASE_URL : baseUrl.trim()
    if (!validateBaseUrl(endpoint).valid) {
      return { status: 'unreachable', detail: vscode.l10n.t('The Base URL must be a valid http(s) URL.') }
    }
    const key = apiKey?.trim()
    const url = new URL('chat/completions', endpoint.endsWith('/') ? endpoint : `${endpoint}/`)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CONNECTION_TEST_TIMEOUT_MS)
    try {
      // Make a real, minimal completion request so a valid key is accepted by
      // the provider's auth gate. A 401/403 means the key was rejected; any
      // other status means the key passed auth (model/params errors included).
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key === undefined || key === '' ? {} : { Authorization: `Bearer ${key}` }),
        },
        body: JSON.stringify({
          model: configuration.get().model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
        signal: controller.signal,
      })
      if (response.status === 401 || response.status === 403) {
        return { status: 'unauthorized', statusCode: response.status }
      }
      // A real OpenAI-compatible endpoint always answers with JSON (errors
      // included). An HTML page means the URL is a website, not an API.
      const body = await response.text()
      if (!isJsonObject(body)) {
        return { status: 'unreachable' }
      }
      return { status: 'success', statusCode: response.status }
    } catch (cause) {
      if (isAbortError(cause)) {
        return { status: 'unreachable', detail: vscode.l10n.t('Connection timed out.') }
      }
      const message = cause instanceof Error ? cause.message : String(cause)
      return { status: 'unreachable', detail: message }
    } finally {
      clearTimeout(timer)
    }
  }

  const provider = new WorkbenchViewProvider(
    context.extensionUri,
    configuration,
    gateway,
    pluginCenter,
    editorSelection,
    workspaceFiles,
    {
      setApiKey,
      applySettings,
      testConnection,
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
        vscode.l10n.t('Clear the DeepSeek API Key from the local VS Code settings.json?'),
        { modal: true },
        clear,
      )
      if (answer !== clear) return
      await credentials.clearApiKey()
      await provider.refresh()
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

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const CONNECTION_TEST_TIMEOUT_MS = 10_000

function isAbortError(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'name' in cause && cause.name === 'AbortError'
}

function isJsonObject(body: string): boolean {
  const trimmed = body.trim()
  if (trimmed === '') return false
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return typeof parsed === 'object' && parsed !== null
  } catch {
    return false
  }
}
