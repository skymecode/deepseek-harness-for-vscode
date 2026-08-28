import { describe, expect, it, vi } from 'vitest'
import type { MuxFrame, RpcId } from '@deepseek-ai/dsh-client-connection/client'
import type { HostFrame } from '@deepseek-ai/dsh-client-connection/client'

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

import { HarnessGatewayService } from '../src/gateway/harness-gateway-service.js'
import type { HarnessHostRuntime } from '../src/runtime/web-runtime.js'
import type { ConfigurationService } from '../src/config/configuration.js'
import type { ConnectionSettingsService } from '../src/services/connection-settings-service.js'
import type { WorktreeService } from '../src/editor/worktree-service.js'
import type { Memento, OutputChannel } from 'vscode'

interface TestClient {
  workspace: { list: ReturnType<typeof vi.fn>; archiveSession: ReturnType<typeof vi.fn> }
  sessions: {
    list: ReturnType<typeof vi.fn>
    history: ReturnType<typeof vi.fn>
    models: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    selectModel: ReturnType<typeof vi.fn>
    prompt: ReturnType<typeof vi.fn>
    updateQueue: ReturnType<typeof vi.fn>
  }
  skills: { list: ReturnType<typeof vi.fn> }
  subagents: { list: ReturnType<typeof vi.fn> }
  agentPresets: { list: ReturnType<typeof vi.fn> }
  host: { describe: ReturnType<typeof vi.fn> }
}

const CONFIG = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  agentPreset: 'standard',
}

