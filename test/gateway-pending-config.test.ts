import { describe, expect, it, vi } from 'vitest'
import type { ControlFrame, FollowFrame } from '../src/gateway/gateway-wire.js'


vi.mock('vscode', () => ({
  EventEmitter: class {
    fire(): void {}
    event = (): { dispose(): void } => ({ dispose: () => {} })
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: () => undefined, update: async () => {} }),
  },
  l10n: { t: (message: string): string => message },
  env: { openExternal: async () => true },
}))

import * as vscode from 'vscode'

import { HarnessGatewayService } from '../src/gateway/harness-gateway-service.js'
import { worktreeAutoMergeMode } from '../src/config/configuration.js'
import type { HarnessHostRuntime } from '../src/runtime/web-runtime.js'
import type { ConfigurationService } from '../src/config/configuration.js'
import type { ConnectionSettingsService } from '../src/services/connection-settings-service.js'
import type { WorktreeService } from '../src/editor/worktree-service.js'
import type { Memento, OutputChannel } from 'vscode'

interface TestClient {
  abortPendingRequests: ReturnType<typeof vi.fn>
  probe: ReturnType<typeof vi.fn>
  sessionList: ReturnType<typeof vi.fn>
  sessionCreate: ReturnType<typeof vi.fn>
  sessionSelectModel: ReturnType<typeof vi.fn>
  sessionPrompt: ReturnType<typeof vi.fn>
  sessionUpdateQueue: ReturnType<typeof vi.fn>
  sessionCancel: ReturnType<typeof vi.fn>
  sessionRename: ReturnType<typeof vi.fn>
  sessionFork: ReturnType<typeof vi.fn>
  sessionSearch: ReturnType<typeof vi.fn>
  sessionModelCatalog: ReturnType<typeof vi.fn>
  sessionPage: ReturnType<typeof vi.fn>
  sessionFollow: ReturnType<typeof vi.fn>
  sessionControl: ReturnType<typeof vi.fn>
  skillList: ReturnType<typeof vi.fn>
  subagentList: ReturnType<typeof vi.fn>
  subagentPrompt: ReturnType<typeof vi.fn>
  subagentInterrupt: ReturnType<typeof vi.fn>
  ensureLegacyCodePreset: ReturnType<typeof vi.fn>
  agentPresetList: ReturnType<typeof vi.fn>
  agentPresetSelect: ReturnType<typeof vi.fn>
  workspaceArchiveSession: ReturnType<typeof vi.fn>
  workspaceFollow: ReturnType<typeof vi.fn>
  remoteEvents: ReturnType<typeof vi.fn>
  resolveRemoteEvent: ReturnType<typeof vi.fn>
  goalCreate: ReturnType<typeof vi.fn>
  goalAction: ReturnType<typeof vi.fn>
  listCommands: ReturnType<typeof vi.fn>
  executeCommand: ReturnType<typeof vi.fn>
}

const CONFIG = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  agentPreset: 'standard',
}

