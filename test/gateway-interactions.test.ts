import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Memento, OutputChannel } from 'vscode'
import type { ConfigurationService } from '../src/config/configuration.js'
import type { WorktreeService } from '../src/editor/worktree-service.js'
import type { HarnessHostRuntime } from '../src/runtime/web-runtime.js'
import type { ConnectionSettingsService } from '../src/services/connection-settings-service.js'
import type { NodeGatewayClient } from '../src/gateway/node-gateway-client.js'
import type { PendingInteractions } from '../src/gateway/pending-interactions.js'
import type { SessionSummary } from '../src/gateway/gateway-wire.js'
import { RemoteEventQueue } from './helpers/remote-event-queue.js'
import { approvalFrame, questionFrame } from './helpers/interaction-frames.js'

vi.mock('vscode', () => ({
  EventEmitter: class { fire(): void {} dispose(): void {} event = () => ({ dispose(): void {} }) },
  workspace: { workspaceFolders: undefined },
  l10n: { t: (message: string, ...args: unknown[]): string => message.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)])) },
  window: { showWarningMessage: vi.fn(), showInformationMessage: vi.fn() },
  commands: { executeCommand: vi.fn() },
}))

import * as vscode from 'vscode'
import { HarnessGatewayService } from '../src/gateway/harness-gateway-service.js'

interface GatewayInternals {
  client: NodeGatewayClient | undefined
  activeSessionId: string | undefined
  summaries: Map<string, SessionSummary>
  interactions: PendingInteractions
  pumpRemoteEvents(signal: AbortSignal): Promise<void>
  waitToReconnect(signal: AbortSignal): Promise<void>
  handleRemoteEvent(event: string, args: readonly unknown[]): void
  disconnect(): void
  fireChange(): void
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
})

function fixture() {
  vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined)
  vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined)
  const service = new HarnessGatewayService(
    { onDidChangeState: () => ({ dispose(): void {} }) } as unknown as HarnessHostRuntime,
    { get: () => ({}) } as unknown as ConfigurationService,
    { disconnect: vi.fn(), hasConfiguredProvider: () => true } as unknown as ConnectionSettingsService,
    { appendLine: vi.fn() } as unknown as OutputChannel,
    { get: () => undefined, update: vi.fn() } as unknown as Memento,
    { recordFor: () => undefined, displayCwd: () => undefined } as unknown as WorktreeService,
  )
  const state = service as unknown as GatewayInternals
  const fireChange = vi.spyOn(state, 'fireChange').mockImplementation(() => {})
  const wait = vi.spyOn(state, 'waitToReconnect').mockImplementation(async (signal) => {
    if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
  })
  const queues: RemoteEventQueue[] = []
  const running: { abort: AbortController; task: Promise<void> }[] = []
  let currentQueue = new RemoteEventQueue()
  const client = { remoteEvents: vi.fn(() => currentQueue.read()), resolveRemoteEvent: vi.fn().mockResolvedValue(undefined) }
  state.client = client as unknown as NodeGatewayClient
  state.activeSessionId = 'foreground'
  for (const id of ['foreground', 'background', 'child-session']) {
    state.summaries.set(id, {
      sessionId: id as SessionSummary['sessionId'], running: true, blank: false, updatedAt: 1,
      projections: { asOfSeq: 0, values: { title: id } },
    })
  }
  const nextQueue = (): RemoteEventQueue => {
    currentQueue = new RemoteEventQueue()
    queues.push(currentQueue)
    return currentQueue
  }
  const start = () => {
    const queue = nextQueue()
    const abort = new AbortController()
    const task = state.pumpRemoteEvents(abort.signal)
    running.push({ abort, task })
    return { queue, abort, task }
  }
  cleanups.push(async () => {
    for (const run of running) run.abort.abort()
    for (const queue of queues) queue.close()
    await Promise.all(running.map((run) => run.task))
    service.dispose()
  })
  return { service, state, client, fireChange, wait, start, nextQueue }
}

