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

export type PermissionMode = PermissionPresetId

/** Immutable settings used by the bundled official Harness Web runtime. */
export interface HarnessConfiguration {
  readonly model: ModelId
  readonly reasoningEffort: ReasoningEffort
  readonly agentPreset: AgentPresetId
  readonly provider: string
  readonly baseUrl: string | undefined
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
    const baseUrl = config.get<string>('baseUrl', '').trim()

    return {
      model: modelId(config.get<string>('model')),
      reasoningEffort: reasoningEffort(config.get<string>('reasoningEffort')),
      agentPreset: agentPresetId(config.get<string>('agentPreset')),
      provider: nonEmpty(config.get<string>('provider'), 'deepseek-official'),
      baseUrl: baseUrl === '' ? undefined : baseUrl,
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

  setBaseUrl(value: string): Thenable<void> {
    return this.update('baseUrl', value)
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
  'deepseekHarness.baseUrl',
  'deepseekHarness.permissionMode',
] as const

function nonEmpty(value: string | undefined, fallback: string): string {
  const normalized = value?.trim()
  return normalized === undefined || normalized === '' ? fallback : normalized
}

function permissionMode(value: string | undefined): PermissionMode {
  return permissionPresetId(value)
}
