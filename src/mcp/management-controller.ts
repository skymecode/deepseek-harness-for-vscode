import * as vscode from 'vscode'
import type { ConfigurationService } from '../config/configuration.js'
import { parseMcpServers, type McpServerConfiguration } from '../config/mcp.js'
import type { HarnessGatewayService } from '../gateway/harness-gateway-service.js'
import { McpConfigurationSync } from './configuration-sync.js'

type Choice = vscode.QuickPickItem & { action: string; server?: McpServerConfiguration }

/** Native VS Code controls; MCP protocol, execution and reconnect belong to DSH. */
export class McpManagementController implements vscode.Disposable {
  private readonly sync: McpConfigurationSync
  private readonly subscription: vscode.Disposable

  constructor(private readonly configuration: ConfigurationService, private readonly gateway: HarnessGatewayService, private readonly output: vscode.OutputChannel) {
    this.sync = new McpConfigurationSync(() => configuration.getMcpConfiguration(), async () => {
      await gateway.start()
      await gateway.mutateRuntime(async () => undefined, () => this.validateCurrent())
    })
    let raw = configuration.getMcpConfiguration().raw
    this.subscription = configuration.onDidChange(() => {
      const next = configuration.getMcpConfiguration().raw
      if (next === raw) return
      raw = next
      void this.sync.sync().catch(error => this.report(error))
    })
    const initial = configuration.getMcpConfiguration()
    if (initial.error) this.report(new Error(initial.error))
  }

  dispose(): void { this.subscription.dispose() }

  async show(): Promise<void> {
    try {
      const config = this.configuration.getMcpConfiguration()
      const choices: Choice[] = [
        { label: vscode.l10n.t('Add MCP server'), action: 'add' },
        { label: vscode.l10n.t('Show registered MCP tools'), action: 'tools' },
        { label: vscode.l10n.t('Edit MCP configuration (JSON)'), action: 'edit-all' },
        { label: vscode.l10n.t('Reload MCP after current turns finish'), action: 'reload' },
        { label: vscode.l10n.t('Show MCP logs'), action: 'logs' },
        ...config.servers.map(server => ({ label: server.serverName, description: `${server.transport} · ${server.enabled === false ? vscode.l10n.t('Disabled') : vscode.l10n.t('Enabled')}`, action: 'server', server })),
      ]
      const choice = await vscode.window.showQuickPick(choices, {
        title: vscode.l10n.t('MCP servers'),
        placeHolder: config.error ? vscode.l10n.t('Invalid MCP configuration: {0}', config.error) : vscode.l10n.t('Manage trusted local programs and remote MCP services'),
      })
      if (!choice) return
      if (choice.action === 'logs') { this.output.show(true); return }
      if (choice.action === 'tools') { await this.showTools(); return }
      if (choice.action === 'reload') {
        if (config.error) throw new Error(config.error)
        await this.gateway.start()
        await this.gateway.mutateRuntime(async () => undefined, () => this.validateCurrent())
        return
      }
      if (choice.action === 'edit-all') {
        const raw = await vscode.window.showInputBox({ title: vscode.l10n.t('MCP configuration (JSON array)'), value: config.raw, ignoreFocusOut: true, validateInput: validation })
        if (raw !== undefined) await this.save(parseMcpServers(raw), config.raw)
        return
      }
      if (config.error) throw new Error(config.error)
      if (choice.action === 'add') {
        const server = await this.addServer()
        if (server) await this.save([...config.servers, server], config.raw)
        return
      }
      const server = choice.server
      if (!server) return
      const action = await vscode.window.showQuickPick([
        { label: vscode.l10n.t('Edit MCP server'), id: 'edit' },
        { label: server.enabled === false ? vscode.l10n.t('Enable MCP server') : vscode.l10n.t('Disable MCP server'), id: 'toggle' },
        { label: vscode.l10n.t('Remove MCP server'), id: 'remove' },
      ], { title: server.serverName })
      if (!action) return
      let next = config.servers
      if (action.id === 'edit') {
        const value = await vscode.window.showInputBox({ title: vscode.l10n.t('MCP server (JSON object)'), value: JSON.stringify(server), ignoreFocusOut: true, validateInput: raw => validation(`[${raw}]`) })
        if (value === undefined) return
        const replacement = parseMcpServers(`[${value}]`)[0]!
        next = next.map(entry => entry.serverName === server.serverName ? replacement : entry)
      } else if (action.id === 'toggle') {
        next = next.map(entry => entry.serverName === server.serverName ? { ...entry, enabled: entry.enabled === false } : entry)
      } else next = next.filter(entry => entry.serverName !== server.serverName)
      await this.save(next, config.raw)
    } catch (error) { this.report(error) }
  }

