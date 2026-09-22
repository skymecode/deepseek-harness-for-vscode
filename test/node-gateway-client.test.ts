import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { NodeGatewayClient } from '../src/gateway/node-gateway-client.js'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  }))
})

describe('NodeGatewayClient Remote carrier', () => {
  it('wraps command arguments in the Typert Connection args envelope', async () => {
    const requests: { readonly method: string; readonly payload: unknown }[] = []
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          readonly rpcId: string
          readonly method: string
          readonly payload: unknown
        }
        requests.push(message)
        const value = message.method === 'commands/list'
          ? [{ name: 'plan', description: 'Plan mode' }]
          : { commandId: 'cmd-1', result: { kind: 'success', text: 'Plan mode on.' } }
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          type: 'server-response',
          rpcId: message.rpcId,
          result: { ok: true, value },
        }))
      })()
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const client = new NodeGatewayClient(`http://127.0.0.1:${address.port}`)

    await expect(client.listCommands('session-1')).resolves.toEqual([{ name: 'plan', description: 'Plan mode' }])
    await expect(client.executeCommand('session-1', '/plan')).resolves.toMatchObject({ commandId: 'cmd-1' })
    expect(requests).toEqual([
      expect.objectContaining({ method: 'commands/list', payload: { args: { agentId: 'session-1' } } }),
      expect.objectContaining({ method: 'commands/execute', payload: { args: { agentId: 'session-1', line: '/plan', submittedAttachments: [] } } }),
    ])
  })

  it('uses native workspace pin and background-job cancellation endpoints', async () => {
    const requests: { readonly method: string; readonly payload: unknown }[] = []
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          readonly rpcId: string
          readonly method: string
          readonly payload: unknown
        }
        requests.push(message)
        const value = message.method === 'workspace/pinSession'
          ? { pinnedSessionIds: ['session-1'] }
          : message.method === 'workspace/unpinSession'
            ? { pinnedSessionIds: [] }
            : { outcome: 'requested' }
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value } }))
      })()
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const client = new NodeGatewayClient(`http://127.0.0.1:${address.port}`)

    await expect(client.workspacePinSession({ sessionId: 'session-1' })).resolves.toEqual({ pinnedSessionIds: ['session-1'] })
    await expect(client.workspaceUnpinSession({ sessionId: 'session-1' })).resolves.toEqual({ pinnedSessionIds: [] })
    await expect(client.jobKill({ sessionId: 'session-1' as SessionId, jobId: 'bash-1' as JobId })).resolves.toEqual({ outcome: 'requested' })
    expect(requests.map((request) => ({ method: request.method, payload: request.payload }))).toEqual([
      { method: 'workspace/pinSession', payload: { args: { request: { sessionId: 'session-1' } } } },
      { method: 'workspace/unpinSession', payload: { args: { request: { sessionId: 'session-1' } } } },
      { method: 'job/kill', payload: { args: { request: { sessionId: 'session-1', jobId: 'bash-1' } } } },
    ])
  })

  it('posts discovery and import requests to the dsh-chat-import panel API', async () => {
    const seen: { readonly url: string; readonly body: unknown }[] = []
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        seen.push({
          url: request.url ?? '',
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        })
        const value = request.url === '/api-import/sessions'
          ? { ok: true, sessions: [{ format: 'dsh', sessionId: 'import-1', title: 'Demo', project: null, sourcePath: 'C:/tmp/session.jsonl', createdAt: null, lastActiveAt: null, messageCount: 2 }], total: 1 }
          : { ok: true, results: [{ sourcePath: 'C:/tmp/session.jsonl', format: 'dsh', status: 'imported', sessionId: 'import-1' }] }
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(value))
      })()
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const client = new NodeGatewayClient(`http://127.0.0.1:${address.port}`)

    await expect(client.discoverImportSessions({ path: 'C:/tmp' })).resolves.toMatchObject({ total: 1 })
    await expect(client.importDiscoveredSessions({
      items: [{ source: 'dsh', sourcePath: 'C:/tmp/session.jsonl' }],
      force: true,
    })).resolves.toMatchObject({ results: [{ sessionId: 'import-1' }] })
    expect(seen).toEqual([
      { url: '/api-import/sessions', body: { path: 'C:/tmp' } },
      { url: '/api-import/import', body: { items: [{ source: 'dsh', sourcePath: 'C:/tmp/session.jsonl' }], force: true } },
    ])
  })

  it('maps a missing import plugin route to SESSION_IMPORT_UNAVAILABLE', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 404
      response.end('Not Found')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const client = new NodeGatewayClient(`http://127.0.0.1:${address.port}`)
    await expect(client.discoverImportSessions()).rejects.toThrow('SESSION_IMPORT_UNAVAILABLE')
  })

  it('aborts an import API request that never finishes', async () => {
    const server = createServer(() => {
      // Keep the POST response open until the client times out.
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const client = new NodeGatewayClient(`http://127.0.0.1:${address.port}`, 50)
    await expect(client.discoverImportSessions()).rejects.toThrow(/timed out after 50ms/)
  })

  it('cancels an in-flight Gateway RPC when the owning client is retired', async () => {
    let resolveRequestSeen!: () => void
    const requestSeen = new Promise<void>((resolve) => { resolveRequestSeen = resolve })
    const server = createServer(() => { resolveRequestSeen() })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const client = new NodeGatewayClient(`http://127.0.0.1:${address.port}`, 30_000)
    const pending = client.probe()
    await requestSeen
    client.abortPendingRequests()
    await expect(pending).rejects.toThrow()
    await expect(client.probe()).rejects.toThrow('Gateway client is closed')
  })

  it('aborts when the import API sends headers but never finishes the body', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"ok":')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const client = new NodeGatewayClient(`http://127.0.0.1:${address.port}`, 50)
    await expect(client.discoverImportSessions()).rejects.toThrow(/timed out after 50ms/)
  })

  it('rejects a discovery payload that is not an object', async () => {
    const client = await clientAgainstJson('[]')
    await expect(client.discoverImportSessions()).rejects.toThrow(/invalid JSON payload/)
  })

  it('rejects a discovery payload that is missing sessions', async () => {
    const client = await clientAgainstJson('{"ok":true}')
    await expect(client.discoverImportSessions()).rejects.toThrow(/missing sessions/)
  })

  it('rejects an import payload that is missing results', async () => {
    const client = await clientAgainstJson('{"ok":true}')
    await expect(client.importDiscoveredSessions({
      items: [{ source: 'dsh', sourcePath: 'C:/tmp/session.jsonl' }],
    })).rejects.toThrow(/missing results/)
  })
})

async function clientAgainstJson(body: string): Promise<NodeGatewayClient> {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(body)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return new NodeGatewayClient(`http://127.0.0.1:${address.port}`)
}
