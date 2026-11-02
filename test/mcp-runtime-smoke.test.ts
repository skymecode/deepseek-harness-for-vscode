import { createServer } from 'node:http'
import { resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { SessionPromptRequest } from '../src/gateway/domain-api.js'
import { bootSmokeRuntime } from './helpers/runtime-smoke.js'

describe.runIf(process.env.DSH_RUNTIME_SMOKE === '1')('MCP through the real DSH runtime', () => {
  it.each(['stdio', 'streamable-http'] as const)('discovers and calls a %s tool through native DSH', async (transport) => {
    let mcpCalls = 0
    const mcp = createServer(async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
      if (request.headers['x-api-key'] !== 'fixture-token') { response.writeHead(401); response.end(); return }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string; params?: { arguments?: { text?: string } } }
      if (message.id === undefined) { response.writeHead(202); response.end(); return }
      let result: unknown
      if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      else if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo fixture', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }
      else if (message.method === 'tools/call') { mcpCalls++; result = { content: [{ type: 'text', text: 'MCP verified: ' + message.params?.arguments?.text }] } }
      else result = {}
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
    await new Promise<void>(done => mcp.listen(0, '127.0.0.1', done))
    let listed = false
    let returned = false
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: { name: string }[]; messages?: unknown[] }
      listed ||= body.tools?.some(tool => tool.name === 'mcp__fixture__echo') === true
      returned ||= JSON.stringify(body.messages).includes('MCP verified: local-only')
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      event('message_start', { message: { id: randomUUID(), type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], usage: { input_tokens: 3, output_tokens: 0 } } })
      event('content_block_start', { index: 0, content_block: returned ? { type: 'text', text: '' } : { type: 'tool_use', id: 'echo-call', name: 'mcp__fixture__echo', input: {} } })
      event('content_block_delta', { index: 0, delta: returned ? { type: 'text_delta', text: 'MCP finished.' } : { type: 'input_json_delta', partial_json: '{"text":"local-only"}' } })
      event('content_block_stop', { index: 0 })
      event('message_delta', { delta: { stop_reason: returned ? 'end_turn' : 'tool_use' }, usage: { output_tokens: 5 } })
      event('message_stop', {})
      response.end()
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    let runtime: Awaited<ReturnType<typeof bootSmokeRuntime>> | undefined
    try {
      runtime = await bootSmokeRuntime(`http://127.0.0.1:${(server.address() as AddressInfo).port}/anthropic`, {
        protocol: 'messages', permissionMode: 'danger-full-access',
        mcpServers: transport === 'stdio' ? [{ serverName: 'fixture', transport, command: process.execPath, args: [resolve('test/fixtures/mcp-stdio.mjs')] }] : [{ serverName: 'fixture', transport, url: `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`, headers: { 'X-Api-Key': 'fixture-token' } }],
      })
      const { client } = runtime
      const catalog = await client.mcpTools()
      expect(catalog.some(tool => tool.name === 'mcp__fixture__echo')).toBe(true)
      const unauthorized = await fetch(new URL('/api/vscode.mcp-tools', runtime.url))
      expect(unauthorized.status).toBe(401)
      const { sessionId } = await client.sessionCreate({ cwd: runtime.home, agentPreset: 'minimal' })
      for await (const frame of client.sessionFollow({ address: { kind: 'session', sessionId } }, AbortSignal.timeout(15_000))) {
        if (frame.type === 'snapshot') await client.sessionPrompt({ sessionId, requestId: randomUUID() as SessionPromptRequest['requestId'], mode: 'queue', content: [{ type: 'text', text: 'Call the fixture echo tool.' }] })
        if (frame.type === 'event' && frame.event.type === 'turn/end') break
      }
      expect(listed).toBe(true)
      expect(returned).toBe(true)
      if (transport === 'streamable-http') expect(mcpCalls).toBe(1)
    } finally {
      await runtime?.close()
      mcp.closeAllConnections()
      await new Promise<void>(done => mcp.close(() => done()))
      server.closeAllConnections()
      await new Promise<void>(done => server.close(() => done()))
    }
  }, 45_000)

  it('does not start a disabled HTTP server', async () => {
    let calls = 0
    const server = createServer((_req, res) => { calls++; res.writeHead(500); res.end() })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    let runtime: Awaited<ReturnType<typeof bootSmokeRuntime>> | undefined
    try {
      runtime = await bootSmokeRuntime('http://127.0.0.1:1', {
        mcpServers: [{ serverName: 'disabled', enabled: false, transport: 'streamable-http', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }],
      })
      expect(await runtime.client.mcpTools()).toEqual([])
      expect(calls).toBe(0)
    } finally {
      await runtime?.close()
      server.closeAllConnections()
      await new Promise<void>(done => server.close(() => done()))
    }
  }, 45_000)

  it('does not forward MCP secrets to a redirected origin', async () => {
    let sourceRequests = 0
    let leakedRequests = 0
    const other = createServer((_req, res) => { leakedRequests++; res.writeHead(400); res.end() })
    await new Promise<void>(done => other.listen(0, '127.0.0.1', done))
    const server = createServer((_req, res) => { sourceRequests++; res.writeHead(307, { location: `http://127.0.0.1:${(other.address() as AddressInfo).port}/mcp` }); res.end() })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    let runtime: Awaited<ReturnType<typeof bootSmokeRuntime>> | undefined
    try {
      runtime = await bootSmokeRuntime('http://127.0.0.1:1', {
        mcpServers: [{ serverName: 'redirect', transport: 'streamable-http', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, headers: { 'X-Api-Key': 'synthetic-secret' }, reconnect: { enabled: false } }],
      })
      expect(await runtime.client.mcpTools()).toEqual([])
      expect(sourceRequests).toBeGreaterThan(0)
      expect(leakedRequests).toBe(0)
    } finally {
      await runtime?.close()
      for (const http of [server, other]) { http.closeAllConnections(); await new Promise<void>(done => http.close(() => done())) }
    }
  }, 45_000)
})
