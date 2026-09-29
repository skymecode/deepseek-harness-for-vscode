import { describe, expect, it, vi } from 'vitest'
import { apply, gatewayUrl, registerLegacyCodePreset } from '../src/runtime/gateway-runtime-plugin.js'
import { registerOfficialConnectionCheck } from '../src/runtime/official-connection-check.js'

describe('headless Gateway runtime plugin', () => {
  it('registers an official draft connection probe without persisting credentials', async () => {
    let handler: ((request: { baseURL?: string; api?: string }, signal?: AbortSignal) => Promise<unknown>) | undefined
    const discoverModels = vi.fn(async () => [{ id: 'deepseek-flash' }])
    const dispose = vi.fn()
    const ctx = {
      get: (name: string) => name === 'llm'
        ? { registerModelDiscovery: vi.fn((_ns: string, callback: typeof handler) => { handler = callback; return dispose }) }
        : name === 'settings'
          ? { describe: () => [{ ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } }] }
          : name === 'credentials' ? { resolve: vi.fn(async () => ({ value: 'secret' })) } : undefined,
      on: vi.fn(),
    }
    // The helper delegates the actual HTTP operation back to DSH's discovery.
    const llm = { discoverModels: discoverModels as unknown as (ns: string, request: unknown, signal?: AbortSignal) => Promise<unknown[]> }
    const original = ctx.get
    ctx.get = (name: string) => name === 'llm' ? { ...llm, registerModelDiscovery: vi.fn((_ns: string, callback: typeof handler) => { handler = callback; return dispose }) } : original(name)
    registerOfficialConnectionCheck(ctx)
    await handler?.({ baseURL: 'https://api.deepseek.com/anthropic', api: 'openai-completions' }, AbortSignal.timeout(10))
    expect(discoverModels).toHaveBeenCalledWith('llm-pi-ai', {
      baseURL: 'https://api.deepseek.com', api: 'openai-completions', apiKey: 'secret',
    }, expect.any(AbortSignal))
    expect(ctx.on).toHaveBeenCalledWith('dispose', expect.any(Function))
  })

  it('keeps a user-declared code preset and releases an extension alias on disposal', async () => {
    const register = vi.fn().mockResolvedValue(vi.fn())
    const presets = { list: vi.fn().mockResolvedValue([{ id: 'code' }]), register }
    const plugins = [{ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }]
    const loader = { entries: () => [{ disabled: false, options: { name: '@deepseek-ai/dsh-agent-preset', config: { id: 'ptc', plugins } } }] }
    const on = vi.fn()
    const ctx = { get: (key: string) => key === 'agentPresets' ? presets : key === 'loader' ? loader : undefined, on }
    await registerLegacyCodePreset(ctx)
    expect(register).not.toHaveBeenCalled()
    presets.list.mockResolvedValue([{ id: 'ptc' }])
    await registerLegacyCodePreset(ctx)
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ id: 'code', plugins }))
    expect(on).toHaveBeenCalledWith('dispose', expect.any(Function))
  })

  it('provides loopback trust without registering a frontend fallback', () => {
    const provide = vi.fn()
    const context = {
      webServer: { port: 43123, register: vi.fn() },
      provide,
      get: vi.fn(() => undefined),
    }

    apply(context, { printUrl: false })

    expect(gatewayUrl(43123)).toBe('http://127.0.0.1:43123')
    expect(provide).toHaveBeenCalledWith('webRuntime', {
      lanAddresses: [],
      trustedHosts: [],
    })
    expect(context).not.toHaveProperty('plugin')
  })

  it('announces the launch-token URL and mounts the cookie exchange', () => {
    const connection = {
      authenticatedUrl: vi.fn((base: string) => `${base}/?token=launch-token`),
      authorizeIndex: vi.fn(() => true),
    }
    const register = vi.fn()
    const context = {
      webServer: { port: 43123, register },
      provide: vi.fn(),
      get: vi.fn((name: string) => (name === 'connection' ? connection : undefined)),
    }
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    try {
      apply(context)

      expect(register).toHaveBeenCalledTimes(2)
      const route = register.mock.calls.find(([route]) => route.path === '/')?.[0] as {
        kind: string
        path: string
        handler(req: unknown, res: { writeHead: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }): void
      }
      expect(route.kind).toBe('exact')
      expect(route.path).toBe('/')
      expect(write).toHaveBeenCalledWith('dsh gateway: http://127.0.0.1:43123/?token=launch-token\n')

      const res = { writeHead: vi.fn(), end: vi.fn() }
      route.handler({}, res)
      expect(connection.authorizeIndex).toHaveBeenCalledTimes(1)
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'cache-control': 'no-store' }))

      connection.authorizeIndex.mockReturnValue(false)
      route.handler({}, res)
      expect(res.writeHead).toHaveBeenCalledTimes(1)
    } finally {
      write.mockRestore()
    }
  })

  it('never announces a token-less URL when the connection service is absent', () => {
    const register = vi.fn()
    const context = {
      webServer: { port: 43123, register },
      provide: vi.fn(),
      get: vi.fn(() => undefined),
    }
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    try {
      apply(context)

      // No bare URL: since dsh 0.1.2 every /api route requires the signed
      // cookie, so a token-less announcement would 401 every client call.
      expect(register).not.toHaveBeenCalled()
      const announced = write.mock.calls.map((call) => String(call[0])).join('')
      expect(announced).not.toContain('dsh gateway: http://127.0.0.1:43123')
    } finally {
      write.mockRestore()
    }
  })
})
