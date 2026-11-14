import { describe, expect, it, vi } from 'vitest'
import { McpConfigurationSync, type McpConfigurationState } from '../src/mcp/configuration-sync.js'

const entry = { serverName: 'server', transport: 'stdio' as const, command: 'node' }
describe('MCP configuration synchronization', () => {
  it('coalesces save and configuration events and serializes later changes', async () => {
    let config: McpConfigurationState = { raw: '[]', servers: [] }
    let release!: () => void
    const gate = new Promise<void>(done => { release = done })
    const reload = vi.fn(async () => gate)
    const sync = new McpConfigurationSync(() => config, reload)
    config = { raw: 'next', servers: [entry] }
    const first = sync.sync()
    expect(sync.sync()).toBe(first)
    await Promise.resolve(); await Promise.resolve()
    expect(reload).toHaveBeenCalledTimes(1)
    config = { raw: 'disabled', servers: [{...entry, enabled: false}] }
    const second = sync.sync()
    expect(reload).toHaveBeenCalledTimes(1)
    release(); await Promise.all([first, second])
    expect(reload).toHaveBeenCalledTimes(2)
  })
  it('does not restart on invalid JSON and retries a failed reload', async () => {
    let config: McpConfigurationState = { raw: '[]', servers: [] }
    const reload = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const sync = new McpConfigurationSync(() => config, reload)
    config = { raw: 'bad', servers: [], error: 'MCP: invalid JSON.' }
    await expect(sync.sync()).rejects.toThrow('invalid JSON')
    expect(reload).not.toHaveBeenCalled()
    config = { raw: 'next', servers: [entry] }
    await expect(sync.sync()).rejects.toThrow('offline')
    await sync.sync()
    expect(reload).toHaveBeenCalledTimes(2)
  })
})
