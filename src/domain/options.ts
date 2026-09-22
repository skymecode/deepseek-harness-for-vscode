/** Stable option catalogs mirrored from the official DeepSeek Harness Web UI. */
export const MODEL_OPTIONS = [
  {
    id: 'deepseek-flash',
    label: 'DeepSeek V41 Flash',
    description: 'Faster responses for everyday coding and rapid iteration.',
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    description: 'Stronger capabilities for complex tasks and long reasoning chains.',
  },

] as const

export const REASONING_OPTIONS = [
  { id: 'off', label: 'Off', description: 'Disable explicit reasoning.' },
  { id: 'low', label: 'Low', description: 'Light reasoning for faster answers.' },
  { id: 'high', label: 'High', description: 'Default Harness reasoning effort.' },
  { id: 'max', label: 'Maximum', description: 'Use maximum reasoning effort for complex tasks.' },
] as const

export const AGENT_PRESET_OPTIONS = [
  {
    id: 'standard',
    label: 'Standard',
    description: 'Full coding agent with the standard tools and workflows.',
  },
  {
    id: 'ptc',
    label: 'PTC',
    description: 'Compose multi-step tool operations through the Code Mode SDK.',
  },
  {
    id: 'minimal',
    label: 'Minimal',
    description: 'Reduced toolset for small, direct coding tasks.',
  },
  {
    id: 'cordis',
    label: 'Creator',
    description: 'Inspect the runtime and create custom Agent Presets.',
  },
] as const

export type ModelId = typeof MODEL_OPTIONS[number]['id']
export type ReasoningEffort = typeof REASONING_OPTIONS[number]['id']
export type AgentPresetId = typeof AGENT_PRESET_OPTIONS[number]['id']

export function modelId(value: string | undefined): ModelId {
  return optionId(MODEL_OPTIONS, value, 'deepseek-flash')
}

export function reasoningEffort(value: string | undefined): ReasoningEffort {
  return optionId(REASONING_OPTIONS, value, 'high')
}

export function agentPresetId(value: string | undefined): AgentPresetId {
  return optionId(AGENT_PRESET_OPTIONS, value === 'code' ? 'ptc' : value, 'standard')
}

function optionId<const Options extends readonly { readonly id: string }[]>(
  options: Options,
  value: string | undefined,
  fallback: Options[number]['id'],
): Options[number]['id'] {
  return options.some((option) => option.id === value) ? value as Options[number]['id'] : fallback
}
