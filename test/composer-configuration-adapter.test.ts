import { describe, expect, it } from 'vitest'

import type { HarnessConfiguration } from '../src/config/configuration.js'
import type { ActiveSessionView, HarnessWorkbenchState } from '../src/domain/workbench-state.js'
import {
  composerConfigurationInput,
  type ComposerConfigurationPayload,
} from '../src/webview/composer-configuration/adapter.js'

describe('composer configuration adapter', () => {
  it('maps the live Harness catalogs and excludes broken presets', () => {
    const result = composerConfigurationInput(payload({
      models: [{
        provider: 'deepseek-official',
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        description: 'Complex work',
        reasoning: [{ id: 'max', name: 'Max from host', description: 'Deep reasoning' }],
      }],
      model: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'max',
      },
    }, {
      presets: [
        { id: 'standard', trust: 'system', isDefault: true, name: 'Standard' },
        { id: 'broken', trust: 'user', isDefault: false, broken: 'Missing plugin' },
      ],
    }))

    expect(result).toMatchObject({
      sessionId: 'session-1',
      connected: true,
      editable: true,
      current: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'max',
        agentPreset: 'standard',
      },
    })
    expect(result?.models).toEqual([
      {
        provider: 'deepseek-official',
        id: 'deepseek-v4-flash',
        label: 'DeepSeek V4 Flash',
        description: 'Fast',
        reasoning: [
          { id: 'off', label: 'Off' },
          { id: 'high', label: 'High' },
          { id: 'max', label: 'Maximum' },
        ],
      },
      {
        provider: 'deepseek-official',
        id: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        description: 'Complex work',
        reasoning: [{ id: 'max', label: 'Maximum', description: 'Deep reasoning' }],
      },
    ])
    expect(result?.presets.map((preset) => preset.id)).toEqual(['standard'])
  })

  it('uses localized fallback catalogs while the live catalogs are loading', () => {
    const result = composerConfigurationInput(payload({ models: [] }, { presets: [] }))

    expect(result?.models[0]).toEqual({
      provider: 'deepseek-official',
      id: 'deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      description: 'Fast',
      reasoning: [
        { id: 'off', label: 'Off' },
        { id: 'high', label: 'High' },
        { id: 'max', label: 'Maximum' },
      ],
    })
    expect(result?.presets.map((preset) => preset.id)).toEqual(['standard', 'code'])
  })

  it('keeps source selection separate and exposes only Flash/Pro for each configured source', () => {
    const result = composerConfigurationInput(payload({
      models: [
        {
          provider: 'deepseek-official',
          id: 'deepseek-v4-flash',
          name: 'Official Flash',
          reasoning: [],
        },
        {
          provider: 'packycode',
          id: 'deepseek-v4-pro',
          name: 'Packy Pro',
          reasoning: [],
        },
        {
          provider: 'packycode',
          id: 'unrelated-model',
          name: 'Do not render',
          reasoning: [],
        },
      ],
    }, {}, {
      sources: [
        { id: 'deepseek-official', label: 'DeepSeek Official' },
        { id: 'packycode', label: 'PackyCode' },
      ],
    }))

    expect(result?.sources).toEqual([
      { id: 'deepseek-official', label: 'DeepSeek Official' },
      { id: 'packycode', label: 'PackyCode' },
    ])
    expect(result?.models.map(({ provider, id }) => ({ provider, id }))).toEqual([
      { provider: 'deepseek-official', id: 'deepseek-v4-flash' },
      { provider: 'deepseek-official', id: 'deepseek-v4-pro' },
      { provider: 'packycode', id: 'deepseek-v4-flash' },
      { provider: 'packycode', id: 'deepseek-v4-pro' },
    ])
  })

  it('locks configuration for sub-agents and while the current turn is running', () => {
    const subagent = composerConfigurationInput(payload({
      parentSessionId: 'parent-1',
      subagentMode: 'continuable',
    }))
    const withoutActive = payload()
    const state: HarnessWorkbenchState = {
      phase: withoutActive.state.phase,
      hasApiKey: withoutActive.state.hasApiKey,
      sessions: withoutActive.state.sessions,
      presets: withoutActive.state.presets,
    }

    expect(subagent?.editable).toBe(false)
    expect(composerConfigurationInput(payload({ running: true }))?.editable).toBe(false)
    expect(composerConfigurationInput({
      ...withoutActive,
      state,
    })).toBeUndefined()
  })
})

function payload(
  activeOverrides: Partial<ActiveSessionView> = {},
  stateOverrides: Partial<HarnessWorkbenchState> = {},
  fallbackOverrides: Partial<ComposerConfigurationPayload['fallbackOptions']> = {},
): ComposerConfigurationPayload {
  const configuration: HarnessConfiguration = {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
    agentPreset: 'standard',
    permissionMode: 'workspace-write',
    autoAttachSelection: true,
  }
  const active: ActiveSessionView = {
    id: 'session-1',
    title: 'Conversation',
    running: false,
    blank: false,
    agentPreset: 'standard',
    hasMore: false,
    models: [],
    messages: [],
    todos: [],
    skills: [],
    jobs: [],
    approvals: [],
    questions: [],
    subagentCount: 0,
    subagents: [],
    ...activeOverrides,
  }
  return {
    configuration,
    state: {
      phase: 'connected',
      hasApiKey: true,
      sessions: [],
      active,
      presets: [],
      ...stateOverrides,
    },
    fallbackOptions: {
      sources: [{ id: 'deepseek-official', label: 'DeepSeek Official' }],
      models: [
        { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: 'Fast' },
        { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'Complex work' },
      ],
      reasoning: [
        { id: 'off', label: 'Off' },
        { id: 'high', label: 'High' },
        { id: 'max', label: 'Maximum' },
      ],
      presets: [
        { id: 'standard', label: 'Standard' },
        { id: 'code', label: 'PTC' },
      ],
      ...fallbackOverrides,
    },
  }
}
