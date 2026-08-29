import type { AutoEffortSignals } from './session-effort.js'

/**
 * Extension-side model auto-selection (the "Auto" composer mode).
 *
 * The harness exposes no latency metadata, so each model is profiled from two
 * cheap, local signals: its id's naming hints and the reasoning tiers it
 * actually supports. A task is then matched to the fastest model that can
 * carry it — small fresh prompts go to `fast` models, heavy prompts to models
 * with deep reasoning (`high`/`max`), everything else stays on the current
 * selection to avoid needless switching.
 */

export type ModelSpeed = 'fast' | 'balanced' | 'powerful'

export interface ModelProfileInput {
  readonly id: string
  readonly reasoning?: { readonly efforts?: readonly { readonly id: string }[] }
}

/** Naming hints for the "fast" side of the profile. */
const FAST_HINTS: readonly string[] = [
  'flash', 'turbo', 'lite', 'mini', 'fast', 'quick', 'speed', 'nano', 'small', 'light', 'snap',
]

/** Naming hints for the "powerful" side of the profile. */
const POWERFUL_HINTS: readonly string[] = [
  'pro', 'max', 'plus', 'ultra', 'reason', 'thinking', 'large', 'opus', 'sonnet',
  'premium', 'r1', 'o1', 'o3', 'x1', 'xl', 'grande',
]

/** Whether the model exposes deep reasoning tiers. */
export function supportsDeepReasoning(efforts: readonly { readonly id: string }[] | undefined): boolean {
  if (efforts === undefined) return false
  return efforts.some((effort) => effort.id === 'high' || effort.id === 'max')
}

/**
 * Profiles a model from its id + reasoning support. Naming hints win when the
 * two sides disagree; otherwise the profile falls back to balanced, and a
 * model that only offers shallow reasoning is demoted away from `powerful`.
 */
export function modelSpeed(id: string, reasoning?: readonly { readonly id: string }[]): ModelSpeed {
  const lower = id.toLowerCase()
  let fast = 0
  let powerful = 0
  for (const hint of FAST_HINTS) if (lower.includes(hint)) fast += 1
  for (const hint of POWERFUL_HINTS) if (lower.includes(hint)) powerful += 1
  if (fast > powerful) return 'fast'
  if (powerful > fast) return supportsDeepReasoning(reasoning) ? 'powerful' : 'balanced'
  // No naming signal: deep reasoning is the only thing that separates a
  // powerful model from a balanced one.
  return supportsDeepReasoning(reasoning) ? 'powerful' : 'balanced'
}

/** Light-task heuristic shared with the effort resolver. */
export function taskWeight(signals: AutoEffortSignals): 'light' | 'heavy' | 'normal' {
  const light = signals.promptTokens < 1_000 && signals.attachmentCount === 0 && signals.historyTurns === 0
  const heavy = signals.promptTokens >= 8_000 || signals.attachmentCount > 0 || signals.historyTurns >= 4
  return light ? 'light' : heavy ? 'heavy' : 'normal'
}

/** The tier a task weight prefers. */
function preferredTier(weight: 'light' | 'heavy' | 'normal'): ModelSpeed {
  return weight === 'light' ? 'fast' : weight === 'heavy' ? 'powerful' : 'balanced'
}

/** Fallback preference order when the preferred tier is unavailable. */
const FALLBACK_ORDER: Readonly<Record<ModelSpeed, readonly ModelSpeed[]>> = {
  fast: ['fast', 'balanced', 'powerful'],
  balanced: ['balanced', 'fast', 'powerful'],
  powerful: ['powerful', 'balanced', 'fast'],
}

/**
 * Picks the model an "Auto" send should use, given the provider's models and
 * the task signals. Stability rule: the currently selected model is kept
 * whenever it already belongs to the preferred tier — light/normal tasks never
 * bounce between models on every keystroke, and heavy tasks only escalate to a
 * deep-reasoning model when one exists.
 */
export function pickAutoModel(
  models: readonly ModelProfileInput[],
  currentId: string | undefined,
  signals: AutoEffortSignals,
): string | undefined {
  if (models.length === 0) return currentId

  const weight = taskWeight(signals)
  const preferred = preferredTier(weight)

  // Normal tasks are never worth a model switch: keep the current selection
  // unless it is no longer advertised by the provider.
  if (weight === 'normal' && currentId !== undefined && models.some((model) => model.id === currentId)) {
    return currentId
  }

  // Group by speed tier.
  const byTier = new Map<ModelSpeed, ModelProfileInput[]>()
  for (const model of models) {
    const tier = modelSpeed(model.id, model.reasoning?.efforts)
    const bucket = byTier.get(tier)
    if (bucket === undefined) byTier.set(tier, [model])
    else bucket.push(model)
  }

  // Heavy tasks must land on a model that can actually reason deeply.
  const eligible = (model: ModelProfileInput): boolean =>
    weight !== 'heavy' || supportsDeepReasoning(model.reasoning?.efforts)

  for (const tier of FALLBACK_ORDER[preferred]) {
    const tierModels = (byTier.get(tier) ?? []).filter(eligible)
    if (tierModels.length === 0) continue
    if (tier === preferred && currentId !== undefined && tierModels.some((model) => model.id === currentId)) {
      // The current selection already fits the task; keep it to avoid churn.
      return currentId
    }
    const first = tierModels[0]
    if (first !== undefined) return first.id
  }

  return currentId
}
