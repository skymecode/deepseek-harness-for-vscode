import { describe, expect, it, vi } from 'vitest'
import type { ConfigurationService } from '../src/config/configuration.js'
import { ConnectionSettingsService } from '../src/services/connection-settings-service.js'
import { KEYLESS_AUTHORIZATION } from '../src/services/connection-settings/mapping.js'
import type { CredentialStore } from '../src/security/credential-store.js'

interface HarnessDocument {
  deepseek: { value: Record<string, unknown>; user: Record<string, unknown>; revision: number }
  piAi: { value: { providers: Record<string, Record<string, unknown>> }; user: { providers: Record<string, Record<string, unknown>> }; revision: number }
  credentials: Record<string, string>
}

describe('ConnectionSettingsService', () => {
  it('preserves official Anthropic model metadata and credentials when editing the endpoint', async () => {
    const model = { name: 'Custom vision', input: ['text', 'image'], contextWindow: 128000, maxTokens: 8000, reasoning: true }
    const harness = fakeHarness({ relay: { displayName: 'Relay', api: 'anthropic-messages', baseURL: 'https://relay.example/anthropic', apiKeyEnv: 'SAVED_KEY', models: { custom: model } } }, { SAVED_KEY: 'synthetic-secret' })
    const service = serviceFor()
    await service.connect(harness.client as never)
    await service.apply({ provider: 'relay', name: 'Relay edited', baseUrl: 'https://relay.example/new', apiKey: '', models: ['custom'] })
    expect(harness.document.piAi.value.providers.relay).toMatchObject({ api: 'anthropic-messages', apiKeyEnv: 'SAVED_KEY', models: [{ id: 'custom', ...model }] })
    expect(harness.document.credentials.SAVED_KEY).toBe('synthetic-secret')
    expect(JSON.stringify(service.state)).not.toContain('synthetic-secret')
  })

  it('removes the keyless sentinel when adding a real credential', async () => {
    const harness = fakeHarness({ relay: { displayName: 'Relay', api: 'openai-completions', baseURL: 'https://relay.example/v1', headers: { authorization: KEYLESS_AUTHORIZATION, 'x-custom': 'keep' }, models: [] } })
    const service = serviceFor()
    await service.connect(harness.client as never)
    await service.apply({ provider: 'relay', name: 'Relay', baseUrl: 'https://relay.example/v1', apiKey: 'synthetic-secret', models: [] })
    expect(harness.document.piAi.value.providers.relay).toMatchObject({ apiKeyEnv: 'PROVIDER_RELAY_API_KEY', headers: { 'x-custom': 'keep' } })
    expect(harness.document.piAi.value.providers.relay?.headers).not.toHaveProperty('authorization')
  })

  it.each([undefined, 'chat-completions'])('migrates old official roots while respecting explicit protocol %s', async (protocol) => {
    const harness = fakeHarness()
    const saved = { baseURL: 'https://api.deepseek.com/v1', ...(protocol === undefined ? {} : { protocol }) }
    Object.assign(harness.document.deepseek.user, saved)
    Object.assign(harness.document.deepseek.value, saved)
    await serviceFor().connect(harness.client as never)
    expect(harness.document.deepseek.user.baseURL).toBe(protocol === undefined ? undefined : saved.baseURL)
  })

  it('creates Anthropic providers without fabricating models or DeepSeek compatibility flags', async () => {
    const harness = fakeHarness()
    const service = serviceFor()
    await service.connect(harness.client as never)
    await service.apply({ provider: '__new__', name: 'Anthropic relay', baseUrl: 'https://relay.example/anthropic', apiKey: 'synthetic-secret', api: 'anthropic-messages', models: [] })
    expect(harness.document.piAi.value.providers['anthropic-relay']).toMatchObject({ api: 'anthropic-messages', models: [] })
    expect(harness.document.piAi.value.providers['anthropic-relay']).not.toHaveProperty('compat')
    expect(service.state.providers.some((provider) => provider.id === 'anthropic-relay')).toBe(true)
  })

  it('creates a live pi-ai route and stores its key write-only', async () => {
    const harness = fakeHarness()
    const service = serviceFor()
    await service.connect(harness.client as never)

    const route = await service.apply({
      provider: '__new__',
      name: 'PackyCode',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-secret',
      models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    })

    expect(route).toBe('packycode')
    expect(harness.document.piAi.value.providers.packycode).toMatchObject({
      displayName: 'PackyCode',
      baseURL: 'https://relay.example.com/v1',
      api: 'openai-completions',
      apiKeyEnv: 'PROVIDER_PACKYCODE_API_KEY',
      compat: {
        thinkingFormat: 'deepseek',
        supportsReasoningEffort: true,
        supportsDeveloperRole: false,
      },
    })
    expect(harness.document.credentials.PROVIDER_PACKYCODE_API_KEY).toBe('sk-secret')
    expect(service.state.providers.find((provider) => provider.id === 'packycode')).toEqual({
      id: 'packycode',
      name: 'PackyCode',
      api: 'openai-completions',
      baseUrl: 'https://relay.example.com/v1',
      models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      modelContextWindows: {},
      apiKeyConfigured: true,
      credentialWritable: true,
      removable: true,
    })
    expect(JSON.stringify(service.state)).not.toContain('sk-secret')
  })

  it('creates a custom provider without requiring an API key', async () => {
    const harness = fakeHarness()
    const service = serviceFor()
    await service.connect(harness.client as never)

    const route = await service.apply({
      provider: '__new__',
      name: 'Local Llama',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      models: ['llama-3.1-8b'],
    })

    expect(route).toBe('local-llama')
    const profile = harness.document.piAi.value.providers['local-llama']
    expect(profile).toMatchObject({
      displayName: 'Local Llama',
      baseURL: 'http://127.0.0.1:8080/v1',
      // The keyless transport guard requires an `authorization` header to
      // stream at all (No API key for provider), so a keyless profile must
      // carry one — the endpoint ignores its value.
      headers: { authorization: KEYLESS_AUTHORIZATION },
    })
    // A keyless provider must not name an unset credential ref: the pi-ai
    // adapter resolves an absent apiKeyEnv as unauthenticated instead of
    // failing every request with MISSING_CREDENTIAL.
    expect(profile).not.toHaveProperty('apiKeyEnv')
    expect(harness.document.credentials.PROVIDER_LOCAL_LLAMA_API_KEY).toBeUndefined()
  })

  it('writes the endpoint-specific model ids a third-party provider exposes', async () => {
    const harness = fakeHarness()
    const service = serviceFor()
    await service.connect(harness.client as never)

    const route = await service.apply({
      provider: '__new__',
      name: 'Volcengine Ark',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: 'ark-secret',
      models: ['deepseek-v3.1-250828', 'ep-20250417-xxxxx'],
    })

    expect(route).toBe('volcengine-ark')
    expect(harness.document.piAi.value.providers['volcengine-ark']!.models).toEqual([
      { id: 'deepseek-v3.1-250828' },
      { id: 'ep-20250417-xxxxx' },
    ])
    expect(service.state.providers.find((provider) => provider.id === 'volcengine-ark')?.models)
      .toEqual(['deepseek-v3.1-250828', 'ep-20250417-xxxxx'])
  })

  it('writes a user-specified context window for a custom model, overriding the capacity table', async () => {
    const harness = fakeHarness()
    const service = serviceFor()
    await service.connect(harness.client as never)

    const route = await service.apply({
      provider: '__new__',
      name: 'Llama Swap',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      models: ['gemma-4-12b-heretic', 'qwen-3.8-27b'],
      // qwen-3.8-27b has a capacity-table entry (262_144); the explicit
      // override must still win because it reflects how the user actually
      // configured their local endpoint.
      modelContextWindows: { 'gemma-4-12b-heretic': 32_768, 'qwen-3.8-27b': 8_192 },
    })

    expect(route).toBe('llama-swap')
    expect(harness.document.piAi.value.providers['llama-swap']!.models).toEqual([
      { id: 'gemma-4-12b-heretic', contextWindow: 32_768 },
      { id: 'qwen-3.8-27b', contextWindow: 8_192 },
    ])
    expect(service.state.providers.find((provider) => provider.id === 'llama-swap')?.modelContextWindows)
      .toEqual({ 'gemma-4-12b-heretic': 32_768, 'qwen-3.8-27b': 8_192 })
  })

  it('drops context window overrides for ids the provider no longer exposes', async () => {
    const harness = fakeHarness()
    const service = serviceFor()
    await service.connect(harness.client as never)

    await service.apply({
      provider: '__new__',
      name: 'Llama Swap',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      models: ['gemma-4-12b-heretic'],
      modelContextWindows: { 'gemma-4-12b-heretic': 32_768, 'stale-removed-model': 16_384 },
    })

    expect(harness.document.piAi.value.providers['llama-swap']!.models).toEqual([
      { id: 'gemma-4-12b-heretic', contextWindow: 32_768 },
    ])
  })

  it('keeps an empty custom catalog instead of inventing DeepSeek models', async () => {
    const harness = fakeHarness()
    const service = serviceFor()
    await service.connect(harness.client as never)

    const route = await service.apply({
      provider: '__new__',
      name: 'Plain Relay',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-secret',
      models: [],
    })

    expect(route).toBe('plain-relay')
    expect(harness.document.piAi.value.providers['plain-relay']!.models).toEqual([])
    expect(service.state.providers.some((provider) => provider.id === route)).toBe(true)
  })

  it('does not guess custom input capabilities from a vision model name', async () => {
    const harness = fakeHarness()
    const service = serviceFor()
    await service.connect(harness.client as never)

    const route = await service.apply({
      provider: '__new__',
      name: 'Vision Relay',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-secret',
      models: ['deepseek-v4-flash-vision-exp', 'plain-text-model'],
    })

    expect(harness.document.piAi.value.providers[route]!.models).toEqual([
      { id: 'deepseek-v4-flash-vision-exp' },
      { id: 'plain-text-model' },
    ])
  })

  it('preserves old model declarations instead of guessing new capabilities', async () => {
    const harness = fakeHarness({
      'old-relay': {
        displayName: 'Old Relay',
        apiKeyEnv: 'PROVIDER_OLD_RELAY_API_KEY',
        api: 'openai-completions',
        baseURL: 'https://relay.example.com/v1',
        models: [
          { id: 'deepseek-v4-flash-vision-exp', reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
          { id: 'custom-vision-x', input: [], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
          { id: 'declared-vision-y', input: ['text'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
          { id: 'plain-model', reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
        ],
      },
    })
    const before = structuredClone(Object.values(harness.document.piAi.value.providers)[0]!.models)
    const service = serviceFor()
    await service.connect(harness.client as never)

    const models = harness.document.piAi.user.providers['old-relay']!['models'] as unknown[]
    expect(models).toEqual(before)
  })


  it('preserves custom reasoning maps and migrates only the official replay compatibility flag', async () => {
    const harness = fakeHarness({
      'volcengine-ark': {
        displayName: 'Volcengine Ark',
        apiKeyEnv: 'PROVIDER_VOLCENGINE_ARK_API_KEY',
        api: 'openai-completions',
        baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
        compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true, supportsDeveloperRole: false },
        models: [
          { id: 'deepseek-v4-flash', reasoningEfforts: { off: null, high: 'high', max: 'max' } },
          { id: 'custom-model', reasoningEfforts: { off: null, high: 'high', max: 'custom-max' } },
          'plain-string-model',
        ],
      },
    })
    const before = structuredClone(Object.values(harness.document.piAi.value.providers)[0]!.models)
    const service = serviceFor()
    await service.connect(harness.client as never)

    const models = harness.document.piAi.user.providers['volcengine-ark']!['models'] as unknown[]
    expect(models).toEqual(before)

    // The heal is idempotent: a second connect must not write again.
    const revision = harness.document.piAi.revision
    await service.connect(harness.client as never)
    expect(harness.document.piAi.revision).toBe(revision)
  })


  it('keeps a stored key and unknown profile fields when editing with a blank key', async () => {
    const harness = fakeHarness({
      packycode: {
        displayName: 'PackyCode',
        baseURL: 'https://old.example/v1',
        api: 'openai-completions',
        apiKeyEnv: 'PROVIDER_PACKYCODE_API_KEY',
        headers: { 'x-route': 'preserved' },
        models: deepSeekModels(),
      },
    }, { PROVIDER_PACKYCODE_API_KEY: 'stored-secret' })
    const service = serviceFor()
    await service.connect(harness.client as never)

    await service.apply({
      provider: 'packycode',
      name: 'Packy Relay',
      baseUrl: 'https://new.example/v1',
      apiKey: '',
      models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    })

    expect(harness.document.credentials.PROVIDER_PACKYCODE_API_KEY).toBe('stored-secret')
    expect(harness.document.piAi.value.providers.packycode).toMatchObject({
      displayName: 'Packy Relay',
      baseURL: 'https://new.example/v1',
      headers: { 'x-route': 'preserved' },
    })
  })

  it('keeps the official stored key when Apply submits a blank password field', async () => {
    const harness = fakeHarness({}, { DEEPSEEK_API_KEY: 'official-secret' })
    const service = serviceFor()
    await service.connect(harness.client as never)

    await service.apply({
      provider: 'deepseek-official',
      name: '',
      baseUrl: 'https://api.deepseek.com',
      apiKey: '',
      models: [],
    })

    expect(harness.document.credentials.DEEPSEEK_API_KEY).toBe('official-secret')
  })

  it('requires third-party endpoints to use a custom pi-ai provider', async () => {
    const harness = fakeHarness()
    const service = serviceFor()
    await service.connect(harness.client as never)

    await expect(service.apply({
      provider: 'deepseek-official',
      name: '',
      baseUrl: 'https://relay.example/v1',
      apiKey: '',
      models: [],
    })).rejects.toThrow('custom provider')
  })

  it('removes the custom profile and its managed credential', async () => {
    const harness = fakeHarness({
      packycode: {
        displayName: 'PackyCode',
        baseURL: 'https://relay.example/v1',
        api: 'openai-completions',
        apiKeyEnv: 'PROVIDER_PACKYCODE_API_KEY',
        models: deepSeekModels(),
      },
    }, { PROVIDER_PACKYCODE_API_KEY: 'stored-secret' })
    const service = serviceFor()
    await service.connect(harness.client as never)

    await service.remove('packycode')

    expect(harness.document.credentials.PROVIDER_PACKYCODE_API_KEY).toBeUndefined()
    expect(harness.document.piAi.value.providers.packycode).toBeUndefined()
    expect(service.state.providers.map((provider) => provider.id)).toEqual(['deepseek-official'])
  })

  it('keeps the credential when the profile deletion is rejected', async () => {
    const harness = fakeHarness({
      packycode: {
        displayName: 'PackyCode',
        baseURL: 'https://relay.example/v1',
        api: 'openai-completions',
        apiKeyEnv: 'PROVIDER_PACKYCODE_API_KEY',
        models: deepSeekModels(),
      },
    }, { PROVIDER_PACKYCODE_API_KEY: 'stored-secret' })
    const service = serviceFor()
    await service.connect(harness.client as never)

    // Simulate a stale-revision write: the profile deletion is refused before
    // the credential is ever touched.
    const settings = harness.client as { settingsMutate: () => Promise<unknown> }
    settings.settingsMutate = () => Promise.reject(new Error('settings-conflict'))

    await expect(service.remove('packycode')).rejects.toThrow('settings-conflict')
    expect(harness.document.credentials.PROVIDER_PACKYCODE_API_KEY).toBe('stored-secret')
    expect(harness.document.piAi.value.providers.packycode).toBeDefined()
  })

  it('finishes migrating a legacy key when its provider profile already exists', async () => {
    const harness = fakeHarness({
      packycode: {
        displayName: 'PackyCode',
        baseURL: 'https://relay.example/v1',
        api: 'openai-completions',
        apiKeyEnv: 'PROVIDER_PACKYCODE_API_KEY',
        models: deepSeekModels(),
      },
    })
    const service = serviceFor([{
      name: 'PackyCode',
      baseUrl: 'https://relay.example/v1',
      apiKey: 'legacy-secret',
    }])

    await service.connect(harness.client as never)

    expect(harness.document.credentials.PROVIDER_PACKYCODE_API_KEY).toBe('legacy-secret')
    expect(service.state.providers.find((provider) => provider.id === 'packycode')?.apiKeyConfigured).toBe(true)
  })

  it('migrates a legacy third-party official override into a pi-ai relay route', async () => {
    const harness = fakeHarness()
    const service = serviceFor([], 'https://relay.example/v1', 'legacy-secret')

    await service.connect(harness.client as never)

    expect(harness.document.piAi.value.providers['imported-relay-example']).toMatchObject({
      displayName: 'Imported relay.example',
      baseURL: 'https://relay.example/v1',
      api: 'openai-completions',
    })
    expect(harness.document.credentials.PROVIDER_IMPORTED_RELAY_EXAMPLE_API_KEY).toBe('legacy-secret')
  })
})

function serviceFor(
  legacyProviders: { name: string; baseUrl: string; apiKey: string }[] = [],
  legacyBaseUrl?: string,
  legacyKey?: string,
): ConnectionSettingsService {
  const configuration = {
    get: vi.fn(() => ({ provider: 'deepseek-official' })),
    setProvider: vi.fn(async () => undefined),
    getLegacyProviders: vi.fn(() => legacyProviders),
    getLegacyBaseUrl: vi.fn(() => legacyBaseUrl),
    clearLegacyProviders: vi.fn(async () => undefined),
    clearLegacyBaseUrl: vi.fn(async () => undefined),
  } as unknown as ConfigurationService
  const credentials = {
    getApiKey: vi.fn(async () => legacyKey),
    clearApiKey: vi.fn(async () => undefined),
  } as unknown as CredentialStore
  return new ConnectionSettingsService(configuration, credentials)
}

function fakeHarness(
  providers: Record<string, Record<string, unknown>> = {},
  credentials: Record<string, string> = {},
): {
  document: HarnessDocument
  client: Record<string, unknown>
} {
  const document: HarnessDocument = {
    deepseek: { value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, user: {}, revision: 0 },
    piAi: {
      value: { providers: structuredClone(providers) },
      user: { providers: structuredClone(providers) },
      revision: 0,
    },
    credentials: { ...credentials },
  }
  const describeSettings = () => ({
    writable: true,
    hasDocument: true,
    namespaces: [
      { ns: 'llm-deepseek', schema: {}, value: document.deepseek.value, user: document.deepseek.user, applies: 'live', secrets: [], revision: document.deepseek.revision },
      { ns: 'llm-pi-ai', schema: {}, value: document.piAi.value, user: document.piAi.user, applies: 'live', secrets: [], revision: document.piAi.revision },
    ],
  })
  const client = {
    settingsDescribe: () => Promise.resolve(describeSettings() as never),
    settingsMutate: (ns: string, ops: { op: 'set' | 'unset'; path: string[]; value?: unknown }[], _expectedRevision?: number) => {
      void _expectedRevision
      const section = ns === 'llm-pi-ai' ? document.piAi : document.deepseek
      for (const op of ops) {
        mutate(section.value, op.path, op.op, op.value)
        mutate(section.user, op.path, op.op, op.value)
      }
      section.revision += 1
      return Promise.resolve(describeSettings().namespaces.find((item) => item.ns === ns) as never)
    },
    credentialsDescribe: (refs: readonly string[]) => Promise.resolve(Object.fromEntries(refs.map((ref) => [ref, {
      configured: document.credentials[ref] !== undefined,
      writable: true,
      ...(document.credentials[ref] === undefined ? {} : { source: 'file' }),
    }])) as never),
    credentialsSet: (ref: string, value: string) => {
      document.credentials[ref] = value
      return Promise.resolve() as never
    },
    credentialsUnset: (ref: string) => {
      delete document.credentials[ref]
      return Promise.resolve() as never
    },
    llmListProviders: () => Promise.resolve([
      { id: 'deepseek-official', name: 'DeepSeek Official' },
      ...Object.entries(document.piAi.value.providers).map(([provider, profile]) => ({
        id: provider,
        name: String((profile as { displayName?: unknown }).displayName ?? provider),
      })),
    ] as never),
    llmListConfigurableProviders: () => Promise.resolve([
      { provider: 'deepseek-official', displayName: 'DeepSeek Official', settingsNs: 'llm-deepseek', settingsPath: [] },
      ...Object.entries(document.piAi.value.providers).map(([provider, profile]) => ({
        provider,
        displayName: String((profile as { displayName?: unknown }).displayName ?? provider),
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', provider],
        declared: true,
      })),
    ] as never),
    sessionModelCatalog: () => Promise.resolve({
      default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      routableProviders: ['deepseek-official'],
      groups: [
        { id: 'deepseek-official', name: 'DeepSeek Official', models: deepSeekModels() },
        ...Object.entries(document.piAi.value.providers).map(([id, profile]) => ({
          id,
          name: id,
          models: Array.isArray((profile as { models?: unknown }).models)
            ? ((profile as { models: unknown[] }).models).map((model) => ({ id: String((model as { id?: unknown })?.id ?? ''), name: id }))
            : deepSeekModels(),
        })),
      ],
      failures: [],
    } as never),
    llmDiscoverModels: () => Promise.resolve([] as never),
  }
  return { document, client }
}

function deepSeekModels(): { id: string; name: string }[] {
  return [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  ]
}

function mutate(root: object, path: string[], op: 'set' | 'unset', value: unknown): void {
  let current = root as Record<string, unknown>
  for (const key of path.slice(0, -1)) {
    const next = current[key]
    if (typeof next === 'object' && next !== null && !Array.isArray(next)) current = next as Record<string, unknown>
    else current = current[key] = {} as Record<string, unknown>
  }
  const key = path.at(-1)
  if (key === undefined) return
  if (op === 'unset') delete current[key]
  else current[key] = structuredClone(value)
}
