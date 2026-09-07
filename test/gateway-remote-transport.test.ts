import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { expect, it } from 'vitest'
import { NodeGatewayClient } from '../src/gateway/node-gateway-client.js'
import type { RemoteEvent } from '../src/gateway/remote-event-protocol.js'
import { approvalFrame, questionFrame } from './helpers/interaction-frames.js'

it('receives actionable mux frames and posts results in the official Typert envelope', async () => {
  const requests: { method: string; payload: unknown }[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const message = JSON.parse(Buffer.concat(chunks).toString()) as { rpcId: string; method: string; payload: unknown }
      requests.push(message)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: null } }))
    })()
  })
  const sockets = new WebSocketServer({ server, path: '/api/remote.mux' })
  let open: unknown
  sockets.on('connection', (socket) => socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as { type: string; streamId: string }
    if (message.type !== 'open') return
    open = message
    for (const value of [
      { type: 'ready', clientId: 'client-1', host: { home: '/tmp' } },
      approvalFrame(), { ...approvalFrame(), agentId: undefined }, questionFrame(),
      { type: 'cancel', eventId: 'approval-1' },
    ]) socket.send(JSON.stringify({ type: 'item', streamId: message.streamId, value }))
    socket.send(JSON.stringify({ type: 'end', streamId: message.streamId }))
  }))
  const abort = new AbortController()
  const deadline = setTimeout(() => abort.abort(), 5_000)
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const client = new NodeGatewayClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    const frames: RemoteEvent[] = []
    for await (const frame of client.remoteEvents(abort.signal)) frames.push(frame)
    expect(open).toMatchObject({ type: 'open', endpoint: '$events', payload: { args: {} } })
    expect(frames).toEqual([
      { type: 'ready', clientId: 'client-1' }, approvalFrame(), questionFrame(), { type: 'cancel', eventId: 'approval-1' },
    ])
    const answer = { answers: [{ id: 'scope', selected: ['Unit'] }] }
    await client.resolveRemoteEvent('client-1', 'approval-1', { kind: 'result', value: 'allowed-once' })
    await client.resolveRemoteEvent('client-1', 'question-1', { kind: 'result', value: answer })
    expect(requests).toEqual([
      expect.objectContaining({ method: '$events/result', payload: { args: { clientId: 'client-1', eventId: 'approval-1', outcome: { kind: 'result', value: 'allowed-once' } } } }),
      expect.objectContaining({ method: '$events/result', payload: { args: { clientId: 'client-1', eventId: 'question-1', outcome: { kind: 'result', value: answer } } } }),
    ])
  } finally {
    clearTimeout(deadline)
    abort.abort()
    for (const socket of sockets.clients) socket.terminate()
    await new Promise<void>((resolve) => sockets.close(() => resolve()))
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
