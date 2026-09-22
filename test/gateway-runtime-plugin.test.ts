import { describe, expect, it, vi } from 'vitest'
import { apply, gatewayUrl } from '../src/runtime/gateway-runtime-plugin.js'

describe('headless Gateway runtime plugin', () => {
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
