/** MCP server entries accepted by the extension's generated DSH profile overlay. */
export interface McpServerConfiguration {
  readonly enabled?: boolean
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
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u
const HEADER_KEY = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u
const FIELDS = new Set(['serverName', 'enabled', 'transport', 'command', 'args', 'cwd', 'env', 'url', 'headers', 'toolCallTimeoutMs', 'failOnStartupError', 'maxInstructionBytes', 'reconnect'])

/** Strict, atomic validation. Error messages contain field paths, never secret values. */
export function parseMcpServers(raw: string | undefined): readonly McpServerConfiguration[] {
  let value: unknown
  try { value = JSON.parse(raw?.trim() || '[]') } catch { throw new Error('MCP: invalid JSON.') }
  if (!Array.isArray(value)) throw new Error('MCP: expected a JSON array.')
  const seen = new Set<string>()
  return value.map((entry, index): McpServerConfiguration => {
    const at = `MCP[${index}]`
    const invalid = (field: string, reason: string): never => { throw new Error(`${at}.${field}: ${reason}`) }
    if (!isRecord(entry)) return invalid('server', 'expected an object')
    for (const key of Object.keys(entry)) if (!FIELDS.has(key)) invalid('server', 'unknown field; check the supported configuration fields')
    if (typeof entry.serverName !== 'string' || !SERVER_NAME.test(entry.serverName)) invalid('serverName', 'use 1–32 letters, numbers, underscores or hyphens')
    const serverName = entry.serverName as string
    if (seen.has(serverName)) invalid('serverName', 'duplicate server name')
    seen.add(serverName)
    if (entry.transport !== 'stdio' && entry.transport !== 'streamable-http') invalid('transport', 'use stdio or streamable-http')
    for (const key of ['enabled', 'failOnStartupError']) if (entry[key] !== undefined && typeof entry[key] !== 'boolean') invalid(key, 'expected a boolean')
    if (entry.transport === 'stdio') {
      if (typeof entry.command !== 'string' || entry.command.trim() === '') invalid('command', 'required for stdio')
      if (entry.url !== undefined || entry.headers !== undefined) invalid('transport', 'url/headers belong to streamable-http')
    } else {
      if (typeof entry.url !== 'string') invalid('url', 'expected a string')
      let url: URL
      try { url = new URL(entry.url as string) } catch { return invalid('url', 'expected an absolute HTTP(S) URL') }
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) invalid('url', 'use HTTP(S), without user info or fragment')
      if (entry.command !== undefined || entry.args !== undefined || entry.cwd !== undefined || entry.env !== undefined) invalid('transport', 'command/args/cwd/env belong to stdio')
    }
    if (entry.args !== undefined && (!Array.isArray(entry.args) || !entry.args.every(item => typeof item === 'string'))) invalid('args', 'expected an array of strings')
    if (entry.cwd !== undefined && (typeof entry.cwd !== 'string' || !entry.cwd.trim())) invalid('cwd', 'expected a non-empty path')
    for (const key of ['env', 'headers']) {
      const map = entry[key]
      if (map === undefined) continue
      if (!isRecord(map)) invalid(key, 'expected an object of string values')
      for (const [name, item] of Object.entries(map as Record<string, unknown>)) {
        if (!(key === 'env' ? ENV_KEY : HEADER_KEY).test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) invalid(key, 'invalid field name')
        if (typeof item !== 'string') invalid(key, 'all values must be strings')
        if (key === 'headers' && /[\r\n]/u.test(item as string)) invalid(key, 'header values must not contain line breaks')
      }
    }
    for (const key of ['toolCallTimeoutMs', 'maxInstructionBytes']) if (entry[key] !== undefined && !boundedInt(entry[key])) invalid(key, 'expected an integer from 1 to 2147483647')
    if (entry.reconnect !== undefined) {
      if (!isRecord(entry.reconnect)) invalid('reconnect', 'expected an object')
      const reconnect = entry.reconnect as Record<string, unknown>
      for (const key of Object.keys(reconnect)) if (!['enabled', 'initialDelayMs', 'maxDelayMs', 'maxAttempts'].includes(key)) invalid('reconnect', 'unknown field')
      if (reconnect.enabled !== undefined && typeof reconnect.enabled !== 'boolean') invalid('reconnect.enabled', 'expected a boolean')
      for (const key of ['initialDelayMs', 'maxDelayMs', 'maxAttempts']) if (reconnect[key] !== undefined && !boundedInt(reconnect[key])) invalid(`reconnect.${key}`, 'expected an integer from 1 to 2147483647')
      if (Number(reconnect.initialDelayMs ?? 500) > Number(reconnect.maxDelayMs ?? 30000)) invalid('reconnect', 'initialDelayMs must not exceed maxDelayMs')
    }
    return { ...entry, serverName } as unknown as McpServerConfiguration
  })
}

export function inspectMcpServers(raw: string | undefined): { servers: readonly McpServerConfiguration[]; error?: string } {
  try { return { servers: parseMcpServers(raw) } }
  catch (error) { return { servers: [], error: error instanceof Error ? error.message : 'Invalid MCP configuration.' } }
}

function boundedInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647
}

/** Renders validated entries as DSH loader rows inside one `- insert` patch. */
export function renderMcpRows(entries: readonly McpServerConfiguration[]): string {
  return entries.filter(entry => entry.enabled !== false).map((entry) => {
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
    lines.push(`          ${JSON.stringify(key)}: ${envName === undefined ? yamlScalar(raw) : `!!js process.env.${envName}`}`)
  }
}

function yamlScalar(value: string): string { return JSON.stringify(value) }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
