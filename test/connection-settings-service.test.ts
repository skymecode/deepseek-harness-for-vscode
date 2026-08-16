import { describe, expect, it, vi } from 'vitest'
import type { ConfigurationService } from '../src/config/configuration.js'
import { ConnectionSettingsService } from '../src/services/connection-settings-service.js'
import type { CredentialStore } from '../src/security/credential-store.js'

interface HarnessDocument {
  deepseek: { value: Record<string, unknown>; user: Record<string, unknown>; revision: number }
  piAi: { value: { providers: Record<string, Record<string, unknown>> }; user: { providers: Record<string, Record<string, unknown>> }; revision: number }
  credentials: Record<string, string>
}

describe('ConnectionSettingsService', () => {
  it('creates a live pi-ai route and stores its key write-only', async () => {
    const harness = fakeHarness()
    const service = serviceFor()
    await service.connect(harness.client as never)

    const route = await service.apply({
      provider: '__new__',
      name: 'PackyCode',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-secret',
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
      baseUrl: 'https://relay.example.com/v1',
      apiKeyConfigured: true,
      credentialWritable: true,
      removable: true,
    })
    expect(JSON.stringify(service.state)).not.toContain('sk-secret')
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
    })).rejects.toThrow('custom provider')
  })

  it('removes the managed credential before removing a custom profile', async () => {
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
      compat: { thinkingFormat: 'deepseek', supportsDeveloperRole: false },
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
  const ok = <T>(value: T) => Promise.resolve({ rpcId: 'test', result: { ok: true as const, value } })
  const describeSettings = () => ({
    writable: true,
    hasDocument: true,
    namespaces: [
      { ns: 'llm-deepseek', schema: {}, value: document.deepseek.value, user: document.deepseek.user, applies: 'live', secrets: [], revision: document.deepseek.revision },
      { ns: 'llm-pi-ai', schema: {}, value: document.piAi.value, user: document.piAi.user, applies: 'live', secrets: [], revision: document.piAi.revision },
    ],
  })
  const client = {
    settings: {
      describe: () => ok(describeSettings()),
      mutate: (payload: { ns: string; ops: { op: 'set' | 'unset'; path: string[]; value?: unknown }[] }) => {
        const section = payload.ns === 'llm-pi-ai' ? document.piAi : document.deepseek
        for (const op of payload.ops) {
          mutate(section.value, op.path, op.op, op.value)
          mutate(section.user, op.path, op.op, op.value)
        }
        section.revision += 1
        return ok(describeSettings().namespaces.find((item) => item.ns === payload.ns))
      },
    },
    credentials: {
      describe: ({ refs }: { refs: string[] }) => ok({
        credentials: Object.fromEntries(refs.map((ref) => [ref, {
          configured: document.credentials[ref] !== undefined,
          writable: true,
          ...(document.credentials[ref] === undefined ? {} : { source: 'file' }),
        }])),
      }),
      set: ({ ref, value }: { ref: string; value: string }) => {
        document.credentials[ref] = value
        return ok({})
      },
      unset: ({ ref }: { ref: string }) => {
        delete document.credentials[ref]
        return ok({})
      },
    },
    llm: {
      providers: () => ok({ providers: [
        { provider: 'deepseek-official', displayName: 'DeepSeek Official', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
        ...Object.entries(document.piAi.value.providers).map(([provider, profile]) => ({
          provider,
          displayName: String(profile.displayName ?? provider),
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', provider],
          active: true,
          declared: true,
        })),
      ] }),
      models: () => ok({
        groups: [
          { id: 'deepseek-official', name: 'DeepSeek Official', models: deepSeekModels() },
          ...Object.keys(document.piAi.value.providers).map((id) => ({ id, name: id, models: deepSeekModels() })),
        ],
        failures: [],
      }),
    },
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
