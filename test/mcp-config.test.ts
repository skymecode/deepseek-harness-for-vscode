import { describe, expect, it } from 'vitest'
import { parseMcpServers, renderMcpRows } from '../src/config/mcp.js'
import { renderOverlay } from '../src/runtime/runtime-overlay.js'

describe('MCP profile overlay configuration', () => {
  it('renders stdio and HTTP servers with environment-backed values', () => {
    const servers = parseMcpServers(JSON.stringify([
      { serverName: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: '$env:GITHUB_TOKEN' }, maxInstructionBytes: 4096, reconnect: { enabled: true, maxAttempts: 3 } },
      { serverName: 'web', transport: 'streamable-http', url: 'http://127.0.0.1:3000/mcp', headers: { Authorization: '$env:MCP_TOKEN' } },
    ]))
    const rows = renderMcpRows(servers)
    expect(rows).toContain("serverName: \"github\"")
    expect(rows).toContain('GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN')
    expect(rows).toContain('maxInstructionBytes: 4096')
    expect(rows).toContain('maxAttempts: 3')
    expect(rows).toContain('transport: streamable-http')
    expect(rows).toContain('Authorization: !!js process.env.MCP_TOKEN')
    const overlay = renderOverlay({ model: 'deepseek-flash', provider: 'deepseek-official', reasoningEffort: 'high', agentPreset: 'standard', permissionMode: 'workspace-write', webSearch: true, autoAttachSelection: true, experimentalAutoEffort: false, worktreeAutoMerge: 'never', mcpServers: servers }, '/tmp/gateway.mjs')
    expect(overlay).toContain("name: '@deepseek-ai/dsh-mcp-client'")
  })

  it('drops invalid and duplicate server entries', () => {
    const servers = parseMcpServers(JSON.stringify([
      { serverName: 'github', transport: 'stdio', command: 'npx' },
      { serverName: 'github', transport: 'stdio', command: 'other' },
      { serverName: 'bad name', transport: 'stdio', command: 'npx' },
      { serverName: 'web', transport: 'streamable-http', url: 'ftp://invalid' },
    ]))
    expect(servers.map((server) => server.serverName)).toEqual(['github'])
  })
})
