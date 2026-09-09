import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { NodeGatewayClient } from '../src/gateway/node-gateway-client.js'
import type { HistoryEntry, SessionId } from '../src/gateway/gateway-wire.js'
import type { SessionPromptRequest } from '../src/gateway/domain-api.js'
import { projectConversation } from '../src/domain/workbench-state.js'
import { bootSmokeRuntime } from './helpers/runtime-smoke.js'

async function prompt(client: NodeGatewayClient, id: SessionId, text: string, signal: AbortSignal): Promise<void> {
  const failures: unknown[] = []
  for await (const frame of client.sessionFollow({ address: { kind: 'session', sessionId: id } }, signal)) {
    if (frame.type === 'snapshot') await client.sessionPrompt({ requestId: randomUUID() as SessionPromptRequest['requestId'], sessionId: id, mode: 'queue', content: [{ type: 'text', text }] })
    else if (frame.type === 'event') {
      const event = frame.event as unknown as HistoryEntry['event']
      if (event.type === 'assistant/attempt') failures.push(event.data)
      if (event.type === 'turn/end') {
        if (event.data.reason.kind !== 'completed') throw new Error(`Scripted turn failed: ${JSON.stringify({ reason: event.data.reason, failures })}`)
        return
      }
    }
  }
  throw new Error('No completed turn.')
}

async function history(client: NodeGatewayClient, id: SessionId, signal: AbortSignal): Promise<string> {
  for await (const frame of client.sessionFollow({ address: { kind: 'session', sessionId: id } }, signal)) {
    if (frame.type === 'snapshot') return JSON.stringify(projectConversation(frame.records as unknown as HistoryEntry[]).messages)
  }
  throw new Error('No history snapshot.')
}

describe.runIf(process.env.DSH_RUNTIME_SMOKE === '1')('independent backends share history', () => {
  it('shares both directions with a real official Web UI backend and preserves single-writer ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-two-backends-'))
    const sharedHome = join(root, '.dsh')
    const cwd = join(root, 'workspace')
    await mkdir(sharedHome)
    await mkdir(cwd)
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const input = Buffer.concat(chunks).toString()
      const answer = input.includes('from-official-web') ? 'Official web answer.' : 'VS Code answer.'
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'shared', object: 'chat.completion.chunk', model: 'deepseek-v4-flash', choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    let native: Awaited<ReturnType<typeof bootSmokeRuntime>> | undefined
    let official: Awaited<ReturnType<typeof bootSmokeRuntime>> | undefined
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort(), 50_000)
    try {
      native = await bootSmokeRuntime(url, { historyHome: sharedHome })
      const a = await native.client.sessionCreate({ cwd, agentPreset: 'minimal' })
      await prompt(native.client, a.sessionId, 'from-vscode', abort.signal)
      official = await bootSmokeRuntime(url, { home: sharedHome, officialUi: true })
      expect(new URL(native.url).port).not.toBe(new URL(official.url).port)
      expect(native.home).not.toBe(official.home)
      expect((await official.client.sessionList()).some((row) => row.sessionId === a.sessionId)).toBe(true)
      expect(await history(official.client, a.sessionId, abort.signal)).toContain('VS Code answer.')

      const b = await official.client.sessionCreate({ cwd, agentPreset: 'minimal' })
      await prompt(official.client, b.sessionId, 'from-official-web', abort.signal)
      expect((await native.client.sessionList()).some((row) => row.sessionId === b.sessionId)).toBe(true)
      expect(await history(native.client, b.sessionId, abort.signal)).toContain('Official web answer.')

      await expect(official.client.sessionPrompt({ requestId: randomUUID() as SessionPromptRequest['requestId'], sessionId: a.sessionId, mode: 'queue', content: [{ type: 'text', text: 'Do not take over the active owner.' }] })).rejects.toThrow(/already owned by an active write handle/)
      expect(await history(native.client, a.sessionId, abort.signal)).not.toContain('Do not take over the active owner.')
      await native.close()
      native = undefined
      await prompt(official.client, a.sessionId, 'Continue after the other backend closed.', abort.signal)
      expect(await history(official.client, a.sessionId, abort.signal)).toContain('Continue after the other backend closed.')
    } finally {
      clearTimeout(deadline)
      abort.abort()
      await native?.close()
      await official?.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }, 65_000)
})
