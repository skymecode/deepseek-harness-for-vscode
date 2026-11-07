import { describe, expect, it, vi } from 'vitest'
const config = vi.hoisted(() => ({ raw: '[]' }))
vi.mock('vscode', () => ({
  EventEmitter: class { event = () => ({dispose: () => {}}); fire() {}; dispose() {} },
  workspace: { onDidChangeConfiguration: () => ({dispose: () => {}}), getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'mcpServers' ? config.raw : fallback }) },
}))
import { ConfigurationService } from '../src/config/configuration.js'

describe('MCP last-valid runtime settings', () => {
  it('preserves the last validated server set if settings become invalid during a reload', () => {
    const service = new ConfigurationService()
    config.raw = '[{"serverName":"valid","transport":"stdio","command":"node"}]'
    expect(service.get().mcpServers).toHaveLength(1)
    config.raw = '{ invalid'
    expect(service.getMcpConfiguration()).toMatchObject({servers: [], error: expect.any(String)})
    expect(service.get()).toMatchObject({mcpServers: [{serverName:'valid',command:'node'}],mcpError:expect.any(String)})
    config.raw = '[]'
    expect(service.get().mcpServers).toEqual([])
    expect(service.get().mcpError).toBeUndefined()
    service.dispose()
  })
})
