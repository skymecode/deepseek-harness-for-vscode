import type { PromptConfiguration } from '../../domain/prompt-configuration.js'

export interface ConfigurationOption {
  readonly id: string
  readonly label: string
  readonly description?: string
}

export interface ModelConfigurationOption extends ConfigurationOption {
  readonly provider: string
  readonly reasoning: readonly ConfigurationOption[]
}

export interface ComposerConfigurationInput {
  readonly sessionId: string
  readonly connected: boolean
  readonly editable: boolean
  readonly blank: boolean
  readonly current: PromptConfiguration
  readonly sources: readonly ConfigurationOption[]
  readonly models: readonly ModelConfigurationOption[]
  readonly presets: readonly ConfigurationOption[]
  readonly fallbackReasoning: readonly ConfigurationOption[]
}

export type EffortTone = 'off' | 'high' | 'max'

export interface ComposerConfigurationSnapshot {
  readonly input: ComposerConfigurationInput
  readonly selection: PromptConfiguration
  readonly source: ConfigurationOption
  readonly model: ModelConfigurationOption
  readonly preset: ConfigurationOption
  readonly reasoning: readonly ConfigurationOption[]
  readonly effort: ConfigurationOption
  readonly effortIndex: number
  readonly effortTone: EffortTone
  readonly dirty: boolean
  readonly modeStartsNewConversation: boolean
}

export type ConfigurationSection = 'model' | 'preset' | 'reasoning'