function createService(configOverride: Record<string, unknown> = {}): { service: GatewayTestHarness; client: TestClient; persist: ReturnType<typeof vi.fn>; worktrees: Record<string, ReturnType<typeof vi.fn>>; runtime: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } } {
  const client: TestClient = {
    abortPendingRequests: vi.fn(),
    probe: vi.fn(),
    sessionList: vi.fn().mockResolvedValue([]),
    sessionCreate: vi.fn().mockResolvedValue({ sessionId: 's2', agentPreset: 'code' }),
    sessionSelectModel: vi.fn().mockResolvedValue({ selected: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }),
    sessionPrompt: vi.fn().mockResolvedValue({ accepted: true }),
    sessionUpdateQueue: vi.fn().mockResolvedValue({ accepted: true }),
    sessionCancel: vi.fn().mockResolvedValue({ accepted: true }),
    sessionRename: vi.fn().mockResolvedValue({ title: 't', seq: 0 }),
    sessionFork: vi.fn().mockResolvedValue({ sessionId: 's3' }),
    sessionSearch: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    sessionModelCatalog: vi.fn().mockResolvedValue({ default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, routableProviders: [], groups: [], failures: [] }),
    sessionPage: vi.fn().mockResolvedValue({ records: [], hasMore: false }),
    sessionFollow: vi.fn(),
    sessionControl: vi.fn(),
    skillList: vi.fn().mockResolvedValue({ skills: [] }),
    subagentList: vi.fn().mockResolvedValue({ entries: [], parentAvailable: true }),
    subagentPrompt: vi.fn().mockResolvedValue({ messageId: 'm1' }),
    subagentInterrupt: vi.fn().mockResolvedValue({ accepted: true }),
    ensureLegacyCodePreset: vi.fn().mockResolvedValue(undefined),
    agentPresetList: vi.fn().mockResolvedValue({ presets: [], authorable: false }),
    agentPresetSelect: vi.fn().mockResolvedValue('standard'),
    workspaceArchiveSession: vi.fn().mockResolvedValue({ archivedSessionIds: [] }),
    workspaceFollow: vi.fn(),
    remoteEvents: vi.fn(),
    resolveRemoteEvent: vi.fn(),
    goalCreate: vi.fn().mockResolvedValue({}),
    goalAction: vi.fn().mockResolvedValue({}),
    listCommands: vi.fn().mockResolvedValue([]),
    executeCommand: vi.fn().mockResolvedValue(undefined),
  }

  const runtime = {
    onDidChangeState: () => ({ dispose: () => {} }),
    state: { phase: 'idle' as const },
    start: vi.fn().mockResolvedValue('http://127.0.0.1:0'),
    stop: vi.fn(),
    restart: vi.fn(),
    dispose: vi.fn(),
  } as unknown as HarnessHostRuntime

  const configuration = {
    get: () => ({
      ...CONFIG,
      ...configOverride,
      worktreeAutoMerge: worktreeAutoMergeMode(configOverride.worktreeAutoMerge as string | undefined),
    }),
    setAgentPresetIfKnown: vi.fn(),
    setProviderIfConfigured: vi.fn(),
    setModelIfKnown: vi.fn(),
    setModelId: vi.fn(),
    setReasoningEffortIfKnown: vi.fn(),
  } as unknown as ConfigurationService

  const connectionSettings = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    refresh: vi.fn(),
    onDidChange: () => ({ dispose: () => {} }),
  } as unknown as ConnectionSettingsService

  const output = { appendLine: vi.fn() } as unknown as OutputChannel
  const persist = vi.fn(async () => {})
  const globalState = {
    get: () => undefined,
    update: persist,
  } as unknown as Memento
  const worktrees = {
    prepare: vi.fn(async () => ({ cwd: process.cwd(), isolated: false })),
    cleanupOrphans: vi.fn(async () => []),
    recover: vi.fn(async () => []),
    // Default: s1 is an ordinary isolated session, so existing tests never
    // trigger the auto-isolation migration. The migration tests below override
    // this to simulate a host-forked session with no worktree.
    recordFor: vi.fn(() => ({ sessionId: 's1', repoRoot: '/repo', baseBranch: 'main', branch: 'dsh/s1', worktreePath: '/repo/.dsh-worktrees/s1', createdAt: 1 })),
    repoRootFor: vi.fn(() => undefined),
    displayCwd: vi.fn((_sessionId: string, fallback: string | undefined) => fallback),
    diffText: vi.fn(async () => undefined),
    mergeBack: vi.fn(async () => ({ ok: false, message: 'stub' })),
    discard: vi.fn(async () => ({ ok: false, message: 'stub' })),
    workingTreeDirty: vi.fn(async () => false),
    workingTreeDiff: vi.fn(async () => undefined),
    dispose: vi.fn(),
  } as unknown as WorktreeService

  const service = new HarnessGatewayService(
    runtime,
    configuration,
    connectionSettings,
    output,
    globalState,
    worktrees,
  ) as unknown as GatewayTestHarness

  service.activeSessionId = 's1'
  service.summaries.set('s1', { running: false, blank: false, agentPreset: 'standard', updatedAt: 1 })
  service.client = client
  service.models = {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
    groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'Flash', reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }] } }] }],
  }
  return {
    service,
    client,
    persist,
    worktrees: worktrees as unknown as Record<string, ReturnType<typeof vi.fn>>,
    runtime: runtime as unknown as { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> },
  }
}

/** Structural view of the private gateway state the tests drive directly. */
interface GatewayTestHarness {
  client: TestClient | undefined
  activeSessionId: string | undefined
  summaries: Map<string, { running?: boolean; blank?: boolean; agentPreset?: string; updatedAt?: number }>
  pendingQueue: { pending: Map<string, unknown[]>; admitted: Set<string> }
  entries: unknown[]
  projections: Record<string, unknown>
  pendingCarryOver: { targetSessionId: string; message: string } | undefined
  metaStore: { effortIntents: Map<string, string>; metaBySession: Map<string, unknown> }
  models:
    | {
        current: { provider: string; model: string; reasoningEffort?: string }
        groups: { id: string; name: string; models: { id: string; name: string; reasoning?: { efforts: { id: string }[] } }[] }[]
        available?: boolean
        failures?: unknown[]
      }
    | undefined
  handleControl: (frame: ControlFrame) => void
  handleFollowFrame: (sessionId: string, frame: FollowFrame) => void
  handleRemoteEvent: (event: string, args: readonly unknown[]) => void
  sendPrompt: (text: string, mode?: 'queue' | 'steer', attachments?: unknown[], configuration?: unknown, signals?: unknown) => Promise<void>
  removeQueued: (itemId: string) => Promise<void>
  steerQueued: (itemId: string) => Promise<void>
  createSession: (agentPreset?: string) => Promise<string>
  queue: readonly { id: string; message: { content: readonly { type: string; text?: string }[] } }[]
  selectModel: (provider: string, model: string, reasoningEffort?: string, persist?: boolean, signals?: unknown) => Promise<void>
  mutateRuntime: <T>(mutation: () => Promise<T>) => Promise<T>
}

