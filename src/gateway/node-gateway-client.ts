/**
 * Node transport for the Harness Gateway (dsh 0.1.2 Typert Remote protocol).
 *
 * Unary calls POST a Connection `client-request` envelope to `/api/<endpoint>`
 * with the endpoint's named `{ args }` payload; event and domain streams run
 * over a single `/api/remote.mux` WebSocket with `open`/`item`/`end`/`error`
 * frames. The Gateway authorizes through a launch-token exchange: the boot
 * URL carries `?token=`, which trades for a signed HttpOnly cookie on the
 * index request — every subsequent call sends that cookie.
 *
 * VS Code's extension host is not a browser, so the official browser module
 * loader client is unavailable; this is the plain transport equivalent.
 */
import type { RawData } from 'ws'
import WebSocket from 'ws'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici'
import { RpcId, serverResponseSchema, type ClientRequest, type ConnectionRpcResult, type ServerResponse } from '@deepseek-ai/dsh-client-connection'
import type { SessionPage } from '@deepseek-ai/dsh-api-session-controller/types'
import type { AgentPresetRoster } from '@deepseek-ai/dsh-agent-presets/types'
import type { CommandDescriptor as WireCommandDescriptor } from '@deepseek-ai/dsh-commands/types'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import type { CreateGoalRequest, CreateGoalResult } from '@deepseek-ai/dsh-goal/types'
import type { LlmConfigurableProvider, LlmDiscoveredModel, LlmModelDiscoveryRequest, LlmProviderInfo } from '@deepseek-ai/dsh-llm/types'
import type { SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'
import type { SubagentCatalog, SubagentInterruptReceipt, SubagentPromptReceipt, SubagentPromptRequest } from '@deepseek-ai/dsh-subagent/client'
import type {
  SessionControlFrame,
  SessionCreateRequest,
  SessionCreateValue,
  SessionFollowFrame,
  SessionFollowRequest,
  SessionListValue,
  SessionPageRequest,
  SessionPromptRequest,
  SessionPromptValue,
  SessionQueueMutation,
  SessionRenameValue,
  SessionSearchValue,
  SessionSelectModelValue,
  SessionSummary,
  SessionUpdateQueueValue,
  SkillListValue,
  WorkspaceArchiveValue,
  WorkspaceFollowFrame,
} from './domain-api.js'
import { parseImportDiscoverResult, parseImportResult, type ImportDiscoverRequest, type ImportDiscoverResult, type ImportRequest, type ImportResult } from '../import/types.js'
import { parseRemoteEvent, type RemoteEvent, type RemoteEventOutcome } from './remote-event-protocol.js'

/** A host-registered slash command descriptor, as served by `commands/list`. */
export interface HostCommandDescriptor extends WireCommandDescriptor {}

export interface HostCommandExecution {
  readonly commandId: string
  readonly result?: { readonly kind: 'success' | 'error'; readonly text?: string }
}

type RemoteValue<T> = ConnectionRpcResult<T>

/**
 * Node transport for the Harness Gateway. Unary calls use a typed fetch
 * client; streams use `ws` because VS Code's extension host is not a browser
 * and does not expose the Harness browser module loader.
 */
export class NodeGatewayClient {
  private readonly baseUrl: string
  private readonly token: string | undefined
  private cookie: string | undefined
  private rpcCounter = 0

  constructor(
    url: string,
    private readonly importTimeoutMs = 30_000,
  ) {
    const parsed = new URL(url)
    this.token = parsed.searchParams.get('token') ?? undefined
    parsed.searchParams.delete('token')
    parsed.search = parsed.search
    this.baseUrl = parsed.origin
  }

  /**
   * Exchanges the launch token for the browser-session cookie, once.
   *
   * Uses a raw node:http GET because the index response is a 303 redirect:
   * `fetch` follows it (and then 401s without a cookie jar), while the raw
   * request reads the `set-cookie` exchange directly.
   */
  private async ensureAuthenticated(): Promise<void> {
    if (this.cookie !== undefined || this.token === undefined) return
    const url = new URL('/', this.baseUrl)
    url.searchParams.set('token', this.token)
    const cookie = await new Promise<string>((resolve, reject) => {
      const requester = url.protocol === 'https:' ? httpsRequest : httpRequest
      const req = requester(url, { method: 'GET', headers: { accept: 'text/html' } }, (res) => {
        const raw = (res.headers['set-cookie'] ?? []) as string[]
        const joined = raw.map((value) => value.split(';')[0] ?? '').filter((value) => value.length > 0).join('; ')
        res.resume()
        resolve(joined)
      })
      req.on('error', reject)
      req.setTimeout(5_000, () => {
        req.destroy(new Error('Gateway authentication exchange timed out.'))
      })
      req.end()
    })
    this.cookie = cookie
  }

  /** Lists the slash commands the active Harness deployment registers for one session. */
  async listCommands(agentId: string): Promise<readonly HostCommandDescriptor[]> {
    const value = await this.callRaw<readonly HostCommandDescriptor[]>('commands/list', { agentId })
    return value
  }

  /** Executes one registered Host slash command without sending it to the LLM. */
  async executeCommand(agentId: string, line: string): Promise<HostCommandExecution | undefined> {
    const value = await this.callRaw<HostCommandExecution | undefined>('commands/execute', { agentId, line, images: [] })
    return value
  }

  /** Downloads the session log ZIP (with descendant sessions) served by the Gateway. */
  async exportSession(sessionId: string, includeDescendants = true): Promise<Uint8Array> {
    await this.ensureAuthenticated()
    const url = new URL('/api/session.export', this.baseUrl)
    url.searchParams.set('sessionId', sessionId)
    url.searchParams.set('includeDescendants', String(includeDescendants))
    const response = await this.doFetch(url)
    if (response.status === 404 || response.status === 405) throw new Error('SESSION_EXPORT_UNAVAILABLE')
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Export failed: HTTP ${response.status}${detail === '' ? '' : ` ${detail}`}`)
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  /** Lists importable sessions through the dsh-chat-import panel API. */
  async discoverImportSessions(request: ImportDiscoverRequest = {}): Promise<ImportDiscoverResult> {
    return await this.postImportApi('/api-import/sessions', request, parseImportDiscoverResult)
  }

  /** Imports discovered sessions through the dsh-chat-import panel API. */
  async importDiscoveredSessions(request: ImportRequest): Promise<ImportResult> {
    return await this.postImportApi('/api-import/import', request, parseImportResult)
  }

  /** Session list (Typert `session/list`). */
  async sessionList(cursor?: string): Promise<readonly SessionSummary[]> {
    const value = await this.callRaw<SessionListValue>('session/list', { _request: cursor === undefined ? {} : { cursor } })
    return value.items
  }

  /** Session create (Typert `session/create`). */
  async sessionCreate(request: SessionCreateRequest): Promise<SessionCreateValue> {
    return await this.callRaw<SessionCreateValue>('session/create', { request })
  }

  /** Session prompt (Typert `session/prompt`). */
  async sessionPrompt(request: SessionPromptRequest): Promise<SessionPromptValue> {
    return await this.callRaw<SessionPromptValue>('session/prompt', { request })
  }

  /** Session cancel (Typert `session/cancel`). */
  async sessionCancel(request: { readonly sessionId: unknown }): Promise<{ readonly accepted: true }> {
    return await this.callRaw<{ readonly accepted: true }>('session/cancel', { request })
  }

  /** Session rename (Typert `session/rename`). */
  async sessionRename(request: { readonly sessionId: unknown; readonly title: string }): Promise<SessionRenameValue> {
    return await this.callRaw<SessionRenameValue>('session/rename', { request })
  }

  /** Session fork (Typert `session/fork`). */
  async sessionFork(request: { readonly sessionId: unknown; readonly atSeq?: number }): Promise<{ readonly sessionId: unknown }> {
    return await this.callRaw<{ readonly sessionId: unknown }>('session/fork', { request })
  }

  /** Session search (Typert `session/search`). */
  async sessionSearch(request: { readonly query: string }): Promise<SessionSearchValue> {
    return await this.callRaw<SessionSearchValue>('session/search', { request })
  }

  /** Session model selection (Typert `session/selectModel`). */
  async sessionSelectModel(request: { readonly sessionId: unknown; readonly provider: string; readonly model: string; readonly reasoningEffort?: string }): Promise<SessionSelectModelValue> {
    return await this.callRaw<SessionSelectModelValue>('session/selectModel', { request })
  }

  /** Session model catalog (Typert `session/modelCatalog`). */
  async sessionModelCatalog(): Promise<import('@deepseek-ai/dsh-api-session-controller/types').ModelCatalog> {
    return await this.callRaw<import('@deepseek-ai/dsh-api-session-controller/types').ModelCatalog>('session/modelCatalog', {})
  }

  /** Session queue mutation (Typert `session/updateQueue`). */
  async sessionUpdateQueue(request: { readonly sessionId: unknown; readonly itemId: unknown; readonly action: SessionQueueMutation }): Promise<SessionUpdateQueueValue> {
    return await this.callRaw<SessionUpdateQueueValue>('session/updateQueue', { request })
  }

  /** One backward page of a session log (Typert `session/page`). */
  async sessionPage(request: SessionPageRequest): Promise<SessionPage> {
    return await this.callRaw<SessionPage>('session/page', { request })
  }

  /** Session event stream: snapshot window plus ordered events (Typert `session/follow`). */
  sessionFollow(request: SessionFollowRequest, signal: AbortSignal): AsyncGenerator<SessionFollowFrame> {
    return this.openStream<SessionFollowFrame>('session/follow', { request: { ...request, assistantStream: true } }, signal)
  }

  /** Host-wide live state stream (Typert `session/control`). */
  sessionControl(signal: AbortSignal): AsyncGenerator<SessionControlFrame> {
    return this.openStream<SessionControlFrame>('session/control', {}, signal)
  }

  /** Sub-agent catalog (Typert `subagents/list`). */
  async subagentList(parentSessionId: unknown): Promise<SubagentCatalog> {
    return await this.callRaw<SubagentCatalog>('subagents/list', { parentSessionId })
  }

  /** Sub-agent prompt (Typert `subagents/prompt`). */
  async subagentPrompt(request: SubagentPromptRequest): Promise<SubagentPromptReceipt> {
    return await this.callRaw<SubagentPromptReceipt>('subagents/prompt', { request })
  }

  /** Sub-agent interrupt (Typert `subagents/interruptByParent`). */
  async subagentInterrupt(childSessionId: unknown, parentSessionId: unknown): Promise<SubagentInterruptReceipt> {
    return await this.callRaw<SubagentInterruptReceipt>('subagents/interruptByParent', { childSessionId, parentSessionId, mode: 'continuable' })
  }

  /** Human-invocable skill catalog (Typert `skills/list`). */
  async skillList(request: { readonly sessionId: unknown }): Promise<SkillListValue> {
    return await this.callRaw<SkillListValue>('skills/list', { request })
  }

  /** Archive one session (Typert `workspace/archiveSession`). */
  async workspaceArchiveSession(request: { readonly sessionId: unknown }): Promise<WorkspaceArchiveValue> {
    return await this.callRaw<WorkspaceArchiveValue>('workspace/archiveSession', { request })
  }

  /** Workspace/browse state stream (Typert `workspace/follow`). */
  workspaceFollow(signal: AbortSignal): AsyncGenerator<WorkspaceFollowFrame> {
    return this.openStream<WorkspaceFollowFrame>('workspace/follow', {}, signal)
  }

  /** Agent preset roster (Typert `agentPresets/list`). */
  async agentPresetList(): Promise<AgentPresetRoster> {
    return await this.callRaw<AgentPresetRoster>('agentPresets/list', {})
  }

  /** Agent preset selection (Typert `agentPresets/select`). */
  async agentPresetSelect(agentId: unknown, agentPreset: string): Promise<string> {
    return await this.callRaw<string>('agentPresets/select', { agentId, agentPreset })
  }

  /** Goal creation (Typert `goals/create`). */
  async goalCreate(agentId: unknown, request: CreateGoalRequest): Promise<CreateGoalResult> {
    return await this.callRaw<CreateGoalResult>('goals/create', { agentId, request })
  }

  /** Goal lifecycle mutation (Typert `goals/{action}`). */
  async goalAction(action: 'pause' | 'resume' | 'complete' | 'clear', agentId: unknown, ref: unknown): Promise<unknown> {
    return await this.callRaw<unknown>(`goals/${action}`, { agentId, ref })
  }

  /** Submits one Remote Event waterfall outcome (Typert `$events/result`). */
  async resolveRemoteEvent(clientId: string, eventId: string, outcome: RemoteEventOutcome): Promise<void> {
    await this.callRaw<unknown>('$events/result', { clientId, eventId, outcome })
  }

  /** Settings describe (Typert `settings/describe`). */
  async settingsDescribe(): Promise<SettingsDescribeValue> {
    return await this.callRaw<SettingsDescribeValue>('settings/describe', {})
  }

  /** Settings mutate (Typert `settings/mutate`). */
  async settingsMutate(ns: string, ops: readonly SettingsPathOpView[], expectedRevision: number | undefined): Promise<SettingsNamespaceView> {
    return await this.callRaw<SettingsNamespaceView>('settings/mutate', { ns, ops, expectedRevision })
  }

  /** Settings update (Typert `settings/update`). */
  async settingsUpdate(ns: string, patch: Record<string, unknown>, expectedRevision: number | undefined): Promise<SettingsNamespaceView> {
    return await this.callRaw<SettingsNamespaceView>('settings/update', { ns, patch, expectedRevision })
  }

  /** Credentials describe (Typert `credentials/describe`). */
  async credentialsDescribe(refs: readonly string[]): Promise<Record<string, CredentialInfo>> {
    return await this.callRaw<Record<string, CredentialInfo>>('credentials/describe', { refs })
  }

  /** Credentials set (Typert `credentials/set`). */
  async credentialsSet(ref: string, value: string): Promise<void> {
    await this.callRaw<null>('credentials/set', { ref, value })
  }

  /** Credentials unset (Typert `credentials/unset`). */
  async credentialsUnset(ref: string): Promise<void> {
    await this.callRaw<null>('credentials/unset', { ref })
  }

  /** LLM provider list (Typert `llm/listProviders`). */
  async llmListProviders(): Promise<readonly LlmProviderInfo[]> {
    return await this.callRaw<readonly LlmProviderInfo[]>('llm/listProviders', {})
  }

  /** LLM configurable provider list (Typert `llm/listConfigurableProviders`). */
  async llmListConfigurableProviders(): Promise<readonly LlmConfigurableProvider[]> {
    return await this.callRaw<readonly LlmConfigurableProvider[]>('llm/listConfigurableProviders', {})
  }

  /** LLM model discovery (Typert `llm/discoverModels`). */
  async llmDiscoverModels(settingsNs: string, request: LlmModelDiscoveryRequest): Promise<readonly LlmDiscoveredModel[]> {
    return await this.callRaw<readonly LlmDiscoveredModel[]>('llm/discoverModels', { settingsNs, request })
  }

  /** Host-wide forwarded remote events (the `$events` logical stream). */
  async *remoteEvents(signal: AbortSignal): AsyncGenerator<RemoteEvent> {
    for await (const value of this.openStream<unknown>('$events', {}, signal)) {
      const frame = parseRemoteEvent(value)
      if (frame !== undefined) yield frame
    }
  }

  /** Connectivity check: an authenticated unary round-trip. */
  async probe(): Promise<void> {
    await this.callRaw<{ readonly blanks: readonly unknown[] }>('session/list', { _request: {} })
  }

  /** Unwraps V2 durable records; live assistant frames never enter this list. */
  static expandRecords(records: readonly unknown[]): { readonly event: unknown }[] {
    const events: { readonly event: unknown }[] = []
    for (const record of records) {
      if (typeof record !== 'object' || record === null || Reflect.get(record, 'type') !== 'event') {
        throw new Error('Unsupported Harness history record; expected a V2 event.')
      }
      events.push({ event: Reflect.get(record, 'event') })
    }
    return events
  }

  /** Expands follow snapshot records and returns the undecorated event list. */
  static expandEvents(records: readonly unknown[]): readonly unknown[] {
    return NodeGatewayClient.expandRecords(records).map((entry) => entry.event)
  }

  private async postImportApi<T>(
    path: string,
    body: unknown,
    parse: (value: unknown) => T,
  ): Promise<T> {
    await this.ensureAuthenticated()
    const response = await this.doFetch(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.importTimeoutMs),
    }).catch((cause: unknown) => {
      throw timedOutImport(path, this.importTimeoutMs, cause)
    })
    if (response.status === 404 || response.status === 405) {
      throw new Error('SESSION_IMPORT_UNAVAILABLE')
    }
    const text = await response.text().catch((cause: unknown) => {
      throw timedOutImport(path, this.importTimeoutMs, cause)
    })
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      throw new Error(`Import API ${path} returned HTTP ${response.status}${text === '' ? '' : `: ${text}`}`)
    }
    if (!response.ok) {
      const record = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined
      throw new Error(
        typeof record?.error === 'string' ? record.error : `Import API ${path} failed: HTTP ${response.status}`,
      )
    }
    try {
      return parse(parsed)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      throw new Error(`Import API ${path} returned HTTP ${response.status}: ${detail}`)
    }
  }

  /** Generic unary call: Connection envelope POST to `/api/<endpoint>`. */
  private async callRaw<T>(method: string, args: Record<string, unknown>): Promise<T> {
    await this.ensureAuthenticated()
    const started = Date.now()
    const rpcId = RpcId(`vscode-${Date.now().toString(36)}-${(++this.rpcCounter).toString(36)}`)
    const message: ClientRequest = { type: 'client-request', rpcId, method, payload: { args } }
    this.onEnvelope(message)
    const response = await this.doFetch(new URL(`/api/${method}`, this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(this.importTimeoutMs),
    })
    if (!response.ok) {
      console.error(`[gateway-rpc] ${method} HTTP ${response.status} after ${Date.now() - started}ms`)
      throw new Error(`transport failure for ${method}: HTTP ${response.status}`)
    }
    const full = serverResponseSchema.parse(await response.json()) as ServerResponse
    this.onEnvelope(full)
    if (full.rpcId !== rpcId) throw new Error(`rpcId mismatch for ${method}: sent ${rpcId}, got ${full.rpcId}`)
    if (!full.result.ok) throw new Error(`RPC ${method} failed: ${full.result.error.code}: ${full.result.error.message}`)
    if (Date.now() - started > 1_000) console.error(`[gateway-rpc] ${method} took ${Date.now() - started}ms`)
    return full.result.value as T
  }

  /** Domain stream: one logical stream on the shared `/api/remote.mux` WebSocket. */
  private async *openStream<T>(endpoint: string, args: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<T> {
    await this.ensureAuthenticated()
    const streamId = `vscode-${Date.now().toString(36)}-${(++this.rpcCounter).toString(36)}`
    const url = new URL('/api/remote.mux', this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.cookie !== undefined) headers['cookie'] = this.cookie
    const socket = new WebSocket(url, { headers })
    const inbox: QueueItem<T>[] = []
    let wake: (() => void) | undefined
    let failure: Error | undefined

    const enqueue = (item: QueueItem<T>): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    const fail = (error: Error): void => {
      if (failure !== undefined) return
      failure = error
      inbox.length = 0
      wake?.()
      wake = undefined
    }
    const abort = (): void => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
    }
    const message = (data: RawData): void => {
      try {
        const frame = JSON.parse(rawDataText(data)) as StreamFrame
        if (frame.streamId !== streamId) return
        if (frame.type === 'item') enqueue({ kind: 'item', value: frame.value as T })
        else if (frame.type === 'end') enqueue({ kind: 'end' })
        else if (frame.type === 'error') fail(new Error(`stream ${endpoint} failed: ${String(frame.error?.code ?? '')}: ${frame.error?.message ?? ''}`))
      } catch {
        // A malformed push is isolated. Generation closes retry the stream.
      }
    }

    socket.once('open', () => {
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
    })
    socket.on('message', message)
    socket.once('close', () => enqueue({ kind: 'end' }))
    socket.once('error', (error) => fail(error))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()

    try {
      while (!signal.aborted) {
        while (inbox.length > 0) {
          const item = inbox.shift()
          if (item?.kind === 'end') return
          if (item?.kind === 'error') throw (item as { kind: 'error'; error: Error }).error
          if (item?.kind === 'item') yield (item as { kind: 'item'; value: T }).value
        }
        if (failure !== undefined) throw failure
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', abort)
      socket.off('message', message)
      socket.off('close', () => undefined)
      socket.off('error', () => undefined)
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.send(JSON.stringify({ type: 'cancel', streamId }))
        socket.close()
      }
    }
  }

  /** Pre-write hook for the envelope lifecycle (kept for test parity). */
  protected onEnvelope(_message: ClientRequest | ServerResponse): void {
    // Transport instrumentation seam.
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    // The Gateway always listens on 127.0.0.1. undici's default global fetch
    // honors HTTP(S)_PROXY env vars, so a system proxy (Clash/Surge/VPN) can
    // route loopback requests through the proxy and fail with `fetch failed`,
    // leaving the workbench stuck on "Starting Harness". A bare Agent bypasses
    // the proxy entirely for every request this client makes — the extension
    // only ever talks to the local Gateway over loopback.
    const headers: Record<string, string> = {}
    new Headers(init?.headers ?? undefined).forEach((value, key) => { headers[key] = value })
    if (this.cookie !== undefined && headers['cookie'] === undefined) headers['cookie'] = this.cookie
    const request = init === undefined
      ? { headers, dispatcher: LOOPBACK_DISPATCHER }
      : { ...init, headers, dispatcher: LOOPBACK_DISPATCHER }
    return undiciFetch(input, request as Parameters<typeof undiciFetch>[1]) as Promise<Response>
  }
}

type QueueItem<T> = { readonly kind: 'item'; readonly value: T } | { readonly kind: 'end' } | { readonly kind: 'error'; readonly error: Error }

/** Wire frames accepted on `/api/remote.mux`. */
interface StreamFrame {
  readonly type: 'open' | 'item' | 'end' | 'error' | 'cancel'
  readonly streamId: string
  readonly value?: unknown
  readonly error?: { readonly code: string; readonly message: string; readonly details: object }
}

function timedOutImport(path: string, timeoutMs: number, cause: unknown): Error {
  if (cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) {
    return new Error(`Import API ${path} timed out after ${String(timeoutMs)}ms`)
  }
  return cause instanceof Error ? cause : new Error(String(cause))
}

/** Shared proxy-free dispatcher for every loopback Gateway request. */
const LOOPBACK_DISPATCHER = new UndiciAgent({ connect: { timeout: 30_000 } })

function rawDataText(data: RawData): string {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return data.toString('utf8')
}
