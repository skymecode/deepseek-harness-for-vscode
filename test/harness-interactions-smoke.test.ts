import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { SessionPromptRequest } from '../src/gateway/domain-api.js'
import { PendingInteractions } from '../src/gateway/pending-interactions.js'
import { bootSmokeRuntime } from './helpers/runtime-smoke.js'

// Real bundled Gateway + a loopback fake model. Never reads a user's API key.
describe.runIf(process.env.DSH_RUNTIME_SMOKE === '1')('bundled Harness interactions', () => {
  it('replays a pending question after reconnect and delivers answers/approval rejection back to the agent', async () => {
    const modelInputs: string[] = []
    let step = 0
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const input = Buffer.concat(chunks).toString()
        const body = JSON.parse(input) as { tools?: { function?: { name?: string } }[] }
        const conversation = body.tools?.some((tool) => tool.function?.name === 'ask_user_question') === true
        if (conversation) modelInputs.push(input)
        // Background title-generation requests must not advance the scripted turn.
        const current = conversation ? step++ : 2
        const toolName = process.platform === 'win32' ? 'pwsh' : 'bash'
        const call = current === 0
          ? { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'scope', question: 'Which tests?', options: [{ label: 'Unit' }] }] }) }
          : current === 1
            ? { name: toolName, arguments: JSON.stringify({ command: 'pwd', description: 'Test approval transport without executing the command', sandbox_permissions: 'danger-full-access', justification: 'Test the approval transport; this request will be rejected.' }) }
            : undefined
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const delta = call === undefined
          ? { role: 'assistant', content: 'Interaction smoke passed.' }
          : { role: 'assistant', tool_calls: [{ index: 0, id: `call-${current}`, type: 'function', function: call }] }
        response.write(`data: ${JSON.stringify({ id: 'interaction-smoke', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call === undefined ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } })}\n\n`)
        response.end('data: [DONE]\n\n')
      })()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    let runtime: Awaited<ReturnType<typeof bootSmokeRuntime>> | undefined
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort(), 40_000)
    try {
      runtime = await bootSmokeRuntime(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
      const { client } = runtime
      const created = await client.sessionCreate({ cwd: runtime.home, agentPreset: 'standard' })
      const owner = String(created.sessionId)
      const pending = new PendingInteractions()
      let generation = 0
      let originalEventId: string | undefined
      let originalKey: string | undefined
      for await (const frame of client.remoteEvents(abort.signal)) {
        if (frame.type === 'ready') {
          generation = pending.beginConnection(frame.clientId)
          await client.sessionPrompt({ requestId: randomUUID() as SessionPromptRequest['requestId'], sessionId: created.sessionId, mode: 'queue', content: [{ type: 'text', text: 'Exercise the interaction protocol.' }] })
        } else if (frame.type === 'waterfall') {
          expect(frame.event).toBe('user-questions/request')
          expect(frame.agentId).toBe(owner)
          expect(frame.request.sessionId).toBeUndefined()
          originalEventId = frame.eventId
          originalKey = pending.receive(frame, generation)?.key
          break // Lose the delivery before answering; the host must replay it.
        }
      }
      expect(originalKey).toBeDefined()
      pending.disconnect(generation)
      let answered = false
      let rejected = false
      let finished = false
      for await (const frame of client.remoteEvents(abort.signal)) {
        if (frame.type === 'ready') generation = pending.beginConnection(frame.clientId)
        else if (frame.type === 'waterfall') {
          expect(frame.agentId).toBe(owner)
          const interaction = pending.receive(frame, generation)
          expect(interaction).toBeDefined()
          if (interaction === undefined) continue
          if (interaction.kind === 'question') {
            expect(frame.eventId).toBe(originalEventId)
            expect(interaction.key).not.toBe(originalKey)
            await client.resolveRemoteEvent(interaction.clientId, interaction.eventId, { kind: 'result', value: { answers: [{ id: 'scope', selected: ['Unit'], custom: 'smoke-answer-marker' }] } })
            answered = true
          } else {
            // Test the actual approval path without executing an escalated command.
            expect(interaction.view.toolName).toBe(process.platform === 'win32' ? 'pwsh' : 'bash')
            await client.resolveRemoteEvent(interaction.clientId, interaction.eventId, { kind: 'result', value: 'rejected' })
            rejected = true
          }
          pending.finishResponse(interaction, true)
        } else if (frame.type === 'emit' && frame.event === 'api-session/status' && frame.args[0] === owner && frame.args[1] === false && answered) {
          finished = true
          break
        }
      }
      expect(answered).toBe(true)
      expect(rejected).toBe(true)
      expect(finished).toBe(true)
      expect(modelInputs.some((input) => input.includes('smoke-answer-marker'))).toBe(true)
      expect(modelInputs).toHaveLength(3)
    } finally {
      clearTimeout(deadline)
      abort.abort()
      await runtime?.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 55_000)
})
