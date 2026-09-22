import { describe, expect, it, vi } from 'vitest'
import { RESTORED_ARCHIVE_STATE_KEY } from '../src/domain/archived-sessions.js'

// HarnessGatewayService imports `vscode` at the top level; provide a minimal
// mock so the module graph loads under vitest's node environment.
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
  window: { showWarningMessage: vi.fn() },
}))

import * as vscode from 'vscode'
import { DshRemoteError } from '../src/gateway/node-gateway-client.js'
import { HarnessGatewayService } from '../src/gateway/harness-gateway-service.js'
import type { WorktreeService } from '../src/editor/worktree-service.js'
import type { HarnessHostRuntime } from '../src/runtime/web-runtime.js'
import type { ConfigurationService } from '../src/config/configuration.js'
import type { ConnectionSettingsService } from '../src/services/connection-settings-service.js'
import type { Memento, OutputChannel } from 'vscode'

/** A no-op worktree service so archive-overlay tests never touch git. */
function stubWorktreeService(): WorktreeService {
  return {
    prepare: async () => ({ cwd: '', isolated: false }),
    cleanupOrphans: async () => [],
    recordFor: () => undefined,
    repoRootFor: () => undefined,
    displayCwd: (_sessionId: string, fallback: string | undefined) => fallback,
    diffText: async () => undefined,
    mergeBack: async () => ({ ok: false, message: 'stub' }),
    discard: async () => ({ ok: false, message: 'stub' }),
    dispose: () => undefined,
  } as unknown as WorktreeService
}

/**
 * Builds a HarnessGatewayService whose internal client and archive state are
 * controlled directly, so the archive revision guard, rollback and baseline
 * gating invariants can be exercised without a live Gateway.
 */

interface TestClient {
  probe: ReturnType<typeof vi.fn>
  workspaceArchiveSession: ReturnType<typeof vi.fn>
  sessionList: ReturnType<typeof vi.fn>
  sessionCreate: ReturnType<typeof vi.fn>
  sessionSelectModel: ReturnType<typeof vi.fn>
  sessionPrompt: ReturnType<typeof vi.fn>
  sessionModelCatalog: ReturnType<typeof vi.fn>
  sessionFollow: ReturnType<typeof vi.fn>
  sessionControl: ReturnType<typeof vi.fn>
  workspaceFollow: ReturnType<typeof vi.fn>
  remoteEvents: ReturnType<typeof vi.fn>
  skillList: ReturnType<typeof vi.fn>
  subagentList: ReturnType<typeof vi.fn>
  agentPresetList: ReturnType<typeof vi.fn>
  listCommands: ReturnType<typeof vi.fn>
  executeCommand: ReturnType<typeof vi.fn>
}

function createService(options: {
  archived?: readonly string[]
  restored?: readonly string[]
  client?: TestClient
} = {}): { service: GatewayTestHarness; client: TestClient } {
  const client = options.client ?? ({} as TestClient)
  client.probe ??= vi.fn()
  client.workspaceArchiveSession ??= vi.fn().mockResolvedValue({ archivedSessionIds: [] })
  client.sessionList ??= vi.fn().mockResolvedValue([])
  client.sessionCreate ??= vi.fn().mockResolvedValue({ sessionId: 's2', agentPreset: 'standard' })
  client.sessionSelectModel ??= vi.fn().mockResolvedValue({ selected: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })
  client.sessionPrompt ??= vi.fn().mockResolvedValue({ accepted: true })
  client.sessionModelCatalog ??= vi.fn().mockResolvedValue({ default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, routableProviders: [], groups: [], failures: [] })
  client.sessionFollow ??= vi.fn()
  client.sessionControl ??= vi.fn()
  client.workspaceFollow ??= vi.fn()
  client.remoteEvents ??= vi.fn()
  client.skillList ??= vi.fn().mockResolvedValue({ skills: [] })
  client.subagentList ??= vi.fn().mockResolvedValue({ entries: [], parentAvailable: true })
  client.agentPresetList ??= vi.fn().mockResolvedValue({ presets: [], authorable: false })
  client.listCommands ??= vi.fn().mockResolvedValue([])
  client.executeCommand ??= vi.fn().mockResolvedValue(undefined)

  const runtime = {
    onDidChangeState: () => ({ dispose: () => {} }),
    state: { phase: 'idle' as const },
    start: vi.fn().mockResolvedValue('http://127.0.0.1:0'),
    stop: vi.fn(),
    restart: vi.fn(),
    dispose: vi.fn(),
  } as unknown as HarnessHostRuntime

  const configuration = {
    get: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high', agentPreset: 'standard' }),
    setAgentPresetIfKnown: vi.fn(),
  } as unknown as ConfigurationService

  const connectionSettings = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    refresh: vi.fn(),
    onDidChange: () => ({ dispose: () => {} }),
  } as unknown as ConnectionSettingsService

  const output = { appendLine: vi.fn() } as unknown as OutputChannel
  const state = new Map<string, unknown>()
  if (options.restored !== undefined) state.set(RESTORED_ARCHIVE_STATE_KEY, [...options.restored])
  const globalState = {
    get: (key: string) => state.get(key),
    update: vi.fn(async (key: string, value: unknown) => { state.set(key, value) }),
  } as unknown as Memento

  const service = new HarnessGatewayService(
    runtime,
    configuration,
    connectionSettings,
    output,
    globalState,
    stubWorktreeService(),
  ) as unknown as GatewayTestHarness

  // Seed the official archive set and baseline so the tests exercise the
  // post-baseline behaviour.
  service.archives.archivedIds = new Set(options.archived ?? [])
  service.archives.baselineLoaded = true
  if (options.archived !== undefined) service.archives.revision += 1
  service.client = client
  return { service, client }
}