function createService(): { service: GatewayTestHarness; client: TestClient; persist: ReturnType<typeof vi.fn> } {
  const client: TestClient = {
    workspace: { list: vi.fn(), archiveSession: vi.fn() },
    sessions: {
      list: vi.fn().mockResolvedValue({ result: { ok: true, value: { items: [] } } }),
      history: vi.fn().mockResolvedValue({ result: { ok: true, value: { events: [], hasMore: false } } }),
      models: vi.fn().mockResolvedValue({ result: { ok: true, value: { current: {}, groups: [] } } }),
      create: vi.fn().mockResolvedValue({ result: { ok: true, value: { sessionId: 's2', agentPreset: 'code' } } }),
      selectModel: vi.fn().mockResolvedValue({ result: { ok: true, value: { selected: {} } } }),
      prompt: vi.fn().mockResolvedValue({ result: { ok: true, value: { accepted: true } } }),
      updateQueue: vi.fn().mockResolvedValue({ result: { ok: true, value: { accepted: true } } }),
    },
    skills: { list: vi.fn().mockResolvedValue({ result: { ok: true, value: { skills: [] } } }) },
    subagents: { list: vi.fn().mockResolvedValue({ result: { ok: true, value: { entries: [] } } }) },
    agentPresets: { list: vi.fn().mockResolvedValue({ result: { ok: true, value: { presets: [] } } }) },
    host: { describe: vi.fn().mockResolvedValue({ result: { ok: true, value: {} } }) },
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
    get: () => ({ ...CONFIG }),
    setAgentPresetIfKnown: vi.fn(),
    setProviderIfConfigured: vi.fn(),
    setModelIfKnown: vi.fn(),
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
    recordFor: vi.fn(() => undefined),
    repoRootFor: vi.fn(() => undefined),
    displayCwd: vi.fn((_sessionId: string, fallback: string | undefined) => fallback),
    forgetSession: vi.fn(),
    diffText: vi.fn(async () => undefined),
    mergeBack: vi.fn(async () => ({ ok: false, message: 'stub' })),
    discard: vi.fn(async () => ({ ok: false, message: 'stub' })),
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
  return { service, client, persist }
}

/** Structural view of the private gateway state the tests drive directly. */
interface GatewayTestHarness {
  client: TestClient | undefined
  activeSessionId: string | undefined
  summaries: Map<string, { running?: boolean; blank?: boolean; agentPreset?: string; updatedAt?: number }>
  queue: unknown[]
  pendingConfigurations: Map<string, unknown[]>
  admittedSessions: Set<string>
  entries: unknown[]
  pendingCarryOver: { targetSessionId: string; message: string } | undefined
  effortIntents: Map<string, string>
  metaBySession: Map<string, unknown>
  handleMux: (rpcId: RpcId, frame: MuxFrame) => void
  handleHost: (frame: HostFrame) => void
  sendPrompt: (text: string, mode?: 'queue' | 'steer', attachments?: unknown[], configuration?: unknown, signals?: unknown) => Promise<void>
  steerQueued: (itemId: string) => Promise<void>
  removeQueued: (itemId: string) => Promise<void>
  selectModel: (provider: string, model: string, reasoningEffort?: string, persist?: boolean, signals?: unknown) => Promise<void>
}

function config(reasoningEffort: string, agentPreset = 'standard'): unknown {
  return { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort, agentPreset }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function turnEndFrame(sessionId: string): MuxFrame {
  return {
    type: 'session/event',
    sessionId,
    event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: 10, seq: 10 },
  } as unknown as MuxFrame
}

function idleBoundary(service: GatewayTestHarness): void {
  service.handleHost({ type: 'host/session-status', sessionId: 's1', running: false } as unknown as HostFrame)
  service.handleMux('rpc-boundary' as unknown as RpcId, turnEndFrame('s1'))
}

describe('gateway staged configuration', () => {
  it('applies the configuration before admission on the idle fast path', async () => {
    const { service, client } = createService()

    await service.sendPrompt('hello', 'queue', [], config('max'))

    expect(client.sessions.selectModel).toHaveBeenCalledTimes(1)
    expect(client.sessions.selectModel).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: 'max' }))
    expect(client.sessions.prompt).toHaveBeenCalledTimes(1)
    expect(service.pendingConfigurations.size).toBe(0)
    // The optimistic admission marker is set until the turn events arrive.
    expect(service.admittedSessions.has('s1')).toBe(true)
  })

  it('parks the configuration while a turn is running instead of dropping it', async () => {
    const { service, client } = createService()
    service.summaries.set('s1', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })

    await service.sendPrompt('queued', 'queue', [], config('max'))

    expect(client.sessions.selectModel).not.toHaveBeenCalled()
    expect(client.sessions.prompt).toHaveBeenCalledTimes(1)
    expect(service.pendingConfigurations.get('s1')).toHaveLength(1)
  })

  it('applies the parked configuration at the next turn boundary', async () => {
    const { service, client } = createService()
    service.summaries.set('s1', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })
    await service.sendPrompt('queued', 'queue', [], config('max'))
    expect(client.sessions.selectModel).not.toHaveBeenCalled()

    idleBoundary(service)
    await tick()

    expect(client.sessions.selectModel).toHaveBeenCalledTimes(1)
    expect(client.sessions.selectModel).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: 'max' }))
    expect(service.pendingConfigurations.size).toBe(0)
  })

  it('retries a failed parked configuration at the following boundary', async () => {
    const { service, client } = createService()
    service.summaries.set('s1', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })
    await service.sendPrompt('queued', 'queue', [], config('max'))
    client.sessions.selectModel.mockRejectedValueOnce(new Error('transient'))

    idleBoundary(service)
    await tick()
    expect(service.pendingConfigurations.get('s1')).toHaveLength(1)

    client.sessions.selectModel.mockResolvedValueOnce({ result: { ok: true, value: { selected: {} } } })
    idleBoundary(service)
    await tick()
    expect(service.pendingConfigurations.size).toBe(0)
  })

  it('keeps per-prompt FIFO order instead of sharing the last selection', async () => {
    const { service, client } = createService()
    service.summaries.set('s1', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })

    await service.sendPrompt('first', 'queue', [], config('max'))
    await service.sendPrompt('second', 'queue', [], config('low'))
    expect(service.pendingConfigurations.get('s1')).toHaveLength(2)

    idleBoundary(service)
    await tick()
    idleBoundary(service)
    await tick()

    expect(client.sessions.selectModel.mock.calls.map((call) => call[0].reasoningEffort)).toEqual(['max', 'low'])
    expect(service.pendingConfigurations.size).toBe(0)
  })

  it('treats a prompt admitted in the same tick as busy (no stale idle read)', async () => {
    const { service, client } = createService()
    service.summaries.set('s1', { running: false, blank: false, agentPreset: 'standard', updatedAt: 1 })

    await service.sendPrompt('first', 'queue', [], config('high'))
    expect(client.sessions.selectModel).toHaveBeenCalledTimes(1)

    // No turn events have arrived yet; the optimistic marker must force the
    // second prompt's configuration onto the deferred path.
    await service.sendPrompt('second', 'queue', [], config('low'))
    expect(client.sessions.selectModel).toHaveBeenCalledTimes(1)
    expect(client.sessions.prompt).toHaveBeenCalledTimes(2)
    expect(service.pendingConfigurations.get('s1')).toHaveLength(1)
  })

  it('keeps carry-over ahead of the prompt when a mode switch creates a session', async () => {
    const { service, client } = createService()
    client.sessions.list.mockResolvedValue({ result: { ok: true, value: {
      items: [
        { sessionId: 's1', running: false, blank: false, agentPreset: 'standard', updatedAt: 1 },
        { sessionId: 's2', running: false, blank: true, agentPreset: 'code', updatedAt: 2 },
      ],
    } } })
    service.summaries.set('s1', { running: false, blank: false, agentPreset: 'standard', updatedAt: 1 })
    service.entries = [{ event: {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'prior context' }] },
    } }]

    await service.sendPrompt('continue', 'queue', [], config('max', 'code'))

    const request = client.sessions.prompt.mock.calls.at(-1)?.[0] as { sessionId: string; content: Array<{ type: string; text?: string }> }
    expect(request.sessionId).toBe('s2')
    expect(request.content[0]?.text).toContain('<context-carry')
    expect(request.content.at(-1)?.text).toBe('continue')
    expect(service.pendingCarryOver).toBeUndefined()
  })

  it('rolls back the pending slot when admission fails', async () => {
    const { service, client } = createService()
    service.summaries.set('s1', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })
    client.sessions.prompt.mockResolvedValueOnce({ result: { ok: false, error: { message: 'boom' } } })

    await expect(service.sendPrompt('queued', 'queue', [], config('max'))).rejects.toThrow('boom')

    expect(service.pendingConfigurations.size).toBe(0)
    expect(service.admittedSessions.has('s1')).toBe(false)
  })

  it('consumes config-less queue slots without applying anything', async () => {
    const { service, client } = createService()
    service.summaries.set('s1', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })
    await service.sendPrompt('plain', 'queue', [])
    expect(service.pendingConfigurations.get('s1')).toHaveLength(1)

    idleBoundary(service)
    await tick()

    expect(client.sessions.selectModel).not.toHaveBeenCalled()
    expect(service.pendingConfigurations.size).toBe(0)
  })

  it('drops stale configurations when a queued item is withdrawn', async () => {
    const { service } = createService()
    service.summaries.set('s1', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })
    await service.sendPrompt('queued', 'queue', [], config('max'))
    expect(service.pendingConfigurations.get('s1')).toHaveLength(1)

    await service.removeQueued('item-1')

    expect(service.pendingConfigurations.size).toBe(0)
  })

  it('drops stale configurations when steer falls back to re-send', async () => {
    const { service, client } = createService()
    service.summaries.set('s1', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })
    service.queue = [{ id: 'item-1', message: { content: [{ type: 'text', text: 'queued' }] } }]
    await service.sendPrompt('queued', 'queue', [], config('max'))
    client.sessions.updateQueue.mockResolvedValueOnce({ result: { ok: false, error: { code: 'steer-unavailable', message: 'idle' } } })
      .mockResolvedValueOnce({ result: { ok: true, value: { accepted: true } } })

    await service.steerQueued('item-1')

    expect(client.sessions.updateQueue.mock.calls.map((call) => call[0].action.kind)).toEqual(['steer', 'remove'])
    expect(client.sessions.prompt).toHaveBeenCalledTimes(2)
    expect(service.pendingConfigurations.size).toBe(0)
  })

  it('does not update the in-memory effort intent when persistence fails', async () => {
    const { service, persist } = createService()
    persist.mockRejectedValueOnce(new Error('disk full'))

    await service.selectModel('deepseek-official', 'deepseek-v4-flash', 'low')

    expect(service.effortIntents.has('s1')).toBe(false)
  })

  it('cleans per-session persisted overlays when the host removes a session', async () => {
    const { service, persist } = createService()
    service.effortIntents.set('s1', 'auto')
    service.metaBySession.set('s1', { pinned: true })

    service.handleHost({ type: 'host/session-removed', sessionId: 's1' } as unknown as HostFrame)
    await tick()

    expect(service.effortIntents.has('s1')).toBe(false)
    expect(service.metaBySession.has('s1')).toBe(false)
    expect(persist).toHaveBeenCalled()
  })
})
