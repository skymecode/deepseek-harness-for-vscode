import { describe, expect, it } from 'vitest'
import { parseMcpServers, renderMcpRows, inspectMcpServers } from '../src/config/mcp.js'
import { renderOverlay } from '../src/runtime/runtime-overlay.js'

const stdio = { serverName: 'server', transport: 'stdio', command: 'node' }
describe('MCP profile configuration', () => {
  it('renders native transports and whole environment-backed values', () => {
    const servers = parseMcpServers(JSON.stringify([
      { ...stdio, args: ['path with spaces/server.js'], env: { TOKEN: '$env:MCP_TOKEN' }, maxInstructionBytes: 4096, reconnect: { maxAttempts: 3 } },
      { serverName: 'web', transport: 'streamable-http', url: 'http://localhost:3000/mcp', headers: { '1-key': '$env:MCP_HEADER' } },
    ]))
    const rows = renderMcpRows(servers)
    expect(rows).toContain('"TOKEN": !!js process.env.MCP_TOKEN')
    expect(rows).toContain('"1-key": !!js process.env.MCP_HEADER')
    expect(rows).toContain('maxAttempts: 3')
    expect(rows).toContain('maxInstructionBytes: 4096')
    expect(rows).toContain('args: ["path with spaces/server.js"]')
    expect(renderOverlay({ model: 'deepseek-flash', provider: 'deepseek-official', reasoningEffort: 'high', agentPreset: 'standard', permissionMode: 'workspace-write', webSearch: true, autoAttachSelection: true, experimentalAutoEffort: false, worktreeAutoMerge: 'never', mcpServers: servers }, '/tmp/gateway.mjs')).toContain("name: '@deepseek-ai/dsh-mcp-client'")
  })
  it.each([
    '{bad', '{}',
    JSON.stringify([{...stdio, command: ''}]),
    JSON.stringify([{...stdio, args: [1]}]),
    JSON.stringify([{...stdio, environ: {}}]),
    JSON.stringify([{serverName: 'web', transport: 'streamable-http', url: 'https://'}]),
    JSON.stringify([{serverName: 'web', transport: 'streamable-http', url: ['https://example.com/mcp']}]),
    JSON.stringify([{serverName: 'web', transport: 'streamable-http', url: 'https://user:secret@example.com'}]),
    JSON.stringify([{...stdio, env: {TOKEN: 123}}]),
    JSON.stringify([{...stdio, reconnect: {initialDelayMs: 40000}}]),
    JSON.stringify([{...stdio, toolCallTimeoutMs: 2147483648}]),
    JSON.stringify([stdio, stdio]),
  ])('rejects malformed settings atomically (%s)', raw => {
    expect(() => parseMcpServers(raw)).toThrow(/MCP/)
    expect(inspectMcpServers(raw)).toMatchObject({servers: [], error: expect.any(String)})
  })
  it('keeps disabled configuration but omits the runtime row', () => {
    const servers = parseMcpServers(JSON.stringify([{...stdio, enabled: false}]))
    expect(servers[0]?.command).toBe('node')
    expect(renderMcpRows(servers)).toBe('')
  })
  it('never echoes secret values in validation errors', () => {
    const value = [{serverName: 'web', transport: 'streamable-http', url: 'https://example.com', headers: {Authorization:'secret-value\r\nInjected: true'}}]
    const result = inspectMcpServers(JSON.stringify(value))
    expect(result.error).toContain('headers')
    expect(result.error).not.toContain('secret-value')
  })
})
