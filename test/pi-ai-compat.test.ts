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

    expect(parsed.providers?.packycode?.compat?.supportsDeveloperRole).toBe(false)
  })

  it('installs the guarded DeepSeek cross-provider tool replay normalization', () => {
    const packageJson = require.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json')
    const source = readFileSync(join(dirname(packageJson), 'lib', 'index.js'), 'utf8')
    expect(source).toContain('normalize only those tool-call messages')
    expect(source).toContain('thinkingSignature: "reasoning_content"')
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
