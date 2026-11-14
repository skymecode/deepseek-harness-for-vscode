import { describe, expect, it, vi } from 'vitest'
import { inspectMcpServers } from '../src/config/mcp.js'
import { McpManagementController } from '../src/mcp/management-controller.js'
import { publicConfiguration } from '../src/ui/workbench-view-provider.js'
import type { ConfigurationService } from '../src/config/configuration.js'
import type { HarnessGatewayService } from '../src/gateway/harness-gateway-service.js'
import type { OutputChannel } from 'vscode'

const ui = vi.hoisted(() => ({ showQuickPick: vi.fn(), showInputBox: vi.fn(), showInformationMessage: vi.fn(), showErrorMessage: vi.fn() }))
vi.mock('vscode', () => ({ window: ui, l10n: {t:(s:string,...args:unknown[])=>s.replace(/\{(\d+)\}/gu, (_m,i)=>String(args[Number(i)]))} }))

function fixture(raw = '[]') {
  vi.clearAllMocks()
  let listener: () => void = () => {}
  const settings = {
    getMcpConfiguration: () => ({ raw, ...inspectMcpServers(raw) }),
    onDidChange: (callback: () => void) => { listener = callback; return {dispose:vi.fn()} },
    setMcpServers: vi.fn(async (value: string) => { raw = value; listener() }),
  }
  const gateway = { start: vi.fn(async () => {}), mutateRuntime: vi.fn(async (mutation: () => Promise<unknown>) => { await mutation() }), ensureStarted: vi.fn(async () => {}), providerControlClient: () => ({mcpTools: async () => [{name:'mcp__example__echo',description:'Echo'}]}) }
  const output = {show:vi.fn()}
  return { settings, gateway, controller: new McpManagementController(settings as unknown as ConfigurationService, gateway as unknown as HarnessGatewayService, output as unknown as OutputChannel) }
}

describe('native MCP management', () => {
  it('adds an HTTP server and reloads once despite the configuration event', async () => {
    const f=fixture()
    ui.showQuickPick.mockResolvedValueOnce({action:'add'}).mockResolvedValueOnce({transport:'streamable-http'})
    ui.showInputBox.mockResolvedValueOnce('docs').mockResolvedValueOnce('https://example.com/mcp').mockResolvedValueOnce('{"Authorization":"$env:MCP_AUTH"}')
    await f.controller.show()
    expect(f.settings.getMcpConfiguration().servers).toEqual([{serverName:'docs',transport:'streamable-http',url:'https://example.com/mcp',headers:{Authorization:'$env:MCP_AUTH'}}])
    expect(f.gateway.mutateRuntime).toHaveBeenCalledTimes(1)
    expect(ui.showErrorMessage).not.toHaveBeenCalled()
  })
  it('cancelling the wizard keeps the previous configuration and runtime', async () => {
    const f=fixture()
    ui.showQuickPick.mockResolvedValueOnce({action:'add'}).mockResolvedValueOnce(undefined)
    await f.controller.show()
    expect(f.settings.setMcpServers).not.toHaveBeenCalled()
    expect(f.gateway.mutateRuntime).not.toHaveBeenCalled()
  })
  it('invalid edits do not replace configured servers or restart the runtime', async () => {
    const f=fixture('[{"serverName":"existing","transport":"stdio","command":"node"}]')
    ui.showQuickPick.mockResolvedValueOnce({action:'edit-all'})
    ui.showInputBox.mockResolvedValueOnce('[{"serverName":"bad","transport":"stdio"}]')
    await f.controller.show()
    expect(f.settings.setMcpServers).not.toHaveBeenCalled()
    expect(ui.showErrorMessage).toHaveBeenCalled()
    expect(f.settings.getMcpConfiguration().servers).toHaveLength(1)
  })
  it('shows native tool names without invoking a tool', async () => {
    const f=fixture()
    ui.showQuickPick.mockResolvedValueOnce({action:'tools'}).mockResolvedValueOnce(undefined)
    await f.controller.show()
    expect(ui.showQuickPick).toHaveBeenLastCalledWith([{label:'mcp__example__echo',detail:'Echo'}],expect.objectContaining({title:expect.stringContaining('not a connection health check')}))
    expect(f.gateway.mutateRuntime).not.toHaveBeenCalled()
  })
  it('omits MCP secrets and launch arguments from chat webview state', () => {
    const value = publicConfiguration({model:'m',provider:'p',reasoningEffort:'high',agentPreset:'standard',permissionMode:'read-only',webSearch:false,autoAttachSelection:false,experimentalAutoEffort:false,worktreeAutoMerge:'never',mcpServers:[{serverName:'secret',transport:'stdio',command:'program',env:{KEY:'private-value'}}]})
    expect(value).not.toHaveProperty('mcpServers')
    expect(JSON.stringify(value)).not.toContain('private-value')
  })
})
