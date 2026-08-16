import type { PromptConfiguration } from '../../domain/prompt-configuration.js'
import type {
  ComposerConfigurationInput,
  ComposerConfigurationSnapshot,
  EffortTone,
  ModelConfigurationOption,
} from './types.js'

interface ConfigurationDraft {
  readonly sessionId: string
  readonly selection: PromptConfiguration
  readonly submitted: boolean
}

/** Owns composer configuration state independently from DOM rendering. */
export class ComposerConfigurationStore {
  private input: ComposerConfigurationInput | undefined
  private draft: ConfigurationDraft | undefined

  update(input: ComposerConfigurationInput): ComposerConfigurationSnapshot | undefined {
    if (this.draft !== undefined && this.draft.sessionId !== input.sessionId) {
      this.draft = this.draft.submitted
        ? { ...this.draft, sessionId: input.sessionId }
        : undefined
    }
    this.input = input
    const current = normalizeSelection(input.current, input)
    if (current === undefined) return undefined
    if (this.draft !== undefined) {
      const draft = normalizeSelection(this.draft.selection, input)
      if (draft === undefined || configurationEquals(draft, current)) this.draft = undefined
      else this.draft = { ...this.draft, selection: draft }
    }
    return this.snapshot()
  }

  snapshot(): ComposerConfigurationSnapshot | undefined {
    const input = this.input
    if (input === undefined) return undefined
    const current = normalizeSelection(input.current, input)
    const selection = normalizeSelection(this.draft?.selection ?? input.current, input)
    if (current === undefined || selection === undefined) return undefined
    const source = input.sources.find((option) => option.id === selection.provider)
    const model = findModel(input.models, selection.provider, selection.model)
    const preset = input.presets.find((option) => option.id === selection.agentPreset)
    if (source === undefined || model === undefined || preset === undefined) return undefined
    const reasoning = reasoningFor(model, input)
    const effortIndex = Math.max(0, reasoning.findIndex((option) => option.id === selection.reasoningEffort))
    const effort = reasoning[effortIndex]
    if (effort === undefined) return undefined
    return {
      input,
      selection,
      source,
      model,
      preset,
      reasoning,
      effort,
      effortIndex,
      effortTone: effortTone(effort.id, effortIndex, reasoning.length),
      dirty: !configurationEquals(selection, current),
      modeStartsNewConversation: !input.blank && selection.agentPreset !== current.agentPreset,
    }
  }

  selectModel(provider: string, modelId: string): ComposerConfigurationSnapshot | undefined {
    const snapshot = this.snapshot()
    const input = this.input
    if (snapshot === undefined || input === undefined) return undefined
    const model = findModel(input.models, provider, modelId)
    if (model === undefined) return snapshot
    const reasoning = reasoningFor(model, input)
    const requested = reasoning.some((option) => option.id === snapshot.selection.reasoningEffort)
      ? snapshot.selection.reasoningEffort
      : reasoning.some((option) => option.id === input.current.reasoningEffort)
        ? input.current.reasoningEffort
        : reasoning[0]?.id
    if (requested === undefined) return snapshot
    return this.stage({ ...snapshot.selection, provider, model: modelId, reasoningEffort: requested })
  }

  selectSource(provider: string): ComposerConfigurationSnapshot | undefined {
    const snapshot = this.snapshot()
    const input = this.input
    if (snapshot === undefined || input === undefined || !input.sources.some((source) => source.id === provider)) {
      return snapshot
    }
    const model = findModel(input.models, provider, snapshot.selection.model)
      ?? modelsForSource(input.models, provider)[0]
    return model === undefined ? snapshot : this.selectModel(provider, model.id)
  }

  selectPreset(agentPreset: string): ComposerConfigurationSnapshot | undefined {
    const snapshot = this.snapshot()
    if (snapshot === undefined || !snapshot.input.presets.some((option) => option.id === agentPreset)) return snapshot
    return this.stage({ ...snapshot.selection, agentPreset })
  }

  selectReasoning(index: number): ComposerConfigurationSnapshot | undefined {
    const snapshot = this.snapshot()
    if (snapshot === undefined) return undefined
    const bounded = Math.max(0, Math.min(snapshot.reasoning.length - 1, Math.round(index)))
    const effort = snapshot.reasoning[bounded]
    return effort === undefined ? snapshot : this.stage({ ...snapshot.selection, reasoningEffort: effort.id })
  }

  markSubmitted(): void {
    if (this.draft !== undefined) this.draft = { ...this.draft, submitted: true }
  }

  reset(): void {
    this.draft = undefined
  }

  private stage(selection: PromptConfiguration): ComposerConfigurationSnapshot | undefined {
    const input = this.input
    if (input === undefined) return undefined
    this.draft = { sessionId: input.sessionId, selection, submitted: false }
    return this.snapshot()
  }
}

export function configurationEquals(left: PromptConfiguration, right: PromptConfiguration): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
    && left.agentPreset === right.agentPreset
}

export function effortTone(id: string, index: number, count: number): EffortTone {
  if (id.toLowerCase() === 'off' || index === 0) return 'off'
  if (id.toLowerCase() === 'max' || id.toLowerCase() === 'maximum' || index === count - 1) return 'max'
  return 'high'
}

function normalizeSelection(
  requested: PromptConfiguration,
  input: ComposerConfigurationInput,
): PromptConfiguration | undefined {
  const model = findModel(input.models, requested.provider, requested.model)
    ?? findModel(input.models, input.current.provider, input.current.model)
    ?? input.models[0]
  const preset = input.presets.find((option) => option.id === requested.agentPreset)
    ?? input.presets.find((option) => option.id === input.current.agentPreset)
    ?? input.presets[0]
  if (model === undefined || preset === undefined) return undefined
  const reasoning = reasoningFor(model, input)
  const effort = reasoning.find((option) => option.id === requested.reasoningEffort)
    ?? reasoning.find((option) => option.id === input.current.reasoningEffort)
    ?? reasoning[0]
  if (effort === undefined) return undefined
  return {
    provider: model.provider,
    model: model.id,
    reasoningEffort: effort.id,
    agentPreset: preset.id,
  }
}

function findModel(
  models: readonly ModelConfigurationOption[],
  provider: string,
  model: string,
): ModelConfigurationOption | undefined {
  return models.find((option) => option.provider === provider && option.id === model)
}

export function modelsForSource(
  models: readonly ModelConfigurationOption[],
  provider: string,
): readonly ModelConfigurationOption[] {
  return models.filter((option) => option.provider === provider)
}

function reasoningFor(
  model: ModelConfigurationOption,
  input: ComposerConfigurationInput,
) {
  return model.reasoning.length > 0 ? model.reasoning : input.fallbackReasoning
}
