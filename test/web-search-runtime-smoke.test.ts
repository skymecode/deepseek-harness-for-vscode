import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { SessionPromptRequest } from '../src/gateway/domain-api.js'
import { bootSmokeRuntime } from './helpers/runtime-smoke.js'

describe.runIf(process.env.DSH_RUNTIME_SMOKE === '1')('native Search and Fetch APIs', () => {
  it.each([true, false])('honors webSearch=%s with the direct API option', async (enabled) => {
    const requests: { path: string; authorization: string | undefined; body: Record<string, unknown> }[] = []
    const results: string[] = []
    let modelStep = 0
    let modelSawSources = false
    let modelSawPage = false
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
      const pathname = request.url ?? ''
      if (pathname.startsWith('/web/')) {
        requests.push({ path: pathname, authorization: request.headers.authorization, body })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(pathname === '/web/search'
          ? { results: [{ title: 'Fixture', url: 'https://example.invalid/page', snippet: 'web-fixture-source', date: null }] }
          : { content: '# web-fixture-page' }))
        return
      }
      const tools = body.tools as { name: string }[] | undefined
      const regular = (tools?.length ?? 0) > 0
      const step = regular ? modelStep++ : 99
      const tool = step === 0 ? { name: 'web_search', input: { queries: ['synthetic query'] } }
        : enabled && step === 1 ? { name: 'web_fetch', input: { url: 'https://example.invalid/page' } } : undefined
      const messages = JSON.stringify(body.messages)
      modelSawSources ||= messages.includes('web-fixture-source')
      modelSawPage ||= messages.includes('web-fixture-page')
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = (type: string, value: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`)
      event('message_start', { message: { id: randomUUID(), type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], usage: { input_tokens: 5, output_tokens: 0 } } })
      event('content_block_start', { index: 0, content_block: tool
        ? { type: 'tool_use', id: `web-${step}`, name: tool.name, input: {} }
        : { type: 'text', text: '' } })
      event('content_block_delta', { index: 0, delta: tool
        ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) }
        : { type: 'text_delta', text: 'Web test finished.' } })
      event('content_block_stop', { index: 0 })
      event('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } })
      event('message_stop', {})
      response.end()
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    let runtime: Awaited<ReturnType<typeof bootSmokeRuntime>> | undefined
    try {
      runtime = await bootSmokeRuntime(`${endpoint}/anthropic`, {
        protocol: 'messages', webSearch: enabled, webSearchProvider: 'search-api',
        permissionMode: 'danger-full-access',
        prepare: async () => `\n- id: web-deepseek-api\n  config:\n    searchBaseURL: ${JSON.stringify(`${endpoint}/web`)}\n    searchApiKeyEnv: DSH_SMOKE_API_KEY\n    fetchBaseURL: ${JSON.stringify(`${endpoint}/web`)}\n    fetchApiKeyEnv: DSH_SMOKE_API_KEY\n    sendOriginalQuestion: false\n`,
      })
      const { client } = runtime
      // rc.3 Web credentials prefer saved values over launch environment values.
      await client.credentialsSet('DSH_SMOKE_API_KEY', 'saved-fixture-key')
      const namespaces = (await client.settingsDescribe()).namespaces
      const webValue = namespaces.find(ns => ns.ns === 'web')?.value as Record<string, unknown> | undefined
      if (enabled) {
        expect(webValue).toMatchObject({ searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' })
      } else {
        expect(webValue).toMatchObject({ fetchProvider: 'http' })
        expect(webValue?.searchProvider).toBeUndefined()
      }
      const { sessionId } = await client.sessionCreate({ cwd: runtime.home, agentPreset: 'standard' })
      let finished = false
      for await (const frame of client.sessionFollow({ address: { kind: 'session', sessionId } }, AbortSignal.timeout(20_000))) {
        if (frame.type === 'snapshot') await client.sessionPrompt({ sessionId, requestId: randomUUID() as SessionPromptRequest['requestId'], mode: 'queue', content: [{ type: 'text', text: 'Search the fixture, then fetch the result.' }] })
        if (frame.type === 'event' && frame.event.type === 'tool/result') results.push(JSON.stringify(frame.event.data))
        if (frame.type === 'event' && frame.event.type === 'turn/end') { finished = true; break }
      }
      expect(finished).toBe(true)
      expect(results.length).toBeGreaterThan(0)
      expect(requests.map(entry => entry.path)).toEqual(enabled ? ['/web/search', '/web/fetch'] : [])
      if (enabled) {
        expect(modelSawSources).toBe(true)
        expect(modelSawPage).toBe(true)
        expect(requests[0]?.body).toMatchObject({ query: 'synthetic query', need_content: false })
        expect(requests[0]?.body).not.toHaveProperty('ori_question')
        expect(requests[1]?.body).toEqual({ url: 'https://example.invalid/page' })
        expect(requests.every(entry => entry.authorization === 'Bearer saved-fixture-key')).toBe(true)
      } else {
        expect(results.join('\n')).toMatch(/no usable web provider|not registered|configured.*missing|unavailable/i)
        expect(modelSawSources).toBe(false)
      }
    } finally {
      await runtime?.close()
      server.closeAllConnections()
      await new Promise<void>(done => server.close(() => done()))
    }
  }, 45_000)
})