function config(reasoningEffort: string, agentPreset = 'standard'): unknown {
  return { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort, agentPreset }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('official control projections', () => {
  it('restores only the active session Inbox and model selection from a reconnect baseline', () => {
    const { service } = createService()
    const inbox = { 'next-step': [], 'next-turn': [{ id: 'pending', content: [{ type: 'text', text: 'continue' }] }] }
    const model = { provider: 'relay', model: 'custom', reasoningEffort: 'low' }
    service.handleControl({ type: 'baseline', value: { jobs: {}, projections: {
      s1: { asOfSeq: 4, values: { inbox, modelSelection: { next: model } } },
      s2: { asOfSeq: 8, values: { inbox: { 'next-turn': [{ id: 'other', content: [] }] }, modelSelection: { next: { provider: 'other', model: 'wrong' } } } },
    } } } as unknown as ControlFrame)
    expect(service.queue.map((item) => item.id)).toEqual(['pending'])
    expect(service.models?.current).toEqual(model)
    service.handleControl({ type: 'projection', sessionId: 's2', key: 'inbox', value: {}, seq: 9 } as unknown as ControlFrame)
    expect(service.queue.map((item) => item.id)).toEqual(['pending'])
    service.handleControl({ type: 'baseline', value: { jobs: {}, projections: {} } } as unknown as ControlFrame)
    expect(service.queue).toEqual([])
    expect(service.projections).toEqual({})
  })

  it('lets the provider choose reasoning when the official model has no effort catalog', async () => {
    const { service, client } = createService()
    service.models = { current: { provider: 'relay', model: 'unknown' }, groups: [{ id: 'relay', name: 'Relay', models: [{ id: 'unknown', name: 'Unknown' }] }] }
    await service.selectModel('relay', 'unknown', 'max')
    expect(client.sessionSelectModel).toHaveBeenCalledWith({ sessionId: 's1', provider: 'relay', model: 'unknown' })
  })
})

function turnEndFrame(sessionId: string): FollowFrame {
  void sessionId
  return {
    type: 'event',
    event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: 10, seq: 10 },
  } as unknown as FollowFrame
}

function idleBoundary(service: GatewayTestHarness): void {
  service.handleRemoteEvent('api-session/status', ['s1', false])
  service.handleFollowFrame('s1', turnEndFrame('s1'))
}

