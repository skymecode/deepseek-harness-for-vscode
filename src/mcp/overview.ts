import type { McpServerConfiguration } from '../config/mcp.js'

export interface McpToolRef {
  readonly name: string
  readonly description?: string
}

export interface McpServerOverview {
  readonly serverName: string
  readonly transport: 'stdio' | 'streamable-http'
  readonly enabled: boolean
  readonly endpoint: string
  readonly toolCount: number
  readonly tools: readonly McpToolRef[]
}

export interface McpOverview {
  readonly servers: readonly McpServerOverview[]
  readonly enabledCount: number
  readonly toolCount: number
  readonly configError?: string
}

/** Groups registered `mcp__server__tool` names under their configured servers. */
export function buildMcpOverview(
  servers: readonly McpServerConfiguration[],
  tools: readonly McpToolRef[] = [],
  configError?: string,
): McpOverview {
  const mcpTools = tools.filter((tool) => tool.name.startsWith('mcp__'))
  const rows = servers.map((server): McpServerOverview => {
    const prefix = `mcp__${server.serverName}__`
    const matched = mcpTools.filter((tool) => tool.name.startsWith(prefix))
    return {
      serverName: server.serverName,
      transport: server.transport,
      enabled: server.enabled !== false,
      endpoint: server.transport === 'stdio'
        ? [server.command, ...(server.args ?? [])].filter((part): part is string => typeof part === 'string' && part !== '').join(' ')
        : (server.url ?? ''),
      toolCount: matched.length,
      tools: matched,
    }
  })

  return {
    servers: rows,
    enabledCount: rows.filter((row) => row.enabled).length,
    toolCount: mcpTools.length,
    ...(configError === undefined ? {} : { configError }),
  }
}

/** Short status line for the MCP QuickPick, OpenCode-style. */
export function mcpOverviewPlaceholder(overview: McpOverview, labels: {
  readonly empty: string
  readonly summary: (enabled: number, total: number, tools: number) => string
  readonly invalid: (error: string) => string
}): string {
  if (overview.configError !== undefined) return labels.invalid(overview.configError)
  if (overview.servers.length === 0) return labels.empty
  return labels.summary(overview.enabledCount, overview.servers.length, overview.toolCount)
}

/** One-line description for a configured server row. */
export function mcpServerDescription(server: McpServerOverview, labels: {
  readonly enabled: string
  readonly disabled: string
  readonly tools: (count: number) => string
}): string {
  const state = server.enabled ? labels.enabled : labels.disabled
  return `${server.transport} · ${state} · ${labels.tools(server.toolCount)}`
}
