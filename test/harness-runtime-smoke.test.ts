import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { SessionPromptRequest } from '../src/gateway/domain-api.js'
import type { HistoryEntry } from '../src/gateway/gateway-wire.js'
import { AssistantStreamState, presentationHistory } from '../src/gateway/assistant-stream-state.js'
import { projectConversation } from '../src/domain/workbench-state.js'
import { bootSmokeRuntime } from './helpers/runtime-smoke.js'

// Opt-in: starts the bundled native runtime, never an installed user profile.
describe.runIf(process.env.DSH_RUNTIME_SMOKE === '1')('bundled Harness end-to-end', () => {
  it('authenticates, streams reasoning, settles and reloads V2 history through the headless Gateway', async () => {
    const requests: string[] = []
    const server = createServer((request, response) => {
      requests.push(request.url ?? '')
      request.resume()
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const delta = (value: object): void => { response.write(`data: ${JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash', choices: [{ index: 0, delta: value, finish_reason: null }] })}\n\n`) }
      delta({ role: 'assistant', reasoning_content: 'Thinking' })
      const next = setTimeout(() => {
        delta({ reasoning_content: ' incrementally.' })
        delta({ content: 'Smoke passed.' })
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } })}\n\n`)
        response.end('data: [DONE]\n\n')
      }, 80)
      response.once('close', () => clearTimeout(next))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    let runtime: Awaited<ReturnType<typeof bootSmokeRuntime>> | undefined
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort(), 40_000)
    try {
      runtime = await bootSmokeRuntime(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
      const { client } = runtime
      await client.probe()
      const created = await client.sessionCreate({ cwd: runtime.home, agentPreset: 'minimal' })
      const address = { kind: 'session' as const, sessionId: created.sessionId }
      const stream = new AssistantStreamState()
      const history: HistoryEntry[] = []
      let liveReasoning = false
      let settled = false
      for await (const frame of client.sessionFollow({ address, maxMessages: 80 }, abort.signal)) {
        if (frame.type === 'snapshot') {
          stream.reset(frame.assistantStream)
          await client.sessionPrompt({ requestId: randomUUID() as SessionPromptRequest['requestId'], sessionId: created.sessionId, mode: 'queue', content: [{ type: 'text', text: 'Say smoke passed.' }] })
        } else if (frame.type === 'assistant-stream') {
          stream.accept(frame.frame)
          liveReasoning ||= projectConversation(stream.entries()).messages.some((item) => item.blocks?.some((block) => block.kind === 'reasoning' && block.text !== '') === true)
        } else {
          const event = frame.event as unknown as HistoryEntry['event']
          history.push({ event })
          stream.settle(event)
          if (event.type === 'turn/end') { settled = true; break }
        }
      }
      expect(settled).toBe(true)
      expect(liveReasoning).toBe(true)
      expect(requests).toContain('/chat/completions')
      const projected = projectConversation(presentationHistory(history)).messages
      expect(projected.some((item) => item.blocks?.some((block) => block.text === 'Smoke passed.'))).toBe(true)
      expect(projected.some((item) => item.blocks?.some((block) => block.kind === 'reasoning' && block.duration?.endedAt !== undefined))).toBe(true)
      // A reconnect gets a clean baseline and the same completed transcript.
      for await (const frame of client.sessionFollow({ address }, abort.signal)) {
        expect(frame.type).toBe('snapshot')
        if (frame.type !== 'snapshot') break
        expect(frame.assistantStream?.activeAttempt).toBeUndefined()
        expect(projectConversation(presentationHistory(frame.records as unknown as HistoryEntry[])).messages.some((item) => item.blocks?.some((block) => block.text === 'Smoke passed.'))).toBe(true)
        break
      }
      const response = await fetch(runtime.url, { redirect: 'manual' })
      expect(await response.text()).not.toMatch(/<html|<script/i)
    } finally {
      clearTimeout(deadline)
      abort.abort()
      await runtime?.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 55_000)
})
