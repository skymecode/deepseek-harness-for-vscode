import { describe, expect, it } from 'vitest'

import { localizedPresetDisplay } from '../src/domain/agent-preset-display.js'

const identity = (source: string): string => source

describe('localizedPresetDisplay', () => {
  it('replaces a built-in preset\'s harness-reported copy with the extension\'s own catalog text', () => {
    const preset = { id: 'ptc', trust: 'system' as const, name: '\u6807\u51c6\u6a21\u5f0f', description: '\u6807\u51c6\u63cf\u8ff0' }

    const result = localizedPresetDisplay(preset, identity)

    expect(result).toEqual({ ...preset, name: 'PTC', description: 'Compose multi-step tool operations through the Code Mode SDK.' })
  })

  it('resolves every known built-in preset id, including the harness\'s own id and this extension\'s legacy alias', () => {
    expect(localizedPresetDisplay({ id: 'standard', trust: 'system' as const }, identity).name).toBe('Standard')
    expect(localizedPresetDisplay({ id: 'code', trust: 'system' as const }, identity).name).toBe('PTC')
    expect(localizedPresetDisplay({ id: 'minimal', trust: 'system' as const }, identity).name).toBe('Minimal')
    expect(localizedPresetDisplay({ id: 'cordis', trust: 'system' as const }, identity).name).toBe('Creator')
  })

  it('runs the resolved copy through the supplied translator', () => {
    const preset = { id: 'standard', trust: 'system' as const }

    const result = localizedPresetDisplay(preset, (source) => `zh:${source}`)

    expect(result.name).toBe('zh:Standard')
    expect(result.description).toBe('zh:Full coding agent with the standard tools and workflows.')
  })

  it('never rewrites a user-authored preset\'s own name or description', () => {
    const preset = { id: 'my-custom-preset', trust: 'user' as const, name: 'My Preset', description: 'Whatever I want.' }

    const result = localizedPresetDisplay(preset, identity)

    expect(result).toEqual(preset)
  })

  it('falls back to the preset id when a user-authored preset has no name', () => {
    const preset = { id: 'my-custom-preset', trust: 'user' as const }

    const result = localizedPresetDisplay(preset, identity)

    expect(result.name).toBe('my-custom-preset')
    expect(result.description).toBeUndefined()
  })
})
