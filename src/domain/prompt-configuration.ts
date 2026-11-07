/**
 * Configuration staged in the composer and committed immediately before a
 * prompt. `reasoningEffort` is always a concrete provider tier id; when the
 * user chose the extension-side auto layer, `reasoningIntent` is
 * `'auto'` and the effort is resolved to a concrete tier at send time. This
 * keeps the extension's own "auto" out of the provider effort-id namespace.
 */
export interface PromptConfiguration {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string
  readonly agentPreset: string
  readonly reasoningIntent?: 'auto'
}

export type AgentPresetTransition = 'keep-session' | 'select-blank-session' | 'reject-locked'

/** Encodes the upstream rule that an Agent Preset is immutable after the first prompt. */
export function agentPresetTransition(
  blank: boolean,
  currentPreset: string,
  requestedPreset: string,
): AgentPresetTransition {
  if (currentPreset === requestedPreset) return 'keep-session'
  return blank ? 'select-blank-session' : 'reject-locked'
}

/** Treats Webview input as untrusted and accepts only a complete string tuple. */
export function promptConfiguration(value: unknown): PromptConfiguration | undefined {
  if (!isRecord(value)) return undefined
  const provider = nonEmptyString(value.provider)
  const model = nonEmptyString(value.model)
  const reasoningEffort = nonEmptyString(value.reasoningEffort)
  const agentPreset = nonEmptyString(value.agentPreset)
  if (provider === undefined || model === undefined || reasoningEffort === undefined || agentPreset === undefined) {
    return undefined
  }
  const reasoningIntent = value.reasoningIntent === 'auto' ? 'auto' : undefined
  return reasoningIntent === undefined
    ? { provider, model, reasoningEffort, agentPreset }
    : { provider, model, reasoningEffort, agentPreset, reasoningIntent }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
