import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'

/** Read-only global registry view. Registration is not a connection health check. */
export function registerMcpToolCatalog(ctx: {
  get(name: string): unknown
  webServer: { register(route: { kind: 'exact'; path: string; handler(req: IncomingMessage, res: ServerResponse): void }): unknown }
}, connection: { authorizeIndex(req: IncomingMessage, res: ServerResponse): boolean }): void {
  ctx.webServer.register({ kind: 'exact', path: '/api/vscode.mcp-tools', handler: (req, res) => {
    if (!connection.authorizeIndex(req, res)) return
    if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
    const tools = ctx.get('tools') as ToolRuntime | undefined
    try {
      if (!tools) throw new Error('Registry unavailable')
      const items = tools.schemas().filter(tool => tool.name.startsWith('mcp__'))
        .map(({ name, description }) => ({ name, description }))
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(items))
    } catch {
      res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: 'MCP tool registry unavailable.' }))
    }
  } })
}
