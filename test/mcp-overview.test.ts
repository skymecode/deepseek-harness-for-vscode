import { describe, expect, it } from 'vitest'
import {
  buildMcpOverview,
  mcpOverviewPlaceholder,
  mcpServerDescription,
} from '../src/mcp/overview.js'
import { matchExtensionSlashCommand } from '../src/domain/workbench-state.js'

describe('buildMcpOverview', () => {
  it('groups registered tools under matching configured servers', () => {
    const overview = buildMcpOverview(
      [
        { serverName: 'docs', transport: 'streamable-http', url: 'https://example.com/mcp' },
        { serverName: 'local', transport: 'stdio', command: 'node', args: ['server.mjs'], enabled: false },
      ],
      [
        { name: 'mcp__docs__search', description: 'Search docs' },
        { name: 'mcp__docs__fetch', description: 'Fetch page' },
        { name: 'mcp__other__x', description: 'Unconfigured' },
      ],
    )
    expect(overview.enabledCount).toBe(1)
    expect(overview.toolCount).toBe(3)
    expect(overview.servers).toEqual([
      {
        serverName: 'docs',
        transport: 'streamable-http',
        enabled: true,
        endpoint: 'https://example.com/mcp',
        toolCount: 2,
        tools: [
          { name: 'mcp__docs__search', description: 'Search docs' },
          { name: 'mcp__docs__fetch', description: 'Fetch page' },
        ],
      },
      {
        serverName: 'local',
        transport: 'stdio',
        enabled: false,
        endpoint: 'node server.mjs',
        toolCount: 0,
        tools: [],
      },
    ])
  })

  it('keeps config errors visible in the overview placeholder', () => {
    const overview = buildMcpOverview([], [], 'MCP: invalid JSON.')
    expect(mcpOverviewPlaceholder(overview, {
      empty: 'empty',
      summary: () => 'summary',
      invalid: (error) => `bad:${error}`,
    })).toBe('bad:MCP: invalid JSON.')
  })

  it('formats OpenCode-style server and summary lines', () => {
    const overview = buildMcpOverview(
      [{ serverName: 'docs', transport: 'streamable-http', url: 'https://example.com/mcp' }],
      [{ name: 'mcp__docs__search' }],
    )
    expect(mcpOverviewPlaceholder(overview, {
      empty: 'empty',
      summary: (enabled, total, tools) => `${enabled}/${total}/${tools}`,
      invalid: (error) => error,
    })).toBe('1/1/1')
    expect(mcpServerDescription(overview.servers[0]!, {
      enabled: 'Enabled',
      disabled: 'Disabled',
      tools: (count) => `${count} tools registered`,
    })).toBe('streamable-http · Enabled · 1 tools registered')
  })
})

describe('matchExtensionSlashCommand', () => {
  it('matches bare extension slash commands including /mcp', () => {
    expect(matchExtensionSlashCommand('/mcp')).toBe('mcp')
    expect(matchExtensionSlashCommand('  /model  ')).toBe('model')
    expect(matchExtensionSlashCommand('/mcp now')).toBeUndefined()
    expect(matchExtensionSlashCommand('/compact')).toBeUndefined()
  })
})