describe('gateway staged configuration', () => {
  it('applies the configuration before admission on the idle fast path', async () => {
    const { service, client } = createService()

    await service.sendPrompt('hello', 'queue', [], config('max'))

    expect(client.sessionSelectModel).toHaveBeenCalledTimes(1)
    expect(client.sessionSelectModel).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: 'max' }))
    expect(client.sessionPrompt).toHaveBeenCalledTimes(1)
    expect(service.pendingQueue.pending.size).toBe(0)
    // The optimistic admission marker is set until the turn events arrive.
    expect(service.pendingQueue.admitted.has('s1')).toBe(true)
  })

  it('parks the configuration while a turn is running instead of dropping it', async () => {
    const { service, client } = createService()
    service.summaries.set('s1', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })

    await service.sendPrompt('queued', 'queue', [], config('max'))

    expect(client.sessionSelectModel).not.toHaveBeenCalled()
    expect(client.sessionPrompt).toHaveBeenCalledTimes(1)
    expect(service.pendingQueue.pending.get('s1')).toHaveLength(1)
  })

  it('applies a staged model change ahead of admission when a queued prompt carries images', async () => {
    const { service, client } = createService()
    service.summaries.set('s1', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })
    service.models = {
      current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      groups: [],
    }
    const image = { kind: 'image', mediaType: 'image/png', data: 'Zm9v' }

    await service.sendPrompt('look at this', 'queue', [image], config('max'))

    // The image admission check runs at enqueue time against the live
    // selection, so the staged switch to deepseek-v4-flash must land first.
    expect(client.sessionSelectModel).toHaveBeenCalledTimes(1)
    expect(client.sessionSelectModel).toHaveBeenCalledWith(expect.objectContaining({ model: 'deepseek-v4-flash' }))
    expect(service.pendingQueue.pending.size).toBe(0)
    expect(client.sessionPrompt).toHaveBeenCalledTimes(1)
  })

  it('still parks the configuration when a queued image prompt keeps the model', async () => {
    const { service, client } = createService()
    service.summaries.set('s1', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })
    service.models = {
      current: { provider: 'deepseek-official', model: 'deepseek/deepseek-v4-flash' },
      groups: [],
    }
    const image = { kind: 'image', mediaType: 'image/png', data: 'Zm9v' }

    // Same provider and same bare model id (relay-prefixed current): nothing
    // to move, so the effort-only change keeps riding the pending queue.
    await service.sendPrompt('queued', 'queue', [image], config('max'))

    expect(client.sessionSelectModel).not.toHaveBeenCalled()
    expect(service.pendingQueue.pending.get('s1')).toHaveLength(1)
  })

  it('applies the parked configuration at the next turn boundary', async () => {
    const { service, client } = createService()
    service.summaries.set('s1', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })
    await service.sendPrompt('queued', 'queue', [], config('max'))
    expect(client.sessionSelectModel).not.toHaveBeenCalled()

    idleBoundary(service)
    await tick()

    expect(client.sessionSelectModel).toHaveBeenCalledTimes(1)
    expect(client.sessionSelectModel).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: 'max' }))
    expect(service.pendingQueue.pending.size).toBe(0)
  })

  it('retries a failed parked configuration at the following boundary', async () => {
    const { service, client } = createService()
    service.summaries.set('s1', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })
    await service.sendPrompt('queued', 'queue', [], config('max'))
    client.sessionSelectModel.mockRejectedValueOnce(new Error('transient'))

    idleBoundary(service)
    await tick()
    expect(service.pendingQueue.pending.get('s1')).toHaveLength(1)

    client.sessionSelectModel.mockResolvedValueOnce({ selected: { } })
    idleBoundary(service)
    await tick()
    expect(service.pendingQueue.pending.size).toBe(0)
  })

  it('keeps per-prompt FIFO order instead of sharing the last selection', async () => {
    const { service, client } = createService()
    service.summaries.set('s1', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })

    await service.sendPrompt('first', 'queue', [], config('max'))
    await service.sendPrompt('second', 'queue', [], config('low'))
    expect(service.pendingQueue.pending.get('s1')).toHaveLength(2)

    idleBoundary(service)
    await tick()
    idleBoundary(service)
    await tick()

    expect(client.sessionSelectModel.mock.calls.map((call) => call[0].reasoningEffort)).toEqual(['max', 'low'])
    expect(service.pendingQueue.pending.size).toBe(0)
  })

  it('treats a prompt admitted in the same tick as busy (no stale idle read)', async () => {
    const { service, client } = createService()
    service.summaries.set('s1', { running: false, blank: false, agentPreset: 'standard', updatedAt: 1 })

    await service.sendPrompt('first', 'queue', [], config('high'))
    expect(client.sessionSelectModel).toHaveBeenCalledTimes(1)

    // No turn events have arrived yet; the optimistic marker must force the
    // second prompt's configuration onto the deferred path.
    await service.sendPrompt('second', 'queue', [], config('low'))
    expect(client.sessionSelectModel).toHaveBeenCalledTimes(1)
    expect(client.sessionPrompt).toHaveBeenCalledTimes(2)
    expect(service.pendingQueue.pending.get('s1')).toHaveLength(1)
  })

  it('keeps carry-over ahead of the prompt when a mode switch creates a session', async () => {
    const { service, client } = createService()
    client.sessionList.mockResolvedValue([
      { sessionId: 's1', running: false, blank: false, agentPreset: 'standard', updatedAt: 1 },
      { sessionId: 's2', running: false, blank: true, agentPreset: 'code', updatedAt: 2 },
    ])
    service.summaries.set('s1', { running: false, blank: false, agentPreset: 'standard', updatedAt: 1 })
    service.entries = [{ event: {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'prior context' }] },
    } }]

    await service.sendPrompt('continue', 'queue', [], config('max', 'code'))

    const request = client.sessionPrompt.mock.calls.at(-1)?.[0] as { sessionId: string; content: Array<{ type: string; text?: string }> }
    expect(request.sessionId).toBe('s2')
    expect(request.content[0]?.text).toContain('<context-carry')
    expect(request.content.at(-1)?.text).toBe('continue')
    expect(service.pendingCarryOver).toBeUndefined()
  })

  it('rolls back the pending slot when admission fails', async () => {
    const { service, client } = createService()
    service.summaries.set('s1', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })
    client.sessionPrompt.mockRejectedValueOnce(new Error('boom'))

    await expect(service.sendPrompt('queued', 'queue', [], config('max'))).rejects.toThrow('boom')

    expect(service.pendingQueue.pending.size).toBe(0)
    expect(service.pendingQueue.admitted.has('s1')).toBe(false)
  })

  it('consumes config-less queue slots without applying anything', async () => {
    const { service, client } = createService()
    service.summaries.set('s1', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })
    await service.sendPrompt('plain', 'queue', [])
    expect(service.pendingQueue.pending.get('s1')).toHaveLength(1)

    idleBoundary(service)
    await tick()

    expect(client.sessionSelectModel).not.toHaveBeenCalled()
    expect(service.pendingQueue.pending.size).toBe(0)
  })

  it('drops stale configurations when a queued item is withdrawn', async () => {
    const { service } = createService()
    service.summaries.set('s1', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })
    await service.sendPrompt('queued', 'queue', [], config('max'))
    expect(service.pendingQueue.pending.get('s1')).toHaveLength(1)

    await service.removeQueued('item-1')

    expect(service.pendingQueue.pending.size).toBe(0)
  })

  it('does not update the in-memory effort intent when persistence fails', async () => {
    const { service, persist } = createService()
    persist.mockRejectedValueOnce(new Error('disk full'))

    await service.selectModel('deepseek-official', 'deepseek-v4-flash', 'low')

    expect(service.metaStore.effortIntents.has('s1')).toBe(false)
  })

  it('cleans per-session persisted overlays when the host removes a session', async () => {
    const { service, persist } = createService()
    service.metaStore.effortIntents.set('s1', 'auto')
    service.metaStore.metaBySession.set('s1', { pinned: true })

    service.handleRemoteEvent('api-session/removed', ['s1'])
    await tick()

    expect(service.metaStore.effortIntents.has('s1')).toBe(false)
    expect(service.metaStore.metaBySession.has('s1')).toBe(false)
    expect(persist).toHaveBeenCalled()
  })
})

