import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Config as PiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import { stream } from '@earendil-works/pi-ai/api/openai-completions'
import type { Context, Model } from '@earendil-works/pi-ai'

const relayModel: Model<'openai-completions'> = {
  id: 'deepseek-v4-pro',
  name: 'DeepSeek V4 Pro',
  api: 'openai-completions',
  provider: 'packycode',
  baseUrl: 'https://relay.example.com/v1',
  reasoning: true,
  thinkingLevelMap: { off: null, high: 'high', max: 'max' },
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 262_144,
  maxTokens: 32_768,
  compat: {
    thinkingFormat: 'deepseek',
    requiresReasoningContentOnAssistantMessages: true,
    supportsReasoningEffort: true,
    supportsDeveloperRole: false,
  },
}
const require = createRequire(import.meta.url)

describe('pi-ai relay compatibility', () => {
  it('accepts supportsDeveloperRole in the DSH provider schema', () => {
    const parsed = PiAiConfig({
      providers: {
        packycode: {
          api: 'openai-completions',
          baseURL: 'https://relay.example.com/v1',
          compat: {
            thinkingFormat: 'deepseek',
    requiresReasoningContentOnAssistantMessages: true,
            supportsReasoningEffort: true,
            supportsDeveloperRole: false,
          },
          models: [{
            id: 'deepseek-v4-pro',
            reasoningEfforts: { off: null, high: 'high', max: 'max' },
          }],
        },
      },
    })

    const providers = (parsed.providers as unknown as { get?: () => Record<string, { compat?: { supportsDeveloperRole?: boolean } }> }).get?.()
    expect(providers?.packycode?.compat?.supportsDeveloperRole).toBe(false)
  })

  it('replays cross-provider tools with the official reasoning-content compatibility flag', async () => {
    const controller = new AbortController()
    let payload: unknown
    const context: Context = {
      messages: [{
        role: 'assistant', api: 'openai-completions', provider: 'other-provider', model: 'other-model',
        content: [{ type: 'toolCall', id: 'call-1', name: 'read_file', arguments: { path: 'package.json' } }],
        stopReason: 'toolUse', timestamp: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      }, { role: 'toolResult', toolCallId: 'call-1', toolName: 'read_file', content: [{ type: 'text', text: '{}' }], isError: false, timestamp: 2 }],
    }
    await stream(relayModel, context, {
      apiKey: 'test-only', signal: controller.signal,
      onPayload: (request) => { payload = request; controller.abort() },
    }).result()
    expect(payload).toMatchObject({ messages: expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', reasoning_content: '', tool_calls: expect.any(Array) }),
      expect.objectContaining({ role: 'tool', content: '{}' }),
    ]) })
  })

  it('uses an explicit baseURL to probe a saved provider instead of returning its cached catalog', () => {
    const packageJson = require.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json')
    const source = readFileSync(join(dirname(packageJson), 'lib', 'index.js'), 'utf8')
    expect(source).toContain('request.provider !== void 0 && request.baseURL === void 0')
    expect(source).toContain('explicit connection probe')
  })

  it('serializes Harness instructions, tools and DeepSeek thinking for a relay', async () => {
    type ToolParameters = NonNullable<Context['tools']>[number]['parameters']
    const context: Context = {
      systemPrompt: 'You are a coding agent.',
      messages: [{ role: 'user', content: 'Read package.json.', timestamp: 1 }],
      tools: [{
        name: 'read_file',
        description: 'Read one workspace file.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        } as ToolParameters,
      }],
    }
    const controller = new AbortController()
    let payload: unknown
    const response = stream(relayModel, context, {
      apiKey: 'test-only',
      reasoningEffort: 'high',
      signal: controller.signal,
      onPayload: (request) => {
        payload = request
        controller.abort()
      },
    })

    await response.result()

    expect(payload).toMatchObject({
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'system', content: 'You are a coding agent.' },
        { role: 'user', content: 'Read package.json.' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'read_file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
      } }],
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    })
  })
})
