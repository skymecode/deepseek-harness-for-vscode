/** MCP server entries accepted by the extension's generated DSH profile overlay. */
export interface McpServerConfiguration {
  readonly serverName: string
  readonly transport: 'stdio' | 'streamable-http'
  readonly command?: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly toolCallTimeoutMs?: number
  readonly failOnStartupError?: boolean
  readonly maxInstructionBytes?: number
  readonly reconnect?: {
    readonly enabled?: boolean
    readonly initialDelayMs?: number
    readonly maxDelayMs?: number
    readonly maxAttempts?: number
  }
}

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/u
const MAP_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/u

/** Parses user settings defensively; invalid entries are ignored by design. */
export function parseMcpServers(raw: string | undefined): readonly McpServerConfiguration[] {
  if (raw === undefined || raw.trim() === '') return []
  let value: unknown
  try { value = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap((entry): McpServerConfiguration[] => {
    if (!isRecord(entry) || typeof entry.serverName !== 'string' || !SERVER_NAME.test(entry.serverName)
      || (entry.transport !== 'stdio' && entry.transport !== 'streamable-http') || seen.has(entry.serverName)) return []
    const command = typeof entry.command === 'string' && entry.command.trim() !== '' ? entry.command : undefined
    const url = typeof entry.url === 'string' && /^https?:\/\//u.test(entry.url) ? entry.url : undefined
    if (entry.transport === 'stdio' && command === undefined) return []
    if (entry.transport === 'streamable-http' && url === undefined) return []
    const args = Array.isArray(entry.args) && entry.args.every((item) => typeof item === 'string') ? entry.args : undefined
    const env = stringMap(entry.env)
    const headers = stringMap(entry.headers)
    const reconnect = reconnectConfig(entry.reconnect)
    seen.add(entry.serverName)
    return [{
      serverName: entry.serverName,
      transport: entry.transport,
      ...(command === undefined ? {} : { command }),
      ...(args === undefined ? {} : { args }),
      ...(typeof entry.cwd === 'string' && entry.cwd.trim() !== '' ? { cwd: entry.cwd } : {}),
      ...(env === undefined ? {} : { env }),
      ...(url === undefined ? {} : { url }),
      ...(headers === undefined ? {} : { headers }),
      ...(typeof entry.toolCallTimeoutMs === 'number' && Number.isInteger(entry.toolCallTimeoutMs) && entry.toolCallTimeoutMs > 0 ? { toolCallTimeoutMs: entry.toolCallTimeoutMs } : {}),
      ...(typeof entry.failOnStartupError === 'boolean' ? { failOnStartupError: entry.failOnStartupError } : {}),
      ...(positiveInt(entry.maxInstructionBytes) === undefined ? {} : { maxInstructionBytes: positiveInt(entry.maxInstructionBytes)! }),
      ...(reconnect === undefined ? {} : { reconnect }),
    }]
  })
}

/** Renders validated entries as DSH loader rows inside one `- insert` patch. */
export function renderMcpRows(entries: readonly McpServerConfiguration[]): string {
  return entries.map((entry) => {
    const lines = [
      `    - id: mcp-${entry.serverName}`,
      `      name: '@deepseek-ai/dsh-mcp-client'`,
      '      config:',
      `        serverName: ${yamlScalar(entry.serverName)}`,
      `        transport: ${entry.transport}`,
    ]
    if (entry.transport === 'stdio') {
      lines.push(`        command: ${yamlScalar(entry.command!)}`)
      if (entry.args?.length) lines.push(`        args: [${entry.args.map(yamlScalar).join(', ')}]`)
      if (entry.cwd) lines.push(`        cwd: ${yamlScalar(entry.cwd)}`)
    } else {
      lines.push(`        url: ${yamlScalar(entry.url!)}`)
    }
    appendMap(lines, 'env', entry.env)
    appendMap(lines, 'headers', entry.headers)
    if (entry.toolCallTimeoutMs !== undefined) lines.push(`        toolCallTimeoutMs: ${entry.toolCallTimeoutMs}`)
    if (entry.failOnStartupError !== undefined) lines.push(`        failOnStartupError: ${entry.failOnStartupError}`)
    if (entry.maxInstructionBytes !== undefined) lines.push(`        maxInstructionBytes: ${entry.maxInstructionBytes}`)
    if (entry.reconnect !== undefined) {
      lines.push('        reconnect:')
      if (entry.reconnect.enabled !== undefined) lines.push(`          enabled: ${entry.reconnect.enabled}`)
      if (entry.reconnect.initialDelayMs !== undefined) lines.push(`          initialDelayMs: ${entry.reconnect.initialDelayMs}`)
      if (entry.reconnect.maxDelayMs !== undefined) lines.push(`          maxDelayMs: ${entry.reconnect.maxDelayMs}`)
      if (entry.reconnect.maxAttempts !== undefined) lines.push(`          maxAttempts: ${entry.reconnect.maxAttempts}`)
    }
    return lines.join('\n')
  }).join('\n')
}

function appendMap(lines: string[], name: string, value: Readonly<Record<string, string>> | undefined): void {
  if (value === undefined || Object.keys(value).length === 0) return
  lines.push(`        ${name}:`)
  for (const [key, raw] of Object.entries(value)) {
    const envName = /^\$env:([A-Za-z_][A-Za-z0-9_]*)$/u.exec(raw)?.[1]
    lines.push(`          ${key}: ${envName === undefined ? yamlScalar(raw) : `!!js process.env.${envName}`}`)
  }
}

function yamlScalar(value: string): string { return JSON.stringify(value) }

function stringMap(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).filter(([key, item]) => MAP_KEY.test(key) && typeof item === 'string') as [string, string][]
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function reconnectConfig(value: unknown): McpServerConfiguration['reconnect'] | undefined {
  if (!isRecord(value)) return undefined
  const enabled = typeof value.enabled === 'boolean' ? value.enabled : undefined
  const initialDelayMs = positiveInt(value.initialDelayMs)
  const maxDelayMs = positiveInt(value.maxDelayMs)
  const maxAttempts = positiveInt(value.maxAttempts)
  if (enabled === undefined && initialDelayMs === undefined && maxDelayMs === undefined && maxAttempts === undefined) return undefined
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(initialDelayMs === undefined ? {} : { initialDelayMs }),
    ...(maxDelayMs === undefined ? {} : { maxDelayMs }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