describe('gateway auto model matching', () => {
  const catalog: NonNullable<GatewayTestHarness['models']> = {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    groups: [
      {
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [
          { id: 'deepseek-v4-flash', name: 'Flash', reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }] } },
          { id: 'deepseek-v4-pro', name: 'Pro', reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }] } },
        ],
      },
    ],
    available: true,
    failures: [],
  }

  it('escalates a heavy auto prompt to the deep-reasoning model', async () => {
    const { service, client } = createService()
    service.models = catalog

    await service.sendPrompt('very large task', 'queue', [], config('auto'), { promptTokens: 12_000, attachmentCount: 0 })

    expect(client.sessionSelectModel).toHaveBeenCalledWith(expect.objectContaining({ model: 'deepseek-v4-pro' }))
  })

  it('keeps the fast model for a light auto prompt', async () => {
    const { service, client } = createService()
    service.models = catalog

    await service.sendPrompt('hi', 'queue', [], config('auto'), { promptTokens: 100, attachmentCount: 0 })

    expect(client.sessionSelectModel).toHaveBeenCalledWith(expect.objectContaining({ model: 'deepseek-v4-flash' }))
  })

  it('resolves the auto tier against the chosen model, not the staged one', async () => {
    const { service, client } = createService()
    service.models = catalog

    // Staged model is flash, but the heavy signals escalate to pro; the
    // resolved reasoning effort must come from pro's options ('max').
    await service.sendPrompt('big', 'queue', [], config('auto'), { promptTokens: 9_000, attachmentCount: 1 })

    expect(client.sessionSelectModel).toHaveBeenCalledWith(expect.objectContaining({
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    }))
  })

  it('leaves the model untouched when auto signals are absent', async () => {
    const { service, client } = createService()
    service.models = catalog

    await service.sendPrompt('hello', 'queue', [], config('auto'))

    expect(client.sessionSelectModel).toHaveBeenCalledWith(expect.objectContaining({ model: 'deepseek-v4-flash' }))
  })
})

