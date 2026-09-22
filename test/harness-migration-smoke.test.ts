import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionPromptRequest } from '../src/gateway/domain-api.js'
import type { HistoryEntry } from '../src/gateway/gateway-wire.js'
import { projectConversation } from '../src/domain/workbench-state.js'
import { runtimeContextItems, visibleTranscript } from '../src/domain/transcript-context.js'
import { bootSmokeRuntime } from './helpers/runtime-smoke.js'
import { legacyProjectKey, legacyV2Session } from './helpers/legacy-v2-session.js'

describe.runIf(process.env.DSH_RUNTIME_SMOKE === '1')('bundled Harness history upgrade', () => {
  it('recovers history, preserves the original generation and continues in V4', async () => {
    const modelInputs: string[] = []
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      modelInputs.push(Buffer.concat(chunks).toString())
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = (type: string, value: object): void => {
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`)
      }
      event('message_start', { message: { id: 'migration', type: 'message', role: 'assistant', content: [], model: 'deepseek-flash', usage: { input_tokens: 4, output_tokens: 0 } } })
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'V4 continued.' } })
      event('content_block_stop', { index: 0 })
      event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } })
      event('message_stop', {})
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    let runtime: Awaited<ReturnType<typeof bootSmokeRuntime>> | undefined
    let directory = ''
    let original = Buffer.alloc(0)
    const id = SessionId('session-legacy-v2-smoke')
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort(), 40_000)
    try {
      runtime = await bootSmokeRuntime(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, {
        protocol: 'messages',
        prepare: async (home) => {
          directory = join(home, 'sessions', legacyProjectKey(home), id)
          await mkdir(directory, { recursive: true })
          const log = legacyV2Session(id, home)
          const split = log.indexOf('\n') + 1
          // Harness requires a dedicated checksummed header frame, followed by event frames.
          original = Buffer.concat([log.slice(0, split), log.slice(split)].map((text) =>
            zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })))
          await writeFile(join(directory, 'session.v2.jsonl.zstd'), original)
        },
      })
      const { client } = runtime
      const address = { kind: 'session' as const, sessionId: id }
      let completed = false
      for await (const frame of client.sessionFollow({ address }, abort.signal)) {
        if (frame.type === 'snapshot') {
          const items = projectConversation(frame.records as unknown as HistoryEntry[]).messages
          expect(visibleTranscript(items).flatMap((item) => item.blocks?.map((block) => block.text) ?? [])).toEqual(['Legacy question.', 'Legacy answer.'])
          expect(runtimeContextItems(items).some((item) => item.blocks?.some((block) => block.text === 'Legacy system instructions.'))).toBe(true)
          await client.sessionPrompt({ requestId: randomUUID() as SessionPromptRequest['requestId'], sessionId: id, mode: 'queue', content: [{ type: 'text', text: 'Continue the migrated conversation.' }] })
        } else if (frame.type === 'event') {
          const event = frame.event as unknown as HistoryEntry['event']
          if (event.type === 'turn/end' && event.data.turn === 2) { completed = true; break }
        }
      }
      expect(completed).toBe(true)
      expect(modelInputs.length).toBeGreaterThan(0)
      expect(await readFile(join(directory, 'session.v2.jsonl.zstd'))).toEqual(original)
      expect(await readdir(directory)).toContain('session.v4.jsonl.zstd')
      for await (const frame of client.sessionFollow({ address }, abort.signal)) {
        expect(frame.type).toBe('snapshot')
        if (frame.type !== 'snapshot') break
        const items = visibleTranscript(projectConversation(frame.records as unknown as HistoryEntry[]).messages)
        expect(items.some((item) => item.blocks?.some((block) => block.text === 'V4 continued.'))).toBe(true)
        break
      }
    } finally {
      clearTimeout(deadline)
      abort.abort()
      await runtime?.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 55_000)
})
