import { AGENT_PRESET_OPTIONS } from './options.js'

export interface PresetDisplaySource {
  readonly id: string
  /** Kept optional for compatibility with pre-0.1.7 roster fixtures. */
  readonly trust?: 'system' | 'user'
  readonly isDefault?: boolean
  readonly broken?: string
  readonly name?: string
  readonly description?: string
}

export interface PresetDisplayText {
  readonly name: string
  readonly description?: string
}

// Old extension settings used `code`; the official preset id is now `ptc`.
const BUILT_IN_PRESET_ALIASES: Record<string, string> = { code: 'ptc' }

/**
 * Resolves display copy for one roster preset row. The bundled harness only
 * ships localized copy for a small set of built-in presets. For those rows
 * this substitutes the extension catalog copy; named user presets pass
 * through untouched.
 */
export function localizedPresetDisplay<T extends PresetDisplaySource>(
  preset: T,
  t: (source: string) => string,
): T & PresetDisplayText {
  const catalogId = BUILT_IN_PRESET_ALIASES[preset.id] ?? preset.id
  const builtIn = preset.trust !== 'user' && ['standard', 'ptc', 'minimal', 'cordis', 'code'].includes(preset.id)
  const catalogEntry = builtIn
    ? AGENT_PRESET_OPTIONS.find((option) => option.id === catalogId)
    : undefined
  if (catalogEntry === undefined) {
    return {
      ...preset,
      name: preset.name ?? preset.id,
      ...(preset.description === undefined ? {} : { description: preset.description }),
    }
  }
  return { ...preset, name: t(catalogEntry.label), description: t(catalogEntry.description) }
}