/** Structural view of the private gateway state the tests drive directly. */
interface GatewayTestHarness {
  archiveSession: (id: string) => Promise<void>
  client: TestClient | undefined
  summaries: Map<string, { blank?: boolean; origin?: string; parentSessionId?: string }>
  archives: {
    archivedIds: Set<string>
    restoredIds: Set<string>
    revision: number
    baselineLoaded: boolean
    install: (ids: readonly string[], persist?: boolean) => void
    isArchived: (id: string) => boolean
    refresh: () => Promise<void>
    archive: (id: string, exists: (id: string) => boolean) => Promise<void>
  }
  activeSessionId: string | undefined
  archivedFromHost: readonly string[] | undefined
  handleWorkspace: (frame: unknown) => void
  globalState: { get: (key: string) => unknown; update: (key: string, value: unknown) => Promise<void> }
  fireChange: () => void
}

describe('HarnessGatewayService archive overlay', () => {
  it('stops and archives only after native activity has been confirmed', async () => {
    const { service, client } = createService()
    service.summaries.set('target', { blank: false })
    const activity = [{ kind: 'turn' }, { kind: 'job', items: [{ id: 'bash-1', label: 'build' }, { id: 'bash-2', label: 'serve' }] }]
    client.workspaceArchiveSession.mockRejectedValueOnce(new DshRemoteError('workspace/session-active', 'busy', { activity }))
      .mockResolvedValueOnce({ archivedSessionIds: ['target'] })
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Stop and archive' as never)
    await service.archiveSession('target')
    expect(vscode.window.showWarningMessage).toHaveBeenLastCalledWith(expect.any(String), {
      modal: true, detail: 'Running turn\nBackground jobs: build\nBackground jobs: serve',
    }, 'Stop and archive')
    expect(client.workspaceArchiveSession).toHaveBeenNthCalledWith(1, { sessionId: 'target' })
    expect(client.workspaceArchiveSession).toHaveBeenNthCalledWith(2, { sessionId: 'target', stopActivity: true })
    expect(service.archives.isArchived('target')).toBe(true)
  })

  it('does not stop any work when the archive confirmation is dismissed', async () => {
    const { service, client } = createService()
    service.summaries.set('target', { blank: false })
    client.workspaceArchiveSession.mockRejectedValueOnce(new DshRemoteError('workspace/session-active', 'busy', { activity: [{ kind: 'turn' }] }))
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined)
    await service.archiveSession('target')
    expect(client.workspaceArchiveSession).toHaveBeenCalledTimes(1)
    expect(service.archives.isArchived('target')).toBe(false)
  })

  it('applies the host archive baseline from a workspace/follow frame and keeps it across refresh', async () => {
    const { service } = createService({ archived: [] })
    service.archives.archivedIds = new Set()

    // The workspace follow baseline is authoritative: the session is archived
    // immediately, and a later refresh (reading the same host snapshot) keeps it.
    service.handleWorkspace({ type: 'baseline', value: { archivedSessionIds: ['a'] } })
    await service.archives.refresh()

    expect(service.archives.isArchived('a')).toBe(true)
    expect(service.archives.archivedIds.has('a')).toBe(true)
  })

  it('applies an archived increment and then refreshes from the host snapshot', async () => {
    const { service } = createService({ archived: [] })
    service.handleWorkspace({ type: 'archived', archivedSessionIds: ['b'] })
    await service.archives.refresh()
    expect(service.archives.archivedIds.has('b')).toBe(true)
    expect(service.archives.baselineLoaded).toBe(true)
  })

  it('restores the exact overlay snapshot when archiveSession persistence fails', async () => {
    const { service, client } = createService({ archived: [], restored: ['keep'] })
    service.summaries.set('target', { blank: false })
    client.workspaceArchiveSession.mockResolvedValue({ archivedSessionIds: ['target'] })
    // Force the persist step to fail after the RPC succeeded.
    service.globalState.update = async () => { throw new Error('disk full') }

    await expect(service.archives.archive('target', (id) => service.summaries.has(id))).rejects.toThrow('disk full')
    // The unrelated overlay id survives; the failed archive id is rolled back.
    expect(service.archives.restoredIds.has('keep')).toBe(true)
    expect(service.archives.restoredIds.has('target')).toBe(false)
  })

  it('treats nothing as archived until the baseline is loaded', () => {
    const { service } = createService({ archived: ['hidden'] })
    service.archives.baselineLoaded = false
    service.archives.archivedIds = new Set(['hidden'])
    expect(service.archives.isArchived('hidden')).toBe(false)
  })

  it('sweeps a session the host frame archives (no restore overlay)', () => {
    const { service } = createService({ archived: [] })
    service.activeSessionId = 'active'
    service.archives.archivedIds = new Set()
    // host/archived-sessions-changed archives the open session; without a
    // restore overlay it becomes archived and the sweep runs. In this harness
    // the fallback selection cannot resolve without a live client, so the
    // sweep's leaveArchivedSelection fails safely and logs; the invariant
    // under test is that the session is now considered archived.
    service.archives.install(['active'], true)
    expect(service.archives.isArchived('active')).toBe(true)
  })

  it('archives a blank draft so unwanted new-conversation stubs can be hidden', async () => {
    const { service, client } = createService({ archived: [] })
    service.summaries.set('blank-draft', { blank: true })
    client.workspaceArchiveSession.mockResolvedValue({ archivedSessionIds: ['blank-draft'] })

    await service.archives.archive('blank-draft', (id) => service.summaries.has(id))

    expect(client.workspaceArchiveSession).toHaveBeenCalledWith({ sessionId: 'blank-draft' })
    expect(service.archives.isArchived('blank-draft')).toBe(true)
  })
})
