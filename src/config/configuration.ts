import * as vscode from 'vscode'
import {
  AGENT_PRESET_OPTIONS,
  MODEL_OPTIONS,
  REASONING_OPTIONS,
  agentPresetId,
  modelId,
  reasoningEffort,
  type AgentPresetId,
  type ModelId,
  type ReasoningEffort,
} from '../domain/options.js'
import {
  isPermissionPresetId,
  permissionPresetId,
  type PermissionPresetId,
} from '../domain/permissions.js'
import {
  DEEPSEEK_OFFICIAL_PROVIDER,
  providerRoute,
  type CustomProvider,
} from '../domain/provider.js'

export type PermissionMode = PermissionPresetId

/** Immutable settings used by the bundled official Harness Web runtime. */
export interface HarnessConfiguration {
  readonly model: ModelId
  readonly reasoningEffort: ReasoningEffort
  readonly agentPreset: AgentPresetId
  readonly provider: string
  readonly permissionMode: PermissionMode
  /** Auto-attach the active editor selection as context when sending. */
  readonly autoAttachSelection: boolean
}

/** Reads extension settings and reports changes that require a runtime restart. */
export class ConfigurationService implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<HarnessConfiguration>()
  private readonly subscription: vscode.Disposable

  readonly onDidChange = this.changeEmitter.event

  constructor() {
    this.subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (RUNTIME_SETTING_KEYS.some((key) => event.affectsConfiguration(key))) {
        this.changeEmitter.fire(this.get())
      }
    })
  }

  get(): HarnessConfiguration {
    const config = vscode.workspace.getConfiguration('deepseekHarness')

    return {
      model: modelId(config.get<string>('model')),
      reasoningEffort: reasoningEffort(config.get<string>('reasoningEffort')),
      agentPreset: agentPresetId(config.get<string>('agentPreset')),
      provider: nonEmpty(config.get<string>('provider'), 'deepseek-official'),
      permissionMode: permissionMode(config.get<string>('permissionMode')),
      autoAttachSelection: config.get<boolean>('autoAttachSelection', true),
    }
  }

  /** Persists sidebar selections in the local VS Code user settings file. */
  setModel(value: ModelId): Thenable<void> {
    return this.update('model', value)
  }

  setReasoningEffort(value: ReasoningEffort): Thenable<void> {
    return this.update('reasoningEffort', value)
  }

  setAgentPreset(value: AgentPresetId): Thenable<void> {
    return this.update('agentPreset', value)
  }

  setPermissionMode(value: PermissionMode): Thenable<void> {
    return this.update('permissionMode', value)
  }

  setProvider(value: string): Thenable<void> {
    return this.update('provider', value)
  }

  async setProviderIfConfigured(value: string): Promise<void> {
    // The Gateway has already resolved this provider/model pair before this
    // persistence hook runs. DSH's live provider directory is the authority;
    // the legacy VS Code providers array is intentionally not consulted.
    if (value.trim() !== '' && this.get().provider !== value) await this.setProvider(value)
  }

  /** Reads the pre-control-plane provider array for one-time migration only. */
  getLegacyProviders(): CustomProvider[] {
    const raw = vscode.workspace.getConfiguration('deepseekHarness').get<unknown>('providers')
    if (!Array.isArray(raw)) return []
    const providers: CustomProvider[] = []
    const routes = new Set<string>([DEEPSEEK_OFFICIAL_PROVIDER])
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      const name = typeof record.name === 'string' ? record.name.trim() : ''
      const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl.trim() : ''
      const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : ''
      if (name === '' || baseUrl === '' || apiKey === '') continue
      const route = providerRoute(name)
      if (routes.has(route)) continue
      routes.add(route)
      providers.push({ name, baseUrl, apiKey })
    }
    return providers
  }

  /** Reads the pre-control-plane DeepSeek endpoint override for migration. */
  getLegacyBaseUrl(): string | undefined {
    const value = vscode.workspace.getConfiguration('deepseekHarness').get<string>('baseUrl', '').trim()
    return value === '' ? undefined : value
  }

  clearLegacyProviders(): Thenable<void> {
    return vscode.workspace.getConfiguration('deepseekHarness')
      .update('providers', undefined, vscode.ConfigurationTarget.Global)
  }

  clearLegacyBaseUrl(): Thenable<void> {
    return vscode.workspace.getConfiguration('deepseekHarness')
      .update('baseUrl', undefined, vscode.ConfigurationTarget.Global)
  }

  /** Persist a Gateway-owned model only when it is part of this extension's supported defaults. */
  async setModelIfKnown(value: string): Promise<void> {
    if (MODEL_OPTIONS.some((option) => option.id === value)) await this.setModel(value as ModelId)
  }

  async setReasoningEffortIfKnown(value: string): Promise<void> {
    if (REASONING_OPTIONS.some((option) => option.id === value)) {
      await this.setReasoningEffort(value as ReasoningEffort)
    }
  }

  async setAgentPresetIfKnown(value: string): Promise<void> {
    if (AGENT_PRESET_OPTIONS.some((option) => option.id === value)) {
      await this.setAgentPreset(value as AgentPresetId)
    }
  }

  async setPermissionModeIfKnown(value: string): Promise<void> {
    if (isPermissionPresetId(value)) await this.setPermissionMode(value)
  }

  dispose(): void {
    this.subscription.dispose()
    this.changeEmitter.dispose()
  }


  private update(key: string, value: string): Thenable<void> {
    return vscode.workspace.getConfiguration('deepseekHarness')
      .update(key, value, vscode.ConfigurationTarget.Global)
  }
}

const RUNTIME_SETTING_KEYS = [
  'deepseekHarness.model',
  'deepseekHarness.reasoningEffort',
  'deepseekHarness.agentPreset',
  'deepseekHarness.provider',
  'deepseekHarness.permissionMode',
] as const

function nonEmpty(value: string | undefined, fallback: string): string {
  const normalized = value?.trim()
  return normalized === undefined || normalized === '' ? fallback : normalized
}

function permissionMode(value: string | undefined): PermissionMode {
  return permissionPresetId(value)
}
