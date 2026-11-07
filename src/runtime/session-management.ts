import type {} from '@deepseek-ai/dsh-working-directory'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { stat } from 'node:fs/promises'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionPreview } from '../domain/session-management.js'

interface Context {
  get(name: string): unknown
  webServer: { register(route: { kind: 'exact'; path: string; handler(req: IncomingMessage, res: ServerResponse): void }): unknown }
}

/** Thin access to native read observations and native writer ownership, never a second session engine. */
export function registerSessionManagement(ctx: Context, connection: { authorizeIndex(req: IncomingMessage, res: ServerResponse): boolean }): void {
  ctx.webServer.register({ kind: 'exact', path: '/api/vscode.session', handler: (req, res) => {
    if (!connection.authorizeIndex(req, res)) return
    const send = (status: number, value: unknown): void => {
      if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    }
    if (req.method !== 'GET' && req.method !== 'POST') { send(405, { error: { code: 'method-not-allowed' } }); return }
    // Mutation requires a non-simple header, in addition to the native authenticated cookie.
    if (req.method === 'POST' && req.headers['x-dsh-session-action'] !== 'resume') { send(400, { error: { code: 'invalid-action' } }); return }
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams
    const id = query.get('sessionId')
    if (!id || id.length > 512) { send(400, { error: { code: 'invalid-session' } }); return }
    const abort = new AbortController()
    res.on('close', () => abort.abort())
    void (async () => {
      const sessions = ctx.get('sessionQuery') as SessionQueryEngine
      const controller = ctx.get('sessionController') as SessionController
      using observation = await sessions.observeSession(id as SessionId, { signal: abort.signal })
      let values = observation.projections?.values ?? {}
      // A restored/private cache can contain an old title. The native log fold
      // is authoritative, and never activates an Agent.
      const title = await sessions.readTitle(id as SessionId, abort.signal)
      if (!title || title.eventSeq <= observation.cursor) values = { ...values, title: title?.title ?? null }
      const cwd = typeof values.workingDirectory === 'string' ? values.workingDirectory : observation.header.cwd
      const preset = typeof values.agentPreset === 'string' ? values.agentPreset : observation.header.agentPreset
      const value: SessionPreview = { cursor: observation.cursor, projections: values,
        ...(observation.header.cwd ? { projectCwd: observation.header.cwd } : {}),
        ...(cwd ? { cwd } : {}), ...(preset ? { agentPreset: preset } : {}) }
      if (req.method === 'GET') { send(200, { value }); return }
      const workspaces = ctx.get('workspaceRegistry') as { archivedSessionIds: readonly SessionId[] }
      if (workspaces.archivedSessionIds.includes(id as SessionId)) { send(409, { error: { code: 'session/archived' } }); return }
      if (!cwd || query.get('cwd') !== cwd) { send(409, { error: { code: 'session/directory-changed' } }); return }
      if (!(await stat(cwd).catch(() => undefined))?.isDirectory()) { send(409, { error: { code: 'session/directory-missing' } }); return }
      abort.signal.throwIfAborted()
      const result = await controller.resolveAgent(id as SessionId)
      if ('error' in result) { send(409, { error: { code: result.error.code, message: result.error.message } }); return }
      send(200, { value })
    })().catch((error: unknown) => send(500, { error: { code: 'session/unavailable', message: error instanceof Error ? error.message : String(error) } }))
  } })
}