describe('gateway auto-isolation of host-forked sessions', () => {
  it('moves a worktree-less session into a fresh isolated session on first send', async () => {
    const { service, client, worktrees } = createService()
    // A session that arrived through the host's native fork path has no
    // worktree record (uuid id, inherited shared cwd).
    vi.mocked(worktrees.recordFor!).mockReturnValue(undefined)
    // createSession() rebuilds the summary map from sessions.list.
    client.sessionList.mockResolvedValue([
      { sessionId: 's2', running: false, blank: true, agentPreset: 'standard', updatedAt: 2 },
    ])

    await service.sendPrompt('hello', 'queue', [])

    // The conversation moved: a fresh session was created (createSession) and
    // the prompt was admitted against the new isolated session.
    expect(client.sessionCreate).toHaveBeenCalledTimes(1)
    expect(service.activeSessionId).toBe('s2')
    expect(client.sessionPrompt).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's2' }))
  })

  it('skips auto-isolation when the shared checkout has uncommitted changes', async () => {
    const { service, client, worktrees } = createService()
    vi.mocked(worktrees.recordFor!).mockReturnValue(undefined)
    vi.mocked(worktrees.workingTreeDirty!).mockResolvedValue(true)
    ;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: '/repo' } }]
    try {
      await service.sendPrompt('hello', 'queue', [])

      // Dirty checkout: migration would strand its changes outside the worktree.
      expect(client.sessionCreate).not.toHaveBeenCalled()
      expect(service.activeSessionId).toBe('s1')
      expect(client.sessionPrompt).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }))
    } finally {
      ;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined
    }
  })

  it('does not migrate an already-isolated session', async () => {
    const { service, client } = createService()
    // Default mock: recordFor returns an s1 record (isolated).

    await service.sendPrompt('hello', 'queue', [])

    expect(client.sessionCreate).not.toHaveBeenCalled()
    expect(service.activeSessionId).toBe('s1')
    expect(client.sessionPrompt).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }))
  })
})

describe('gateway worktree auto-merge', () => {
  it('merges an isolated session back on turn/end when worktreeAutoMerge is onTurnEnd', async () => {
    const { service, worktrees } = createService({ worktreeAutoMerge: 'onTurnEnd' })
    vi.mocked(worktrees.mergeBack!).mockResolvedValue({ ok: true, message: 'merged' })

    service.handleFollowFrame('s1', turnEndFrame('s1'))
    await tick()
    await tick()

    expect(worktrees.mergeBack).toHaveBeenCalledTimes(1)
    expect(worktrees.mergeBack).toHaveBeenCalledWith('s1')
  })

  it('keeps the worktree untouched on turn/end when worktreeAutoMerge is never', async () => {
    const { service, worktrees } = createService({ worktreeAutoMerge: 'never' })

    service.handleFollowFrame('s1', turnEndFrame('s1'))
    await tick()

    expect(worktrees.mergeBack).not.toHaveBeenCalled()
  })

  it('defaults to onTurnEnd when the setting is not configured', async () => {
    const { service, worktrees } = createService()
    vi.mocked(worktrees.mergeBack!).mockResolvedValue({ ok: true, message: 'merged' })

    service.handleFollowFrame('s1', turnEndFrame('s1'))
    await tick()
    await tick()

    expect(worktrees.mergeBack).toHaveBeenCalledTimes(1)
  })

  it('skips auto-merge for sessions without an isolated worktree', async () => {
    const { service, worktrees } = createService({ worktreeAutoMerge: 'onTurnEnd' })
    vi.mocked(worktrees.recordFor!).mockReturnValue(undefined)

    service.handleFollowFrame('s1', turnEndFrame('s1'))
    await tick()

    expect(worktrees.mergeBack).not.toHaveBeenCalled()
  })

  it('does not run concurrent merges for the same session', async () => {
    const { service, worktrees } = createService({ worktreeAutoMerge: 'onTurnEnd' })
    let resolveMerge: (() => void) | undefined
    let calls = 0
    vi.mocked(worktrees.mergeBack!).mockImplementation(async () => {
      calls += 1
      await new Promise<void>((resolve) => { resolveMerge = resolve })
      return { ok: true, message: 'merged' }
    })

    // Two adjacent turn/end events arrive before the first merge settles.
    service.handleFollowFrame('s1', turnEndFrame('s1'))
    service.handleFollowFrame('s1', turnEndFrame('s1'))
    await tick()
    expect(calls).toBe(1)

    resolveMerge?.()
    await tick()
    await tick()
    expect(calls).toBe(1)
  })
})

