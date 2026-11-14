import { describe, expect, it } from 'vitest'

import { agentPresetTransition, promptConfiguration } from '../src/domain/prompt-configuration.js'
import { AGENT_PRESET_OPTIONS } from '../src/domain/options.js'

describe('prompt configuration', () => {
  it('accepts a complete model, reasoning, and preset tuple', () => {
    expect(promptConfiguration({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      agentPreset: 'code',
    })).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      agentPreset: 'code',
    })
  })

  it('rejects missing, empty, and non-string fields', () => {
    expect(promptConfiguration(undefined)).toBeUndefined()
    expect(promptConfiguration({ model: 'deepseek-v4-pro' })).toBeUndefined()
    expect(promptConfiguration({
      provider: 'deepseek-official',
      model: '',
      reasoningEffort: 'max',
      agentPreset: 'code',
    })).toBeUndefined()
    expect(promptConfiguration({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 3,
      agentPreset: 'code',
    })).toBeUndefined()
  })

  it('keeps, switches, or recreates a session according to the preset lock', () => {
    expect(agentPresetTransition(false, 'standard', 'standard')).toBe('keep-session')
    expect(agentPresetTransition(true, 'standard', 'code')).toBe('select-blank-session')
    expect(agentPresetTransition(false, 'standard', 'code')).toBe('reject-locked')
  })

  it('treats every ordered preset pair identically — no mode is special-cased', () => {
    const ids = AGENT_PRESET_OPTIONS.map((option) => option.id)
    for (const from of ids) {
      for (const to of ids) {
        if (from === to) {
          // Same mode never disturbs the conversation, blank or not.
          expect(agentPresetTransition(false, from, to), `${from} -> ${to}`).toBe('keep-session')
        } else {
          // Any mid-conversation switch opens a fresh session under the new
          // mode; a still-blank session just re-selects in place.
          expect(agentPresetTransition(false, from, to), `${from} -> ${to}`).toBe('reject-locked')
          expect(agentPresetTransition(true, from, to), `${from} -> ${to}`).toBe('select-blank-session')
        }
      }
    }
  })
})
