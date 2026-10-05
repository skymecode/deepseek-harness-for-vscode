import { createServer } from 'node:http'
import { resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { SessionPromptRequest } from '../src/gateway/domain-api.js'
import { bootSmokeRuntime } from './helpers/runtime-smoke.js'

describe.runIf(process.env.DSH_RUNTIME_SMOKE === '1')('MCP through the real DSH runtime', () => {
  it('discovers a stdio tool, invokes it and returns its result to the model', async () => {
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
        mcpServers: [{ serverName: 'fixture', transport: 'stdio', command: process.execPath, args: [resolve('test/fixtures/mcp-stdio.mjs')] }],
      })
      const { client } = runtime
      const { sessionId } = await client.sessionCreate({ cwd: runtime.home, agentPreset: 'minimal' })
      for await (const frame of client.sessionFollow({ address: { kind: 'session', sessionId } }, AbortSignal.timeout(15_000))) {
        if (frame.type === 'snapshot') await client.sessionPrompt({ sessionId, requestId: randomUUID() as SessionPromptRequest['requestId'], mode: 'queue', content: [{ type: 'text', text: 'Call the fixture echo tool.' }] })
        if (frame.type === 'event' && frame.event.type === 'turn/end') break
      }
      expect(listed).toBe(true)
      expect(returned).toBe(true)
    } finally {
      await runtime?.close()
      server.closeAllConnections()
      await new Promise<void>(done => server.close(() => done()))
    }
  }, 45_000)
})