  private async save(servers: readonly McpServerConfiguration[], expectedRaw: string): Promise<void> {
    if (this.configuration.getMcpConfiguration().raw !== expectedRaw) throw new Error(vscode.l10n.t('MCP configuration changed. Reopen the manager and try again.'))
    const raw = JSON.stringify(servers, null, 2)
    parseMcpServers(raw)
    await this.configuration.setMcpServers(raw)
    void vscode.window.showInformationMessage(vscode.l10n.t('MCP configuration saved. It will apply after current turns finish.'))
    await this.sync.sync()
  }

  private validateCurrent(): void {
    const config = this.configuration.getMcpConfiguration()
    if (config.error) throw new Error(config.error)
  }

  private async addServer(): Promise<McpServerConfiguration | undefined> {
    const selected = await vscode.window.showQuickPick([
      { label: vscode.l10n.t('Local program (stdio)'), transport: 'stdio' as const },
      { label: vscode.l10n.t('Remote service (Streamable HTTP)'), transport: 'streamable-http' as const },
    ], { title: vscode.l10n.t('Add MCP server'), placeHolder: vscode.l10n.t('MCP servers run outside the Agent file sandbox. Only add trusted servers.') })
    if (!selected) return undefined
    const serverName = await vscode.window.showInputBox({ title: vscode.l10n.t('MCP server name'), ignoreFocusOut: true,
      validateInput: name => /^[A-Za-z0-9_-]{1,32}$/u.test(name) ? undefined : vscode.l10n.t('Use 1–32 letters, numbers, underscores or hyphens.') })
    if (serverName === undefined) return undefined
    if (selected.transport === 'stdio') {
      const command = await vscode.window.showInputBox({ title: vscode.l10n.t('Program or executable path'), placeHolder: 'node / npx / uvx', ignoreFocusOut: true, validateInput: value => value.trim() ? undefined : vscode.l10n.t('A value is required.') })
      if (command === undefined) return undefined
      const args = await vscode.window.showInputBox({ title: vscode.l10n.t('Arguments (JSON string array)'), value: '[]', ignoreFocusOut: true,
        validateInput: raw => { try { parseMcpServers(JSON.stringify([{ serverName, transport: 'stdio', command, args: JSON.parse(raw) }])); return undefined } catch { return vscode.l10n.t('Enter a valid JSON array of strings.') } } })
      if (args === undefined) return undefined
      const env = await this.mapInput('env')
      if (env === undefined) return undefined
      return parseMcpServers(JSON.stringify([{ serverName, transport: 'stdio', command, args: JSON.parse(args), env }]))[0]
    }
    const url = await vscode.window.showInputBox({ title: vscode.l10n.t('MCP endpoint URL'), placeHolder: 'https://example.com/mcp', ignoreFocusOut: true,
      validateInput: value => validation(JSON.stringify([{ serverName, transport: 'streamable-http', url: value }])) })
    if (url === undefined) return undefined
    const headers = await this.mapInput('headers')
    if (headers === undefined) return undefined
    return parseMcpServers(JSON.stringify([{ serverName, transport: 'streamable-http', url, headers }]))[0]
  }

  private async mapInput(kind: 'env' | 'headers'): Promise<Record<string, string> | undefined> {
    const raw = await vscode.window.showInputBox({ title: kind === 'env' ? vscode.l10n.t('Environment variables (JSON object)') : vscode.l10n.t('HTTP headers (JSON object)'),
      prompt: vscode.l10n.t('Use $env:NAME for a whole environment-backed value. Bearer headers require the prefix in that environment variable.'),
      value: '{}', ignoreFocusOut: true,
      validateInput: value => {
        try {
          const map: unknown = JSON.parse(value)
          const server = kind === 'env' ? { serverName: 'check', transport: 'stdio', command: 'node', env: map } : { serverName: 'check', transport: 'streamable-http', url: 'https://example.com/mcp', headers: map }
          return validation(JSON.stringify([server]))
        } catch { return vscode.l10n.t('Enter a valid JSON object of string values.') }
      },
    })
    return raw === undefined ? undefined : JSON.parse(raw) as Record<string, string>
  }

  private async showTools(): Promise<void> {
    await this.gateway.ensureStarted()
    const tools = await this.gateway.providerControlClient().mcpTools()
    if (tools.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('No MCP tools registered. Check the server configuration and logs; resource-only servers may expose no tools.'))
      return
    }
    await vscode.window.showQuickPick(tools.map(tool => ({ label: tool.name, detail: tool.description })), {
      title: vscode.l10n.t('Registered MCP tools (not a connection health check)'),
      placeHolder: vscode.l10n.t('Ask the agent in chat to use a tool. Agent mode and permissions still apply.'), matchOnDetail: true,
    })
  }

  private report(error: unknown): void {
    void vscode.window.showErrorMessage(vscode.l10n.t('MCP: {0}', error instanceof Error ? error.message : String(error)))
  }
}

function validation(raw: string): string | undefined {
  try { parseMcpServers(raw); return undefined }
  catch (error) { return error instanceof Error ? error.message : 'Invalid MCP configuration.' }
}
