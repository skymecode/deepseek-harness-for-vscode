import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { SessionPromptRequest } from '../src/gateway/domain-api.js'
import type { HistoryEntry } from '../src/gateway/gateway-wire.js'
import { bootSmokeRuntime } from './helpers/runtime-smoke.js'
import { prepareVendoredSmokePlugins } from './helpers/vendored-smoke-plugins.js'

describe.runIf(process.env.DSH_RUNTIME_SMOKE === '1')('bundled community plugins', () => {
  it('loads the shipped plugins and executes a read-only community tool through Harness', async () => {
    const offered = new Set<string>()
    let invoked = false
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: { function: { name: string } }[] }
      for (const tool of body.tools ?? []) offered.add(tool.function.name)
      const call = body.tools?.some((tool) => tool.function.name === 'dev_plugin_status') === true && !invoked
      if (call) invoked = true
      const delta = call
        ? { role: 'assistant', tool_calls: [{ index: 0, id: 'plugin-status', type: 'function', function: { name: 'dev_plugin_status', arguments: '{}' } }] }
        : { role: 'assistant', content: 'Plugin smoke passed.' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'plugins', object: 'chat.completion.chunk', model: 'deepseek-v4-flash', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    let runtime: Awaited<ReturnType<typeof bootSmokeRuntime>> | undefined
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort(), 40_000)
    try {
      runtime = await bootSmokeRuntime(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { prepare: prepareVendoredSmokePlugins })
      const { client } = runtime
      const created = await client.sessionCreate({ cwd: runtime.home, agentPreset: 'standard' })
      let result = false
      let completed = false
      for await (const frame of client.sessionFollow({ address: { kind: 'session', sessionId: created.sessionId } }, abort.signal)) {
        if (frame.type === 'snapshot') {
          await client.sessionPrompt({ requestId: randomUUID() as SessionPromptRequest['requestId'], sessionId: created.sessionId, mode: 'queue', content: [{ type: 'text', text: 'Check plugin status without changing anything.' }] })
        } else if (frame.type === 'event') {
          const event = frame.event as unknown as HistoryEntry['event']
          if (event.type === 'tool/result' && String(event.data.message.source.callId) === 'plugin-status') {
            expect(event.data.error).toBeUndefined()
            result = true
          }
          if (event.type === 'turn/end') { completed = true; break }
        }
      }
      expect(completed).toBe(true)
      expect(result).toBe(true)
      expect(offered.has('dev_plugin_status')).toBe(true)
      expect([...offered].some((name) => name.startsWith('import_'))).toBe(true)
    } finally {
      clearTimeout(deadline)
      abort.abort()
      await runtime?.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 55_000)
})