describe('gateway createSession deduplication', () => {
  /** A sessionCreate that registers the created session with sessionList. */
  function registeringCreate(client: TestClient, createdId: string): void {
    client.sessionCreate.mockImplementation(async () => {
      client.sessionList.mockResolvedValue([
        { sessionId: 's1', running: false, blank: false, agentPreset: 'standard', updatedAt: 1 },
        { sessionId: createdId, running: false, blank: true, agentPreset: 'standard', updatedAt: 2 },
      ])
      return { sessionId: createdId, agentPreset: 'standard' }
    })
  }

  it('coalesces concurrent new-session calls onto a single creation', async () => {
    const { service, client, worktrees } = createService()
    let resolveCreate: ((value: { sessionId: string; agentPreset: string }) => void) | undefined
    let calls = 0
    client.sessionCreate.mockImplementation(() => {
      calls += 1
      return new Promise((resolve) => { resolveCreate = resolve })
    })

    // A ＋ click storm: three calls arrive before the first settles.
    const first = service.createSession()
    const second = service.createSession()
    const third = service.createSession()

    client.sessionList.mockResolvedValue([
      { sessionId: 's1', running: false, blank: false, agentPreset: 'standard', updatedAt: 1 },
      { sessionId: 's2', running: false, blank: true, agentPreset: 'standard', updatedAt: 2 },
    ])
    // Let the worktree prepare microtask settle so sessionCreate (and thus
    // resolveCreate) has actually been reached before we resolve it.
    await tick()
    resolveCreate?.({ sessionId: 's2', agentPreset: 'standard' })
    const results = await Promise.all([first, second, third])
    await tick()

    expect(calls).toBe(1)
    expect(results).toEqual(['s2', 's2', 's2'])
    expect(worktrees.prepare).toHaveBeenCalledTimes(1)
  }, 15_000)

  it('starts a fresh creation after the previous one settles', async () => {
    const { service, client } = createService()
    let resolveCreate: ((value: { sessionId: string; agentPreset: string }) => void) | undefined
    client.sessionCreate.mockImplementation(() => new Promise((resolve) => { resolveCreate = resolve }))

    const first = service.createSession()
    client.sessionList.mockResolvedValue([
      { sessionId: 's1', running: false, blank: false, agentPreset: 'standard', updatedAt: 1 },
      { sessionId: 's2', running: false, blank: true, agentPreset: 'standard', updatedAt: 2 },
    ])
    await tick()
    resolveCreate?.({ sessionId: 's2', agentPreset: 'standard' })
    await first
    await tick()

    registeringCreate(client, 's3')
    const second = await service.createSession()
    expect(client.sessionCreate).toHaveBeenCalledTimes(2)
    expect(second).toBe('s3')
  }, 15_000)

  it('releases the dedup slot when creation fails', async () => {
    const { service, client } = createService()
    client.sessionCreate.mockRejectedValueOnce(new Error('boom'))

    await expect(service.createSession()).rejects.toThrow('boom')

    registeringCreate(client, 's4')
    const retried = await service.createSession()
    expect(client.sessionCreate).toHaveBeenCalledTimes(2)
    expect(retried).toBe('s4')
  })
})

describe('gateway steerQueued (send now)', () => {
  function queueItem(id: string, text = 'hello', image = false): GatewayTestHarness['queue'][number] {
    const content = image
      ? [{ type: 'image' as const }]
      : [{ type: 'text' as const, text }]
    return { id, message: { content } }
  }

  it('promotes the item through the host steer when it is accepted', async () => {
    const { service, client } = createService()
    service.queue = [queueItem('q1')]

    await service.steerQueued('q1')

    expect(client.sessionUpdateQueue).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'q1', action: { kind: 'steer' } }))
    expect(client.sessionPrompt).not.toHaveBeenCalled()
  })

  it('silently ignores an item the turn already claimed', async () => {
    const { service, client } = createService()
    service.queue = [queueItem('q1')]
    vi.mocked(client.sessionUpdateQueue).mockRejectedValueOnce(
      Object.assign(new Error('already claimed'), { code: 'queue-item-not-found' }),
    )

    await expect(service.steerQueued('q1')).resolves.toBeUndefined()

    expect(client.sessionPrompt).not.toHaveBeenCalled()
  })

  it('interrupts a running turn with a steer prompt when the queue steer is refused', async () => {
    const { service, client } = createService()
    service.queue = [queueItem('q1')]
    vi.mocked(client.sessionUpdateQueue)
      .mockRejectedValueOnce(
        Object.assign(new Error('no longer steerable'), { code: 'steer-unavailable' }),
      )
      .mockResolvedValueOnce({ accepted: true } as never)
    vi.mocked(client.sessionPrompt).mockResolvedValueOnce({ accepted: true } as never)

    await service.steerQueued('q1')

    expect(client.sessionPrompt).toHaveBeenCalledTimes(1)
    expect(client.sessionPrompt).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'steer',
      content: [{ type: 'text', text: 'hello' }],
    }))
  })

  it('falls back to a queued prompt when the idle agent refuses steering', async () => {
    const { service, client } = createService()
    service.queue = [queueItem('q1')]
    vi.mocked(client.sessionUpdateQueue)
      .mockRejectedValueOnce(
        Object.assign(new Error('idle'), { code: 'steer-unavailable' }),
      )
      .mockResolvedValueOnce({ accepted: true } as never)
    vi.mocked(client.sessionPrompt)
      .mockRejectedValueOnce(Object.assign(new Error('prompt rejected'), { code: 'agent-busy' }))
      .mockResolvedValueOnce({ accepted: true } as never)

    await service.steerQueued('q1')

    expect(client.sessionPrompt).toHaveBeenCalledTimes(2)
    expect(client.sessionPrompt).toHaveBeenNthCalledWith(1, expect.objectContaining({ mode: 'steer' }))
    expect(client.sessionPrompt).toHaveBeenNthCalledWith(2, expect.objectContaining({ mode: 'queue' }))
  })

  it('keeps the original error for image items instead of re-submitting them', async () => {
    const { service, client } = createService()
    service.queue = [queueItem('q1', 'hello', true)]
    vi.mocked(client.sessionUpdateQueue).mockRejectedValueOnce(
      Object.assign(new Error('no longer steerable'), { code: 'steer-unavailable' }),
    )

    await expect(service.steerQueued('q1')).rejects.toThrow('no longer steerable')

    expect(client.sessionUpdateQueue).toHaveBeenCalledTimes(1)
    expect(client.sessionPrompt).not.toHaveBeenCalled()
  })
})

