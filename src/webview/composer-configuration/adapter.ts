import type { HarnessConfiguration } from '../../config/configuration.js'
import type { HarnessWorkbenchState } from '../../domain/workbench-state.js'
import type { ComposerConfigurationInput, ConfigurationOption, ModelConfigurationOption } from './types.js'

interface LocalizedOption {
  readonly id: string
  readonly label: string
  readonly description?: string
}

export interface ComposerConfigurationPayload {
  readonly state: HarnessWorkbenchState
  readonly configuration: HarnessConfiguration
  readonly fallbackOptions: {
    readonly sources: readonly LocalizedOption[]
    readonly models: readonly LocalizedOption[]
    readonly reasoning: readonly LocalizedOption[]
    readonly presets: readonly LocalizedOption[]
  }
}

/** Adapts the host workbench DTO to the frontend component contract. */
export function composerConfigurationInput(
  payload: ComposerConfigurationPayload,
): ComposerConfigurationInput | undefined {
  const active = payload.state.active
  if (active === undefined) return undefined
  const fallbackReasoning = payload.fallbackOptions.reasoning.map(copyOption)
  const sources = payload.fallbackOptions.sources.map(copyOption)
  // Provider and model are independent UI dimensions. Materialize only the
  // extension-owned Flash/Pro pair for each provider saved in settings.
  const models: readonly ModelConfigurationOption[] = sources.flatMap((source) => (
    payload.fallbackOptions.models.map((fallbackModel) => {
      const live = active.models.find((model) => model.provider === source.id && model.id === fallbackModel.id)
      return {
        provider: source.id,
        id: fallbackModel.id,
        label: fallbackModel.label,
        ...(fallbackModel.description === undefined ? {} : { description: fallbackModel.description }),
        reasoning: live === undefined || live.reasoning.length === 0
          ? fallbackReasoning
          : live.reasoning.map((effort) => {
            const fallback = fallbackReasoning.find((option) => option.id === effort.id)
            const description = effort.description ?? fallback?.description
            return {
              id: effort.id,
              label: fallback?.label ?? effort.name,
              ...(description === undefined ? {} : { description }),
            }
          }),
      }
    })
  ))
  const presets: readonly ConfigurationOption[] = payload.state.presets.length > 0
    ? payload.state.presets.filter((preset) => !preset.broken).map((preset) => ({
      id: preset.id,
      label: preset.name || preset.id,
      ...(preset.description === undefined ? {} : { description: preset.description }),
    }))
    : payload.fallbackOptions.presets.map(copyOption)
  return {
    sessionId: active.id,
    connected: payload.state.phase === 'connected',
    // A queued prompt must not mutate the Agent's live model selection while
    // the current turn may still be executing tools. DSH snapshots per step,
    // so changing it mid-turn could otherwise move a later step to a new route.
    editable: active.subagentMode === undefined && !active.running,
    blank: active.blank,
    current: {
      provider: active.model?.provider ?? payload.configuration.provider,
      model: active.model?.model ?? payload.configuration.model,
      reasoningEffort: active.model?.reasoningEffort ?? payload.configuration.reasoningEffort,
      agentPreset: active.agentPreset ?? payload.configuration.agentPreset,
    },
    sources,
    models,
    presets,
    fallbackReasoning,
  }
}

function copyOption(option: LocalizedOption): ConfigurationOption {
  return {
    id: option.id,
    label: option.label,
    ...(option.description === undefined ? {} : { description: option.description }),
  }
}
