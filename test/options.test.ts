import { describe, expect, it } from 'vitest'
import {
  AGENT_PRESET_OPTIONS,
  MODEL_OPTIONS,
  REASONING_OPTIONS,
  agentPresetId,
  modelId,
  reasoningEffort,
} from '../src/domain/options.js'

describe('official Harness option catalogs', () => {
  it('contains the current official DeepSeek routes', () => {
    expect(MODEL_OPTIONS.map((item) => item.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
  })

  it('contains the official reasoning and preset ids', () => {
    expect(REASONING_OPTIONS.map((item) => item.id)).toEqual(['off', 'low', 'high', 'max'])
    expect(AGENT_PRESET_OPTIONS.map((item) => item.id)).toEqual(['standard', 'ptc', 'minimal', 'cordis'])
  })

  it('falls back safely when settings contain stale values', () => {
    expect(modelId('unknown')).toBe('deepseek-flash')
    expect(reasoningEffort('unknown')).toBe('high')
    expect(agentPresetId('code')).toBe('ptc')
    expect(agentPresetId('unknown')).toBe('standard')
  })
})
