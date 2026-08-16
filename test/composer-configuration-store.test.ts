import { describe, expect, it } from 'vitest'

import { ComposerConfigurationStore, effortTone, modelsForSource } from '../src/webview/composer-configuration/store.js'
import type { ComposerConfigurationInput } from '../src/webview/composer-configuration/types.js'

describe('composer configuration store', () => {
  it('stages choices without changing the host-owned current configuration', () => {
    const store = new ComposerConfigurationStore()
    store.update(input())

    const model = store.selectModel('deepseek-official', 'deepseek-v4-pro')
    const preset = store.selectPreset('code')
    const effort = store.selectReasoning(2)

    expect(model?.selection.model).toBe('deepseek-v4-pro')
    expect(preset?.selection.agentPreset).toBe('code')
    expect(effort?.selection).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      agentPreset: 'code',
    })
    expect(effort?.dirty).toBe(true)
    expect(effort?.modeStartsNewConversation).toBe(true)
  })

  it('clears a submitted draft when the host state catches up', () => {
    const store = new ComposerConfigurationStore()
    store.update(input({ blank: true }))
    store.selectPreset('minimal')
    store.markSubmitted()

    const applied = store.update(input({
      blank: true,
      current: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'high',
        agentPreset: 'minimal',
      },
    }))

    expect(applied?.selection.agentPreset).toBe('minimal')
    expect(applied?.dirty).toBe(false)
  })

  it('carries only a submitted draft into the fresh session created for a mode change', () => {
    const store = new ComposerConfigurationStore()
    store.update(input())
    store.selectModel('deepseek-official', 'deepseek-v4-pro')
    store.selectPreset('code')
    store.markSubmitted()

    const freshSession = store.update(input({
      sessionId: 'session-2',
      blank: true,
      current: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'high',
        agentPreset: 'code',
      },
    }))

    expect(freshSession?.selection.model).toBe('deepseek-v4-pro')
    expect(freshSession?.selection.agentPreset).toBe('code')

    const unsubmitted = new ComposerConfigurationStore()
    unsubmitted.update(input())
    unsubmitted.selectModel('deepseek-official', 'deepseek-v4-pro')
    expect(unsubmitted.update(input({ sessionId: 'session-3' }))?.selection.model).toBe('deepseek-v4-flash')
  })

  it('maps effort stops to distinct visual tones', () => {
    expect(effortTone('off', 0, 3)).toBe('off')
    expect(effortTone('high', 1, 3)).toBe('high')
    expect(effortTone('max', 2, 3)).toBe('max')
  })

  it('switches source without duplicating the two model choices', () => {
    const store = new ComposerConfigurationStore()
    const configured = input({
      sources: [
        { id: 'deepseek-official', label: 'DeepSeek Official' },
        { id: 'packycode', label: 'PackyCode' },
      ],
      models: [
        ...models('deepseek-official'),
        ...models('packycode'),
      ],
    })
    store.update(configured)
    store.selectModel('deepseek-official', 'deepseek-v4-pro')

    const switched = store.selectSource('packycode')

    expect(switched?.selection).toMatchObject({ provider: 'packycode', model: 'deepseek-v4-pro' })
    expect(switched?.source.label).toBe('PackyCode')
    expect(modelsForSource(configured.models, switched!.selection.provider).map((model) => model.id)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ])
  })
})

function input(overrides: Partial<ComposerConfigurationInput> = {}): ComposerConfigurationInput {
  return {
    sessionId: 'session-1',
    connected: true,
    editable: true,
    blank: false,
    current: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      agentPreset: 'standard',
    },
    sources: [{ id: 'deepseek-official', label: 'DeepSeek Official' }],
    models: models('deepseek-official'),
    presets: [
      { id: 'standard', label: 'Standard' },
      { id: 'code', label: 'PTC' },
      { id: 'minimal', label: 'Minimal' },
      { id: 'cordis', label: 'Creator' },
    ],
    fallbackReasoning: reasoning(),
    ...overrides,
  }
}

function models(provider: string) {
  return [
    {
      provider,
      id: 'deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      reasoning: reasoning(),
    },
    {
      provider,
      id: 'deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      reasoning: reasoning(),
    },
  ]
}

function reasoning() {
  return [
    { id: 'off', label: 'Off' },
    { id: 'high', label: 'High' },
    { id: 'max', label: 'Maximum' },
  ]
}