describe('Gateway interaction integration', () => {
  it('receives official requests, routes them by agentId and publishes only the selected session', async () => {
    const { service, state, start } = fixture()
    const { queue } = start()
    queue.push({ type: 'ready', clientId: 'client-1' }, approvalFrame(), questionFrame('child-session'))
    await vi.waitFor(() => expect(state.interactions.forSession('child-session').questions).toHaveLength(1))
    expect((await service.snapshot()).active).toMatchObject({ approvals: [], questions: [] })
    state.activeSessionId = 'background'
    expect((await service.snapshot()).active?.approvals).toHaveLength(1)
    state.activeSessionId = 'child-session'
    expect((await service.snapshot()).active?.questions).toHaveLength(1)
    state.activeSessionId = 'background'
    expect((await service.snapshot()).active?.approvals).toHaveLength(1)
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('background'), 'Switch to conversation')
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('child-session'), 'Switch to conversation')
  })

  it('submits approvals and normalized question answers to the originating client/event', async () => {
    const { service, state, client, start } = fixture()
    const { queue } = start()
    queue.push({ type: 'ready', clientId: 'client-1' }, approvalFrame(), questionFrame())
    await vi.waitFor(() => expect(state.interactions.forSession('background').questions).toHaveLength(1))
    const { approvals, questions } = state.interactions.forSession('background')
    await service.answerApproval(approvals[0]!.key, 'allowed-once')
    await service.answerQuestions(questions[0]!.key, [{ id: 'scope', selected: ['Unit'], custom: '  Additional tests  ' }])
    expect(client.resolveRemoteEvent.mock.calls).toEqual([
      ['client-1', 'approval-1', { kind: 'result', value: 'allowed-once' }],
      ['client-1', 'question-1', { kind: 'result', value: { answers: [{ id: 'scope', selected: ['Unit'], custom: 'Additional tests' }] } }],
    ])
    expect(state.interactions.forSession('background')).toEqual({ approvals: [], questions: [] })
  })

  it('preserves a live request for retry when its response RPC fails', async () => {
    const { service, state, client, start } = fixture()
    start().queue.push({ type: 'ready', clientId: 'client-1' }, approvalFrame())
    await vi.waitFor(() => expect(state.interactions.forSession('background').approvals).toHaveLength(1))
    const key = state.interactions.forSession('background').approvals[0]!.key
    client.resolveRemoteEvent.mockRejectedValueOnce(new Error('Network unavailable'))
    await expect(service.answerApproval(key, 'rejected')).rejects.toThrow('Network unavailable')
    expect(state.interactions.has(key)).toBe(true)
    await service.answerApproval(key, 'rejected')
    expect(state.interactions.has(key)).toBe(false)
  })

  it.each(['end', 'error'] as const)('clears records on stream %s before reconnect, then accepts only fresh replay', async (ending) => {
    const { service, state, client, wait, start, nextQueue } = fixture()
    const run = start()
    run.queue.push({ type: 'ready', clientId: 'old-client' }, approvalFrame(), questionFrame())
    await vi.waitFor(() => expect(state.interactions.forSession('background').questions).toHaveLength(1))
    const key = state.interactions.forSession('background').approvals[0]!.key
    let resume!: () => void
    wait.mockImplementationOnce((signal) => new Promise<void>((resolve) => {
      resume = resolve
      signal.addEventListener('abort', () => resolve(), { once: true })
    }))
    run.queue.close(ending === 'error' ? new Error('Socket lost') : undefined)
    await vi.waitFor(() => expect(wait).toHaveBeenCalled())
    expect(state.interactions.forSession('background')).toEqual({ approvals: [], questions: [] })
    await expect(service.answerApproval(key, 'allowed-once')).rejects.toThrow('no longer active')
    const replayQueue = nextQueue()
    replayQueue.push({ type: 'ready', clientId: 'new-client' }, approvalFrame())
    resume()
    await vi.waitFor(() => expect(state.interactions.forSession('background').approvals).toHaveLength(1))
    const replay = state.interactions.forSession('background')
    expect(replay.questions).toEqual([])
    expect(replay.approvals[0]!.key).not.toBe(key)
    await service.answerApproval(replay.approvals[0]!.key, 'allowed-once')
    expect(client.resolveRemoteEvent).toHaveBeenCalledWith('new-client', 'approval-1', { kind: 'result', value: 'allowed-once' })
  })

  it('clears immediately on disconnect and fences delayed cleanup/frames from the previous pump', async () => {
    const { state, start } = fixture()
    const old = start()
    old.queue.push({ type: 'ready', clientId: 'old-client' }, approvalFrame())
    await vi.waitFor(() => expect(state.interactions.forSession('background').approvals).toHaveLength(1))
    const client = state.client
    state.disconnect()
    expect(state.interactions.forSession('background').approvals).toEqual([])
    old.abort.abort()
    state.client = client
    const fresh = start()
    fresh.queue.push({ type: 'ready', clientId: 'new-client' }, questionFrame())
    await vi.waitFor(() => expect(state.interactions.forSession('background').questions).toHaveLength(1))
    old.queue.push({ type: 'ready', clientId: 'stale-client' }, approvalFrame())
    old.queue.close()
    await old.task
    expect(state.interactions.forSession('background').approvals).toEqual([])
    expect(state.interactions.forSession('background').questions).toHaveLength(1)
  })

  it('removes canceled requests and ignores a delayed notification action', async () => {
    const { service, state, start } = fixture()
    let choose!: (value: undefined) => void
    vi.mocked(vscode.window.showWarningMessage).mockImplementationOnce(() => new Promise<undefined>((resolve) => { choose = resolve }))
    const open = vi.spyOn(service, 'openSession').mockResolvedValue(undefined)
    const { queue } = start()
    queue.push({ type: 'ready', clientId: 'client-1' }, approvalFrame())
    await vi.waitFor(() => expect(state.interactions.forSession('background').approvals).toHaveLength(1))
    queue.push({ type: 'cancel', eventId: 'approval-1' })
    await vi.waitFor(() => expect(state.interactions.forSession('background').approvals).toEqual([]))
    // The VS Code API is overloaded; the runtime action is the string label.
    ;(choose as unknown as (value: string) => void)('Switch to conversation')
    await Promise.resolve()
    expect(open).not.toHaveBeenCalled()
  })

  it('cleans only the removed session on the host-wide removal event', async () => {
    const { state, start } = fixture()
    start().queue.push({ type: 'ready', clientId: 'client-1' }, approvalFrame(), questionFrame('child-session'))
    await vi.waitFor(() => expect(state.interactions.forSession('child-session').questions).toHaveLength(1))
    state.handleRemoteEvent('api-session/removed', ['background'])
    expect(state.interactions.forSession('background').approvals).toEqual([])
    expect(state.interactions.forSession('child-session').questions).toHaveLength(1)
  })
})
