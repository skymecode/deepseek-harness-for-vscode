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
  // The auto reasoning layer is a separate intent, never a provider tier id:
  // reasoning options stay exactly the provider's own offered set.
  const fallbackReasoning = payload.fallbackOptions.reasoning.map(copyOption)
  const fallbackSources = payload.fallbackOptions.sources.map(copyOption)
  const liveSources = active.models.map((model) => ({ id: model.provider, label: model.providerName }))
  const sourceMap = new Map<string, ConfigurationOption>()
  for (const source of fallbackSources) sourceMap.set(source.id, source)
  for (const source of liveSources) {
    if (!sourceMap.has(source.id)) sourceMap.set(source.id, { id: source.id, label: source.label })
  }
  const sources = [...sourceMap.values()]
  // Prefer the live Harness catalog so models from every configured or
  // plugin-provided provider appear automatically. While the catalog is still
  // loading, fall back to the configured sources with the Flash/Pro pair.
  const models: ModelConfigurationOption[] = active.models.length > 0
    ? active.models.map((model) => ({
      provider: model.provider,
      providerName: model.providerName,
      id: model.id,
      label: model.name,
      ...(model.description === undefined ? {} : { description: model.description }),
      reasoning: model.reasoning.length === 0
        ? fallbackReasoning
        : model.reasoning.map((effort) => {
          const fallback = fallbackReasoning.find((option) => option.id === effort.id)
          const description = effort.description ?? fallback?.description
          return {
            id: effort.id,
            label: fallback?.label ?? effort.name,
            ...(description === undefined ? {} : { description }),
          }
        }),
    }))
    : sources.flatMap((source) => payload.fallbackOptions.models.map((fallbackModel) => ({
      provider: source.id,
      providerName: source.label,
      id: fallbackModel.id,
      label: fallbackModel.label,
      ...(fallbackModel.description === undefined ? {} : { description: fallbackModel.description }),
      reasoning: fallbackReasoning,
    })))
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
      ...(active.effortIntent === 'auto' ? { reasoningIntent: 'auto' as const } : {}),
    },
    sources,
    models,
    presets,
    fallbackReasoning,
    experimentalAutoEffort: payload.configuration.experimentalAutoEffort === true,
  }
}

function copyOption(option: LocalizedOption): ConfigurationOption {
  return {
    id: option.id,
    label: option.label,
    ...(option.description === undefined ? {} : { description: option.description }),
  }
}