describe('start baseline watchdog', () => {
  /** Lets start() drive the real baseline against the stub client. */
  function wireClient(service: GatewayTestHarness, client: TestClient): void {
    (service as unknown as { createGatewayClient: () => unknown }).createGatewayClient = () => client
  }

  it('does not consume the baseline budget while the runtime is still booting', async () => {
    vi.useFakeTimers()
    try {
      const { service, client, runtime } = createService()
      // A slow first boot after an extension update: the process announces its
      // URL only 60s in — past the old 45s whole-start watchdog.
      runtime.start.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve('http://127.0.0.1:0'), 60_000)),
      )
      wireClient(service, client)

      const started = (service as unknown as { start(): Promise<void> }).start()
      await vi.advanceTimersByTimeAsync(95_000)
      await started

      expect(client.probe).toHaveBeenCalled()
      expect(runtime.stop).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops the runtime when a baseline RPC hangs past the deadline', async () => {
    vi.useFakeTimers()
    try {
      const { service, client, runtime } = createService()
      client.probe.mockImplementation(() => new Promise(() => undefined))
      wireClient(service, client)

      const started = (service as unknown as { start(): Promise<void> }).start()
      await vi.advanceTimersByTimeAsync(50_000)
      await started

      expect(runtime.stop).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retires the timed-out client so a late baseline cannot start stale streams', async () => {
    vi.useFakeTimers()
    try {
      const { service, client, runtime } = createService()
      let rejectProbe!: (error: Error) => void
      client.probe.mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectProbe = reject }))
      client.abortPendingRequests.mockImplementation(() => rejectProbe(new Error('Gateway client closed.')))
      wireClient(service, client)

      const started = (service as unknown as { start(): Promise<void> }).start()
      await vi.advanceTimersByTimeAsync(50_000)
      await started

      expect(client.abortPendingRequests).toHaveBeenCalledOnce()
      expect(runtime.stop).toHaveBeenCalledOnce()
      // The retired baseline's promise has already been rejected; releasing
      // it later cannot make the service start another event-stream pump.
      expect(client.sessionControl).not.toHaveBeenCalled()
      expect(client.sessionFollow).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for every running session before mutating the runtime', async () => {
    vi.useFakeTimers()
    try {
      const { service, runtime } = createService()
      const events: string[] = []
      service.summaries.set('background', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })
      ;(service as unknown as { start: () => Promise<void> }).start = vi.fn(async () => { events.push('restart') })
      const mutation = service.mutateRuntime(async () => { events.push('mutation') })
      await vi.advanceTimersByTimeAsync(250)
      expect(events).toEqual([])

      service.summaries.set('background', { running: false, blank: false, agentPreset: 'standard', updatedAt: 1 })
      await vi.advanceTimersByTimeAsync(100)
      await mutation
      expect(events).toEqual(['mutation', 'restart'])
      expect(runtime.stop).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('gates a prompt while a profile mutation is restarting the Gateway', async () => {
    const { service, client } = createService()
    let releaseMutation!: () => void
    const holdMutation = new Promise<void>((resolve) => { releaseMutation = resolve })
    ;(service as unknown as { start: () => Promise<void> }).start = vi.fn(async () => {
      ;(service as unknown as { client: TestClient }).client = client
    })
    const mutation = service.mutateRuntime(async () => await holdMutation)
    await vi.waitFor(() => expect(client.abortPendingRequests).toHaveBeenCalledOnce())
    const prompt = service.sendPrompt('queued behind install')
    await Promise.resolve()
    expect(client.sessionPrompt).not.toHaveBeenCalled()
    releaseMutation()
    await mutation
    await prompt
    expect(client.sessionPrompt).toHaveBeenCalledOnce()
  })
})
