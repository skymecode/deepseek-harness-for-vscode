import * as vscode from 'vscode'
import type {
  ControlFrame,
  FollowFrame,
  HistoryEntry,
  JobView,
  MessageId,
  QueuedInboxItem,
  RpcId,
  SessionId,
  SessionModels,
  SessionSummary,
  SkillEntry,
  SubagentAddress,
  SubagentListEntry,
} from './gateway-wire.js'
import type { PromptContentPart } from './gateway-wire.js'
import type { AgentPresetRow as AgentPresetEntry, AgentPresetRoster } from '@deepseek-ai/dsh-agent-presets/types'
import type { ConfigurationService } from '../config/configuration.js'
import { buildCarryOverMessage, type CarryTurn } from '../domain/carry-over.js'
import { projectionContextPressure } from '../domain/context-pressure.js'
import { isPermissionPresetId, type PermissionPresetId } from '../domain/permissions.js'
import { isProviderRouteInUse } from '../domain/provider.js'
import type { PromptAttachment } from '../domain/prompt-context.js'
import { agentPresetTransition, type PromptConfiguration } from '../domain/prompt-configuration.js'
import { conversationTitle } from '../domain/session-title.js'
import { projectSessionChanges } from '../domain/session-changes.js'
import { projectTurnChanges } from '../domain/turn-changes.js'
import { isAutoEffort, resolveEffortIntent, type AutoEffortSignals, type EffortIntent, type PromptEffortSignals } from '../domain/session-effort.js'
import { pickAutoModel, type ModelProfileInput } from '../domain/model-profile.js'
import { setTags, togglePinned } from '../domain/session-meta.js'
import { projectSessionStats, projectionSessionStats } from '../domain/session-stats.js'
import { sameWorkspacePath } from '../domain/workspace-scope.js'
import type { WorktreeService } from '../editor/worktree-service.js'
import {
  projectConversation,
  projectionCommands,
  projectionGoal,
  projectionPermissions,
  projectionPlan,
  projectionTitle,
  projectionTokenUsage,
  sessionListItem,
  type CommandEntry,
  type HarnessWorkbenchState,
} from '../domain/workbench-state.js'
import type { HarnessHostRuntime } from '../runtime/web-runtime.js'
import type { ConnectionSettingsService } from '../services/connection-settings-service.js'
import { ArchiveState } from './archive-state.js'
import { AssistantStreamState, presentationHistory } from './assistant-stream-state.js'
import {
  attachmentPart,
  carryEventText,
  errorMessage,
  localizedWorkbenchLabels,
  mergeHistory,
  newSessionId,
  queuedPromptView,
  recordValue,
  subagentView,
  valueOf,
} from './gateway-helpers.js'
import { NodeGatewayClient } from './node-gateway-client.js'
import { PendingConfigurationQueue, type PendingConfigEntry } from './pending-queue.js'
import { PendingInteractions, type PendingInteraction } from './pending-interactions.js'
import type { RemoteEventOutcome, RemoteWaterfallEvent } from './remote-event-protocol.js'
import { SessionMetaStore } from './session-meta-store.js'
import { TurnCompletionTracker } from './turn-completion-tracker.js'
import type { CompletionNotice } from '../domain/turn-completion.js'
import { LAST_SESSION_STATE_KEY } from '../domain/session-selection.js'

/**
 * Application service for the native VS Code workbench. It owns Gateway
 * connectivity and durable session state; neither the webview nor the runtime
 * launcher contains Harness business logic.
 */
export class HarnessGatewayService implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>()
  private readonly completionEmitter = new vscode.EventEmitter<CompletionNotice>()
  private readonly completions = new TurnCompletionTracker()
  private readonly runtimeSubscription: vscode.Disposable
  private client: NodeGatewayClient | undefined
  private streamAbort: AbortController | undefined
  private followAbort: AbortController | undefined
  /** Per-session follow cursor (the snapshot `cursor` handed to session/page). */
  private readonly followCursor = new Map<string, number>()
  private readonly assistantStream = new AssistantStreamState()
  private readonly interactions = new PendingInteractions()
  /** Latest archived-session snapshot from `workspace/follow`, if seen. */
  private archivedFromHost: readonly string[] | undefined
  /** Setters waiting for the current follow snapshot (keyed by session id). */
  private readonly followSnapshotWaiters = new Map<string, (value: void) => void>()
  private summaries = new Map<string, SessionSummary>()
  private entries: HistoryEntry[] = []
  private hasMore = false
  private activeSessionId: string | undefined
  private models: SessionModels | undefined
  private presets: readonly AgentPresetEntry[] = []
  private skills: readonly SkillEntry[] = []
  private jobs: readonly JobView[] = []
  private queue: readonly QueuedInboxItem[] = []
  private subagentCount = 0
  private subagents: readonly SubagentListEntry[] = []
  private subagentAddress: SubagentAddress | undefined
  private projections: Record<string, unknown> = {}
  /** Armed by a mode switch; consumed by the next prompt in its target session. */
  private pendingCarryOver: { targetSessionId: string; message: string } | undefined
  private readonly labels = localizedWorkbenchLabels()
  private commands: readonly CommandEntry[] = projectionCommands(undefined, this.labels)
  private startTask: Promise<void> | undefined
  private phase: HarnessWorkbenchState['phase'] = 'idle'
  private error: string | undefined
  private publishScheduled = false
  private selectionGeneration = 0
  /** FIFO of deferred prompt configurations, one slot per busy-phase prompt. */
  private readonly pendingQueue: PendingConfigurationQueue
  /** Locally-owned per-session state (effort intents, meta, turn cards). */
  private readonly metaStore: SessionMetaStore
  /** The archived-session set plus its restore overlay. */
  private readonly archives: ArchiveState
  /**
   * Sessions whose worktree is currently being auto-merged after a turn/end.
   * Keeps two adjacent turn ends from running concurrent git operations on the
   * same worktree (index.lock races); entries are removed when the merge settles.
   */
  private readonly autoMergingSessions = new Set<string>()
  /**
   * In-flight session creations, keyed by agent preset ('' = default). A new
   * conversation must never run two concurrent createSession() flows — see
   * createSession() — so a click storm coalesces onto the first promise.
   */
  private readonly creatingSessions = new Map<string, Promise<string>>()

  readonly onDidChange = this.changeEmitter.event
  readonly onDidCompleteTurn = this.completionEmitter.event

  constructor(
    private readonly runtime: HarnessHostRuntime,
    private readonly configuration: ConfigurationService,
    private readonly connectionSettings: ConnectionSettingsService,
    private readonly output: vscode.OutputChannel,
    private readonly globalState: vscode.Memento,
    private readonly worktrees: WorktreeService,
  ) {
    this.pendingQueue = new PendingConfigurationQueue({
      isRunning: (sessionId) => this.summaries.get(sessionId)?.running === true,
      apply: (configuration, signals) => this.applyPromptConfiguration(configuration, signals),
      onApplyFailure: (message) => this.output.appendLine(vscode.l10n.t('[gateway] Failed to apply a queued configuration: {0}', message)),
    })
    this.metaStore = new SessionMetaStore(this.globalState, this.output)
    this.archives = new ArchiveState({
      globalState: this.globalState,
      output: this.output,
      listArchived: async () => [...(this.archivedFromHost ?? [])],
      archiveSession: async (sessionId) => (await this.requireClient().workspaceArchiveSession({
        sessionId: sessionId as SessionId,
      })).archivedSessionIds.map(String),
      openSession: (sessionId) => this.openSession(sessionId),
      createSession: async () => this.createSession(),
      visibleSummaries: () => this.visibleSummaries(),
      activeSessionId: () => this.activeSessionId,
      isArchived: (sessionId) => this.archives.isArchived(sessionId),
      fireChange: () => this.fireChange(),
    })
    this.runtimeSubscription = runtime.onDidChangeState((state) => {
      if (state.phase === 'error') {
        this.phase = 'error'
        this.error = state.error
        this.fireChange()
      }
    })
  }

  /** Starts the Gateway only when it is not already connected. */
  async ensureStarted(): Promise<void> {
    if (this.phase === 'connected' && this.client !== undefined) return
    await this.start()
    if (this.phase !== 'connected' || this.client === undefined) {
      throw new Error(this.error ?? vscode.l10n.t('Harness Gateway is not connected.'))
    }
  }

  async start(): Promise<void> {
    if (this.startTask !== undefined) {
      await this.startTask
      return
    }
    if (this.phase === 'connected' && this.client !== undefined) return
    const task = this.runStart()
    this.startTask = task
    try {
      await task
    } finally {
      if (this.startTask === task) this.startTask = undefined
    }
  }

  private async runStart(): Promise<void> {
    this.phase = 'starting'
    this.error = undefined
    this.fireChange()
    try {
      await this.runStartBaseline()
      this.phase = 'connected'
    } catch (cause) {
      this.phase = 'error'
      this.error = errorMessage(cause)
      this.output.appendLine(`[gateway] ${this.error}`)
    }
    this.fireChange()
  }

  /** Construction seam so start-flow tests can substitute a stub client. */
  protected createGatewayClient(url: string): NodeGatewayClient {
    return new NodeGatewayClient(url)
  }

  private async runStartBaseline(): Promise<void> {
    try {
      // Process boot has its own (longer) start timeout in the runtime: a
      // slow first boot after an extension update must not consume the
      // baseline budget below.
      const url = await this.runtime.start()
      this.client = this.createGatewayClient(url)
      // Baseline watchdog: the gateway process is up, but one of the
      // post-boot RPCs (probe, provider/settings/models describe, session
      // list) may still hang forever — e.g. a misconfigured custom provider
      // whose settings namespace refuses to answer. Without a deadline the
      // workbench would sit on the "Starting Harness" screen indefinitely.
      // The race lives INSIDE this try so expiry tears the runtime down
      // instead of leaking the half-started gateway process.
      const watchdog = new Promise<never>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(vscode.l10n.t(
            'The bundled Harness runtime started but the Gateway baseline did not settle within {0}s. Check the output logs and your provider configuration. Another running `dsh web` instance can lock the profile and block this gateway — exit it and retry.',
            String(START_BASELINE_TIMEOUT_S),
          )))
        }, START_BASELINE_TIMEOUT_S * 1_000)
        timer.unref?.()
      })
      await Promise.race([this.settleBaseline(), watchdog])
    } catch (cause) {
      // A failed baseline must still tear down the half-started runtime so a
      // retry starts from a clean slate. Disconnect first: the orphaned
      // settleBaseline promise keeps running inside the race, and its client/
      // streams must not survive into the next start().
      this.phase = 'error'
      this.error = errorMessage(cause)
      this.output.appendLine(`[gateway] ${this.error}`)
      this.disconnect()
      await this.runtime.stop().catch(() => undefined)
      throw cause
    }
  }

  private async settleBaseline(): Promise<void> {
    const client = this.requireClient()
    this.output.appendLine('[baseline] probe…')
    await client.probe()
    this.output.appendLine('[baseline] probe ok, connect…')
    await this.connectionSettings.connect(client)
    this.output.appendLine('[baseline] connect ok, streams…')
    this.startEventStreams()
    // The VSCode Memento can be rebuilt empty (state.vscdb), which wipes the
    // worktree registry. Recover records from disk mirrors BEFORE the first
    // session list is rendered: an isolated session's recorded cwd is its
    // worktree path, and scoping maps it back to the repo root through this
    // registry. Refreshing the list first would filter every isolated session
    // out (cwd ≠ workspace folder) and greet the user with an empty history.
    const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)
    this.output.appendLine('[baseline] recover worktrees…')
    await this.worktrees.recover(workspaceRoots)
    this.output.appendLine('[baseline] recover ok, refresh lists…')
    await Promise.all([this.refreshSessionList(), this.archives.refresh(), this.refreshPresets()])
    this.output.appendLine('[baseline] lists ok, sweep…')
    // Sweep worktrees whose session no longer exists (crash between worktree
    // add and session create, or a session removed out-of-band).
    void this.cleanupOrphanWorktrees()
    // Resume the user's last open session first; only fall back to the most
    // recent history entry, and only create a blank session when no history
    // exists at all. A reload/reinstall must never silently open a different
    // conversation than the one the user was working in.
    const requested = this.activeSessionId
      ?? this.globalState.get<string>(LAST_SESSION_STATE_KEY)
    const next = requested !== undefined && this.summaries.has(requested) && !this.archives.isArchived(requested)
      ? requested
      : this.visibleSummaries()[0]?.sessionId
    if (next !== undefined) {
      try {
        this.output.appendLine(`[baseline] open session ${next}…`)
        await this.openSession(String(next))
        this.output.appendLine(`[baseline] session ${next} opened`)
      } catch (cause) {
        // One damaged or legacy transcript must not take down the Gateway.
        // The user can still create a new session and inspect the log.
        this.output.appendLine(vscode.l10n.t('[gateway] Failed to load recent sessions: {0}', errorMessage(cause)))
      }
    } else {
      // No session to resume: open a fresh blank one so the model and
      // permission selectors are usable before the first message is sent.
      // Blank sessions are archivable and never pollute the history.
      try {
        await this.createSession()
      } catch (cause) {
        this.output.appendLine(vscode.l10n.t('[gateway] Failed to open a fresh session: {0}', errorMessage(cause)))
      }
    }
    // Never-written blank drafts leftover from crashes/reinstalls are not
    // history: archive every one of them so the history list starts clean.
    // This runs AFTER the resume above and SKIPS the resumed session: archiving
    // an active/selected session triggers the leave-archived-selection path
    // (openSession) which races the resume and times the baseline out.
    // Guarded to real projects: a fresh project with no history (or no
    // workspace folder at all) has nothing to sweep, and archiving in that
    // state only risks the leave-archived-selection cascade.
    const hasRealHistory = [...this.summaries.values()].some((summary) => !summary.blank
      && this.inCurrentWorkspace(summary))
    if (hasRealHistory && !this.runtime.sharedHistory) {
      for (const summary of [...this.summaries.values()]) {
        if (!summary.blank) continue
        if (String(summary.sessionId) === this.activeSessionId) continue
        await this.archives.archive(String(summary.sessionId), (id) => this.summaries.has(id))
          .catch((cause: unknown) => {
            this.output.appendLine(vscode.l10n.t('[gateway] Failed to archive a leftover blank draft session: {0}', errorMessage(cause)))
          })
      }
    }
  }

  async restart(): Promise<void> {
    this.disconnect()
    await this.runtime.restart()
    await this.start()
  }

  /** Stops the Host around profile mutations, then reconnects even on failure. */
  async mutateRuntime<T>(mutation: () => Promise<T>): Promise<T> {
    this.disconnect()
    await this.runtime.stop()
    try {
      return await mutation()
    } finally {
      await this.start()
    }
  }

  async snapshot(): Promise<HarnessWorkbenchState> {
    const hasApiKey = this.connectionSettings.hasConfiguredProvider()
    const scoped = this.orderedSummaries().filter((summary) => this.inCurrentWorkspace(summary))
    const partitioned = this.archives.partition(scoped.map((summary) => {
      const item = this.sessionListItemWithIsolation(summary)
      const meta = this.metaStore.metaFor(String(summary.sessionId))
      return meta === undefined ? item : { ...item, meta }
    }))

    const activeSummary = this.activeSessionId === undefined ? undefined : this.summaries.get(this.activeSessionId)
    const projected = projectConversation(presentationHistory(this.entries, this.assistantStream.entries()), this.labels)
    const permissions = projectionPermissions(this.projections.permissions)
    const plan = projectionPlan(this.projections.plan)
    const goal = projectionGoal(this.projections.goal)
    const tokenUsage = projectionTokenUsage(this.projections.tokenUsage)
    const contextPressure = projectionContextPressure(this.projections.contextPressure)
    const changes = projectSessionChanges(this.entries)
    const turnChanges = projectTurnChanges(this.entries, projected.messages)
    const stats = projectionSessionStats(this.projections.sessionStats) ?? projectSessionStats(this.entries)
    const effortIntent = activeSummary === undefined ? undefined : this.metaStore.effortIntentFor(String(activeSummary.sessionId))
    const active = activeSummary === undefined ? undefined : {
      id: String(activeSummary.sessionId),
      title: sessionListItem(activeSummary, this.labels).title,
      running: activeSummary.running,
      blank: activeSummary.blank,
      ...(activeSummary.agentPreset === undefined ? {} : { agentPreset: activeSummary.agentPreset }),
      hasMore: this.hasMore,
      ...(this.models === undefined ? {} : { model: this.models.current }),
      models: this.models?.groups.flatMap((group) => group.models.map((model) => ({
        provider: group.id,
        providerName: group.name,
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
        reasoning: model.reasoning?.efforts ?? [],
      }))) ?? [],
      messages: projected.messages,
      todos: projected.todos,
      ...(projected.retry === undefined ? {} : { retry: projected.retry }),
      ...(projected.turnActivity === undefined ? {} : { turnActivity: projected.turnActivity }),
      skills: this.skills,
      jobs: this.jobs,
      queue: this.queue.map(queuedPromptView),
      ...this.interactions.forSession(this.activeSessionId),
      subagentCount: this.subagentCount,
      subagents: this.subagents.map(subagentView),
      ...(this.subagentAddress === undefined ? {} : {
        parentSessionId: String(this.subagentAddress.parentSessionId),
        subagentMode: this.subagentAddress.mode,
      }),
      ...(permissions === undefined ? {} : { permissions }),
      commands: this.commands,
      ...(plan === undefined ? {} : { plan }),
      ...(goal === undefined ? {} : { goal }),
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
      ...(contextPressure === undefined ? {} : { contextPressure }),
      ...(changes === undefined ? {} : { changes }),
      turnChanges,
      ...(stats.turns > 0 ? { stats } : {}),
      ...(effortIntent === undefined ? {} : { effortIntent }),
    }
    return {
      phase: this.phase,
      ...(this.error === undefined ? {} : { error: this.error }),
      hasApiKey,
      sessions: partitioned.active,
      archivedSessions: partitioned.archived,
      ...(active === undefined ? {} : { active }),
      presets: this.presets,
    }
  }

  /** Whether the currently open conversation has selected this provider route. */
  isProviderInUse(provider: string): boolean {
    return isProviderRouteInUse(provider, this.models?.current.provider, this.activeSessionId !== undefined)
  }

  /** Typed upstream control-plane client for provider settings services. */
  providerControlClient(): NodeGatewayClient {
    const client = this.requireClient()
    if (!(client instanceof NodeGatewayClient)) throw new Error(vscode.l10n.t('The current Gateway does not support provider settings.'))
    return client
  }

  /** Refreshes the active session's model catalog after a live provider edit. */
  async refreshModelCatalog(): Promise<void> {
    if (this.activeSessionId === undefined) return
    const catalog = await this.requireClient().sessionModelCatalog()
    this.models = { ...catalog, current: catalog.default }
    this.fireChange()
  }

  /**
   * Creates a fresh session, deduplicating concurrent callers. A ＋ click storm
   * (or a mode switch racing a click) must not fan out into N parallel
   * `createSession()` runs: each would `git worktree add` (serialized on git's
   * global worktree lock) and issue its own session/create RPC, so they queue
   * on the lock, every one drags past the RPC timeout, and the user ends up
   * with several blank drafts plus a "timed out" toast. In-flight calls with
   * the same preset share one creation promise.
   */
  async createSession(agentPreset?: string): Promise<string> {
    const key = agentPreset ?? ''
    const inFlight = this.creatingSessions.get(key)
    if (inFlight !== undefined) return inFlight
    const creating = this.doCreateSession(agentPreset)
    this.creatingSessions.set(key, creating)
    // Swallow the finally-chained rejection: callers await the original
    // `creating` promise directly, so a failure surfaces to them, and the
    // cleanup must not spawn its own unhandled rejection.
    void creating.finally(() => {
      if (this.creatingSessions.get(key) === creating) this.creatingSessions.delete(key)
    }).catch(() => undefined)
    return creating
  }

  private async doCreateSession(agentPreset?: string): Promise<string> {
    const client = this.requireClient()
    const config = this.configuration.get()
    const selectedPreset = agentPreset ?? config.agentPreset
    // A2 isolation: preallocate a session id so the worktree can be created
    // under that id before the session exists, then hand the worktree path as
    // the session cwd (the sandbox root). Non-git workspaces fall back to the
    // shared workspace folder.
    const sessionId = newSessionId()
    const baseCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
    const prepared = await this.worktrees.prepare(sessionId, baseCwd)
    let created
    try {
      created = await client.sessionCreate({ cwd: prepared.cwd, sessionId: sessionId as SessionId, agentPreset: selectedPreset })
    } catch (cause) {
      // Roll back the freshly created worktree so a failed create cannot leak it.
      if (prepared.isolated) await this.worktrees.discard(sessionId).catch(() => undefined)
      throw cause
    }
    if (!prepared.isolated && prepared.reason !== undefined) {
      const note = prepared.reason === 'git-not-found'
        ? vscode.l10n.t('Git was not found on this machine, so this session shares the workspace folder instead of an isolated worktree. Review, Merge and Discard stay unavailable until Git is on PATH.')
        : prepared.reason === 'no-git-repo'
          ? vscode.l10n.t('The workspace is not a git repository, so this session shares the workspace folder instead of an isolated worktree.')
          : prepared.reason === 'detached-head'
            ? vscode.l10n.t('The repository has no active branch (detached HEAD), so this session shares the workspace folder instead of an isolated worktree.')
            : vscode.l10n.t('Could not create an isolated worktree for this session, so it shares the workspace folder.')
      if (prepared.reason === 'git-not-found') {
        void vscode.window.showInformationMessage(note, vscode.l10n.t('Install Git')).then((selection) => {
          if (selection !== undefined) void vscode.env.openExternal(vscode.Uri.parse('https://git-scm.com/downloads'))
        })
      } else {
        void vscode.window.showInformationMessage(note)
      }
    }
    if (agentPreset !== undefined) await this.configuration.setAgentPresetIfKnown(agentPreset)
    await this.refreshSessionList()
    await this.selectSession(String(created.sessionId))
    // Applying the persisted provider/model pair can fail when the two were
    // persisted out of sync (e.g. provider switched to `commandcode` while the
    // model stayed `deepseek-v4-flash`). selectModel() self-corrects when the
    // catalog is loaded; when it is not, fall back to the provider's first
    // advertised model, and if that is unknown too, let the runtime keep its
    // own default instead of failing session creation.
    try {
      await this.selectModel(config.provider, config.model, config.reasoningEffort, false)
    } catch {
      // selectModel already prefers the same model by bare id suffix; this
      // fallback only runs when the catalog is not loaded yet, so pick the
      // provider's first advertised model and let the runtime settle.
      const providerModels = this.modelsFor(config.provider)
      const fallback = providerModels[0]
      if (fallback !== undefined) {
        await this.selectModel(config.provider, fallback.id, config.reasoningEffort, false)
      }
    }
    const permission = projectionPermissions(this.projections.permissions)?.currentValue
    if (permission !== config.permissionMode) await this.applyPermission(config.permissionMode, false)
    return String(created.sessionId)
  }

  /** True when the session lives in its own git worktree (A2 isolation). */
  private isSessionIsolated(sessionId: string): boolean {
    return this.worktrees.recordFor(sessionId) !== undefined
  }

  /**
   * Moves an un-isolated session into a fresh isolated worktree before its
   * next message, carrying the conversation as a hidden lead block (the same
   * mechanism mode switches use). Safety gate: if the shared checkout has
   * uncommitted changes, the migration is skipped — those changes would be
   * invisible from the new worktree and the continuation would silently break.
   */
  private async migrateUnisolatedSession(sourceId: string): Promise<void> {
    const preset = this.summaries.get(sourceId)?.agentPreset ?? this.configuration.get().agentPreset
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (workspaceRoot !== undefined && await this.worktrees.workingTreeDirty(workspaceRoot)) {
      // The checkout is dirty; do not strand its changes. The user can still
      // open a fresh isolated session with the ＋ button.
      this.output.appendLine(vscode.l10n.t(
        '[gateway] Session {0} has no isolated worktree; auto-isolation skipped because the workspace has uncommitted changes.',
        sourceId,
      ))
      return
    }
    // Snapshot the conversation BEFORE createSession() switches the active
    // session and resets the entry cache.
    const carried = this.buildCarryOverForActiveSession(preset, preset)
    const isolatedId = await this.createSession(preset)
    if (carried !== undefined) {
      this.pendingCarryOver = { targetSessionId: isolatedId, message: carried }
      this.output.appendLine(vscode.l10n.t(
        '[gateway] Session {0} had no isolated worktree; moved to isolated session {1} with the conversation carried over.',
        sourceId,
        isolatedId,
      ))
    }
  }

  /**
   * Condenses the active conversation right before a mode switch opens a
   * fresh session: the digest rides as a hidden lead block on the next send
   * (see domain/carry-over), so the new mode keeps the previous context.
   */
  private buildCarryOverForActiveSession(fromPreset: string, toPreset: string): string | undefined {
    const sourceId = this.requireActiveSession()
    const turns: CarryTurn[] = []
    let toolCalls = 0
    for (const { event } of this.entries) {
      if (event.type === 'user/message') {
        const source = event.data.source
        if (source.kind !== 'user') continue
        turns.push({ role: 'user', text: carryEventText(event.data.content) })
      } else if (event.type === 'assistant/message') {
        turns.push({ role: 'assistant', text: carryEventText(event.data.message.content) })
      } else if (event.type === 'tool/call') {
        toolCalls += 1
      }
    }
    return buildCarryOverMessage({ sourceSessionId: sourceId, fromPreset, toPreset, turns, skippedToolCalls: toolCalls })
  }

  /** Peeks an armed carry-over payload without consuming it; cleared only after a successful send. */
  private peekCarryOverFor(sessionId: string): string | undefined {
    if (this.pendingCarryOver?.targetSessionId !== sessionId) return undefined
    return this.pendingCarryOver.message
  }

  private clearCarryOver(sessionId: string): void {
    if (this.pendingCarryOver?.targetSessionId === sessionId) this.pendingCarryOver = undefined
  }

  /**
   * Commits composer choices immediately before the next prompt. Harness locks
   * an Agent Preset after a conversation starts, so changing DSH mode opens a
   * fresh session under the requested preset while model/reasoning changes
   * remain session-local. A digest of the previous conversation is attached to
   * the next outgoing message as a hidden lead block (collapsed into a context
   * card in the transcript), keeping continuity without forking into a locked
   * old preset.
   */
  async applyPromptConfiguration(selection: PromptConfiguration, signals?: PromptEffortSignals): Promise<void> {
    if (this.subagentAddress !== undefined) {
      throw new Error(vscode.l10n.t('Sub-agent configuration is fixed by its parent session.'))
    }
    let sessionId = this.activeSessionId
    if (sessionId === undefined) {
      sessionId = await this.createSession(selection.agentPreset)
    } else {
      const summary = this.summaries.get(sessionId)
      const currentPreset = summary?.agentPreset ?? this.configuration.get().agentPreset
      const transition = agentPresetTransition(summary?.blank === true, currentPreset, selection.agentPreset)
      if (transition === 'select-blank-session') {
        await this.selectPreset(selection.agentPreset)
      } else if (transition === 'create-session') {
        // Snapshot the conversation BEFORE createSession() selects the fresh
        // session and resets the entry cache.
        const carried = this.buildCarryOverForActiveSession(currentPreset, selection.agentPreset)
        sessionId = await this.createSession(selection.agentPreset)
        if (carried !== undefined) {
          this.pendingCarryOver = { targetSessionId: sessionId, message: carried }
          this.output.appendLine(vscode.l10n.t(
            '[gateway] Mode switch opened session {0} under preset "{1}"; the previous context rides with the next message.',
            sessionId,
            selection.agentPreset,
          ))
        }
      } else {
        await this.configuration.setAgentPresetIfKnown(selection.agentPreset)
      }
    }
    // 'auto' is an extension-side selection layer carried as a separated intent:
    // the concrete tier in `selection.reasoningEffort` is what the UI shows.
    const intent = selection.reasoningIntent === 'auto' ? selection.reasoningIntent : selection.reasoningEffort
    // Auto mode selects the model as well as the tier: light tasks run on the
    // fastest model, heavy tasks on the deep-reasoning one, everything else
    // keeps the current selection to avoid churn. selectModel() then resolves
    // the 'auto' tier against the chosen model's own reasoning options.
    let targetModel = selection.model
    if (intent === 'auto' && signals !== undefined) {
      const autoModel = pickAutoModel(
        this.modelsFor(selection.provider),
        this.models?.current.model ?? selection.model,
        this.autoSignals(signals),
      )
      if (autoModel !== undefined && autoModel !== targetModel) targetModel = autoModel
    }
    await this.selectModel(selection.provider, targetModel, intent, true, signals)
  }

  /** The models currently advertised by one provider, in provider order. */
  private modelsFor(provider: string): readonly ModelProfileInput[] {
    return this.models?.groups.find((group) => group.id === provider)?.models ?? []
  }

  async searchSessions(query: string): Promise<{ readonly sessionId: string; readonly snippet: string }[]> {
    const normalized = query.trim()
    if (normalized === '') return []
    const result = await this.requireClient().sessionSearch({ query: normalized })
    return result.items
      .filter((item) => {
        const summary = this.summaries.get(String(item.sessionId))
        return summary !== undefined && this.inCurrentWorkspace(summary)
      })
      .map((item) => ({ sessionId: String(item.sessionId), snippet: item.snippet }))
  }

  async selectSession(sessionId: string): Promise<void> {
    if (!this.summaries.has(sessionId)) await this.refreshSessionList()
    if (!this.summaries.has(sessionId)) throw new Error(vscode.l10n.t('Session not found.'))
    // Remember the selection so a reload/reinstall resumes this conversation
    // instead of silently opening a different (or blank) session.
    await this.globalState.update(LAST_SESSION_STATE_KEY, sessionId).then(
      () => undefined,
      () => undefined,
    )
    // A never-written blank draft is not history: when the user switches away,
    // archive it so the draft does not accumulate in the history list.
    const leaving = this.activeSessionId
    if (leaving !== undefined && leaving !== sessionId) {
      const leavingSummary = this.summaries.get(leaving)
      if (leavingSummary?.blank === true) {
        await this.archives.archive(leaving, (id) => this.summaries.has(id)).catch((cause: unknown) => {
          this.output.appendLine(vscode.l10n.t('[gateway] Failed to archive a blank draft session: {0}', errorMessage(cause)))
        })
      }
    }
    const generation = ++this.selectionGeneration
    this.activeSessionId = sessionId
    // Force the follow pump to open a fresh snapshot for the new selection:
    // without this, switching away and back leaves the pump on the old
    // session's live stream (which never re-sends its snapshot), so the
    // conversation renders empty.
    this.followAbort?.abort()
    this.subagentAddress = undefined
    this.entries = []
    this.assistantStream.reset()
    this.hasMore = false
    this.models = undefined
    this.skills = []
    this.jobs = []
    this.queue = []
    this.subagentCount = 0
    this.subagents = []
    this.projections = {}
    this.commands = projectionCommands(undefined, this.labels)
    this.fireChange()

    const client = this.requireClient()
    const id = sessionId as SessionId

    // History is persistence-backed and can be rendered without a live Agent.
    // The follow stream delivers the snapshot window plus subsequent events
    // (this service owns it only after startEventStreams ran); wait for the
    // snapshot batch so a cold session is useful even if its preset can no
    // longer be resumed.
    if (this.streamAbort !== undefined) await this.waitForFollowSnapshot(sessionId)
    if (!this.isCurrentSelection(sessionId, generation)) return

    // session/modelCatalog owns the official cold-session resume path. It must
    // settle before skills/list: the latter intentionally never attaches an
    // Agent and otherwise races into "not found (not attached)" on startup.
    try {
      const models = await client.sessionModelCatalog()
      if (!this.isCurrentSelection(sessionId, generation)) return
      this.models = { ...models, current: models.default }
      this.fireChange()
    } catch (cause) {
      this.output.appendLine(vscode.l10n.t('[gateway] Failed to load the model catalog for session {0}: {1}', sessionId, errorMessage(cause)))
    }
    if (!this.isCurrentSelection(sessionId, generation)) return

    // These catalogs are independent after resume. A missing optional plugin
    // degrades only its panel instead of failing the entire workbench.
    const [skills, subagents, commands] = await Promise.allSettled([
      client.skillList({ sessionId: id }),
      client.subagentList(id),
      this.commandsFor(sessionId),
    ])
    if (!this.isCurrentSelection(sessionId, generation)) return
    if (skills.status === 'fulfilled') this.skills = skills.value.skills
    else this.logOptionalCatalogFailure('Skills', skills.reason)
    if (subagents.status === 'fulfilled') {
      this.subagents = subagents.value.entries
      this.subagentCount = this.subagents.length
    } else this.logOptionalCatalogFailure(vscode.l10n.t('sub-agent'), subagents.reason)
    if (commands.status === 'fulfilled') this.commands = commands.value
    else this.logOptionalCatalogFailure(vscode.l10n.t('slash command'), commands.reason)
    this.fireChange()
  }

  /** Opens ordinary sessions directly and resolves subagent transport through its direct parent. */
  async openSession(sessionId: string): Promise<void> {
    let summary = this.summaries.get(sessionId)
    if (summary === undefined) {
      await this.refreshSessionList()
      summary = this.summaries.get(sessionId)
    }
    if (summary?.origin === 'subagent' && summary.parentSessionId !== undefined) {
      await this.selectSession(String(summary.parentSessionId))
      const child = this.subagents.find((entry) => entry.kind === 'child' && String(entry.id) === sessionId)
      if (child === undefined || child.kind !== 'child') throw new Error(vscode.l10n.t('Could not resolve the sub-agent from its parent session.'))
      await this.selectSubagent(sessionId, child.mode)
      return
    }
    await this.selectSession(sessionId)
  }

  async loadOlder(): Promise<void> {
    const sessionId = this.requireActiveSession()
    const beforeSeq = this.entries[0]?.event.seq
    if (beforeSeq === undefined || !this.hasMore) return
    const address = this.activeFollowAddress()
    if (address === undefined) return
    const cursor = this.followCursor.get(sessionId)
    const page = await this.requireClient().sessionPage({
      address,
      throughSeq: cursor ?? 0,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      maxMessages: 60,
    })
    const records = NodeGatewayClient.expandRecords(page.records as unknown[]) as HistoryEntry[]
    const existing = new Set(this.entries.map((entry) => entry.event.seq))
    this.entries = [...records.filter((entry) => !existing.has(entry.event.seq)), ...this.entries]
    this.hasMore = page.hasMore
    this.fireChange()
  }

  /** Config-less convenience wrapper over {@link sendPrompt}. */
  async prompt(
    text: string,
    mode: 'queue' | 'steer' = 'queue',
    attachments: readonly PromptAttachment[] = [],
  ): Promise<void> {
    return this.sendPrompt(text, mode, attachments)
  }

  /**
   * Admits one prompt together with its staged configuration. The
   * configuration is never dropped and never mutates a running turn:
   *
   *  - idle fast path: the configuration is applied (awaited) before admission,
   *    so the turn starts with it (same-connection RPC ordering makes this
   *    deterministic);
   *  - busy path: the configuration rides a FIFO pending queue aligned with
   *    the runtime queue and is applied at the next turn boundary, when no
   *    turn is believed to be running;
   *  - preset changes that open a fresh session are always applied
   *    immediately, because the fork is a brand-new idle session.
   */
  async sendPrompt(
    text: string,
    mode: 'queue' | 'steer' = 'queue',
    attachments: readonly PromptAttachment[] = [],
    configuration?: PromptConfiguration,
    signals?: PromptEffortSignals,
  ): Promise<void> {
    const normalized = text.trim()
    if (normalized === '' && attachments.length === 0) return
    if (this.activeSessionId === undefined) await this.createSession()
    const sessionId = this.requireActiveSession()

    // Auto-isolation: sessions created through the host's native fork path
    // (uuid id, parentSession) inherit the parent's shared cwd and have no
    // worktree, so their work is not fenced. Before the first message lands,
    // move the conversation into a fresh isolated worktree when the shared
    // checkout is clean; a dirty checkout is left alone (migrating would
    // strand its uncommitted changes outside the new worktree).
    if (this.subagentAddress === undefined && !this.isSessionIsolated(sessionId)) {
      await this.migrateUnisolatedSession(sessionId)
      // createSession() inside the migration switches the active session, so
      // the subsequent requireActiveSession() below already resolves the new id.
    }

    let deferredEntry: PendingConfigEntry | undefined
    if (configuration !== undefined) {
      const summary = this.summaries.get(sessionId)
      const transition = summary === undefined
        ? 'keep-session'
        : agentPresetTransition(
          summary.blank === true,
          summary.agentPreset ?? this.configuration.get().agentPreset,
          configuration.agentPreset,
        )
      // Image admission is checked against the session's live selection when
      // the prompt is enqueued, not when its turn starts. A queued image
      // prompt therefore cannot wait for the turn boundary when the staged
      // configuration moves to another model: apply the route change ahead of
      // admission even while a turn is running. The user staged that change
      // explicitly, and DSH snapshots per step, so only later steps observe it.
      const current = this.models?.current
      const currentModel = current?.model.split('/').pop() ?? current?.model
      const stagedModel = configuration.model.split('/').pop() ?? configuration.model
      const changesRoute = current !== undefined
        && (current.provider !== configuration.provider
          || currentModel !== stagedModel)
      const carriesImages = attachments.some((attachment) => attachment.kind === 'image')
      if (transition === 'create-session' || !this.pendingQueue.isBusy(sessionId) || (carriesImages && changesRoute)) {
        // Fresh-session forks are idle by construction; the idle fast path
        // applies in-order ahead of admission.
        await this.applyPromptConfiguration(configuration, signals)
      } else {
        const entry: PendingConfigEntry = {
          configuration,
          ...(signals === undefined ? {} : { signals }),
        }
        deferredEntry = this.pendingQueue.pend(sessionId, entry)
      }
    } else if (this.isSessionBusy(sessionId)) {
      // Keep the FIFO alignment with the runtime queue: a config-less prompt
      // still owns one queue slot.
      deferredEntry = this.pendingQueue.pend(sessionId, { none: true })
    }

    // Keep the legacy ordering: staged composer settings are applied before a
    // registered slash command is executed, so commands observe that selection.
    if (this.subagentAddress === undefined && this.isRegisteredHostCommand(normalized)) {
      await this.executeHostCommand(normalized)
      return
    }
    // The preset-fork path may have selected a new session above.
    const target = this.requireActiveSession()
    const ordinarySession = this.subagentAddress === undefined

    // Optimistic admission marker: a second prompt sent in the same tick must
    // see this session as busy even before the turn events arrive.
    if (ordinarySession) this.pendingQueue.admit(target)

    // A mode-switch digest rides as its own leading text block so the
    // transcript can collapse it (see the webview carry-over card) while the
    // model still reads it before the attachments and the user's message. The
    // payload stays armed until the ordinary-session send succeeds, so a
    // failed submit can retry without losing the context.
    const carried = ordinarySession ? this.peekCarryOverFor(target) : undefined
    const content: PromptContentPart[] = [
      ...(carried === undefined ? [] : [{ type: 'text' as const, text: carried }]),
      ...attachments.map(attachmentPart),
      ...(normalized === '' ? [] : [{ type: 'text' as const, text: normalized }]),
    ]
    try {
      if (this.subagentAddress === undefined) {
        await this.requireClient().sessionPrompt({
          requestId: newPromptRequestId(),
          sessionId: target as SessionId,
          mode,
          content,
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        })
      } else {
        if (this.subagentAddress.mode === 'one-shot') throw new Error(vscode.l10n.t('One-shot sub-agent history is read-only.'))
        if (content.some((part) => part.type === 'image')) {
          throw new Error(vscode.l10n.t('Image attachments are not supported in sub-agent conversations.'))
        }
        await this.requireClient().subagentPrompt({
          requestId: newPromptRequestId(),
          parentSessionId: this.subagentAddress.parentSessionId,
          childSessionId: this.subagentAddress.childSessionId,
          mode: 'continuable',
          delivery: mode === 'steer' ? 'steer' : 'queue',
          content: content.flatMap((part) => part.type === 'text' ? [{ type: 'text' as const, text: part.text }] : []),
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        })
      }
      if (ordinarySession) this.clearCarryOver(target)
    } catch (cause) {
      // The message never entered the queue: roll back the admission marker
      // and the pending slot so nothing is applied for a prompt that will
      // never run.
      if (ordinarySession) this.pendingQueue.forget(target)
      if (deferredEntry !== undefined) this.pendingQueue.unpend(sessionId, deferredEntry)
      throw cause
    }
  }

  /**
   * Promotes one still-pending queued prompt into the current turn, so it is
   * answered immediately instead of after the running turn completes.
   *
   * The host only accepts a queue steer while the agent is running and the
   * item still sits in the next-turn inbox. When that is refused
   * (`steer-unavailable` — the running turn ended, or the item moved into the
   * next-step inbox) the pending text is withdrawn and re-dispatched: a
   * `steer` prompt interrupts the running turn so the message is answered NOW;
   * when the agent is idle steering is refused again and the queued prompt
   * runs immediately instead. Either way the message goes out instead of
   * staying stranded in the queue dock. An item the turn already claimed
   * (`queue-item-not-found`) is silently ignored, matching the official UI.
   * Items carrying image attachments keep the original error, because their
   * content is a reference that cannot be re-submitted through the prompt
   * contract.
   */
  async steerQueued(itemId: string): Promise<void> {
    const sessionId = this.requireActiveSession()
    const client = this.requireClient()
    let response: { readonly code?: string; readonly message?: string }
    try {
      await client.sessionUpdateQueue({ sessionId: sessionId as SessionId, itemId: itemId as MessageId, action: { kind: 'steer' } })
      return
    } catch (cause) {
      response = codeOf(cause)
      if (response.code === 'queue-item-not-found') return
      if (response.code !== 'steer-unavailable') throw new Error(response.message ?? String(cause))
    }
    const item = this.queue.find((candidate) => candidate.id === itemId)
    if (item === undefined || item.message.content.some((block) => (block as { readonly type?: string }).type === 'image')) {
      throw new Error(response.message ?? vscode.l10n.t('This queued prompt is no longer steerable.'))
    }
    const text = item.message.content
      .filter((block): block is { readonly type: 'text'; readonly text: string } => (block as { readonly type?: string }).type === 'text')
      .map((block) => block.text)
      .join('\n')
    if (text.trim() === '') throw new Error(response.message ?? vscode.l10n.t('This queued prompt is no longer steerable.'))
    try {
      await client.sessionUpdateQueue({ sessionId: sessionId as SessionId, itemId: itemId as MessageId, action: { kind: 'remove' } })
    } catch (cause) {
      throw new Error(cause instanceof Error ? cause.message : String(cause))
    }
    const textContent = [{ type: 'text' as const, text }]
    try {
      await client.sessionPrompt({
        requestId: newPromptRequestId(),
        sessionId: sessionId as SessionId,
        mode: 'steer',
        content: textContent,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
      return
    } catch {
      // The running turn ended; the text goes out as a normal queued prompt.
    }
    try {
      await client.sessionPrompt({
        requestId: newPromptRequestId(),
        sessionId: sessionId as SessionId,
        mode: 'queue',
        content: textContent,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
    } catch (cause) {
      throw new Error(cause instanceof Error ? cause.message : String(cause))
    }
  }

  /** Withdraws one still-pending queued prompt before the agent claims it. */
  async removeQueued(itemId: string): Promise<void> {
    const sessionId = this.requireActiveSession()
    await this.requireClient().sessionUpdateQueue({ sessionId: sessionId as SessionId, itemId: itemId as MessageId, action: { kind: 'remove' } })
    // Removing an item breaks the FIFO alignment between the runtime queue
    // and the pending configurations; drop them instead of applying a stale
    // configuration to the wrong prompt.
    this.pendingQueue.dropForSession(sessionId)
  }

  /** Rewrites the text of one still-pending queued prompt. */
  async editQueued(itemId: string, text: string): Promise<void> {
    const sessionId = this.requireActiveSession()
    await this.requireClient().sessionUpdateQueue({ sessionId: sessionId as SessionId, itemId: itemId as MessageId, action: { kind: 'edit', content: [{ type: 'text', text }] } })
    // Same alignment concern as removeQueued: an edited item still occupies
    // its queue slot, but its original configuration intent is no longer
    // reliably attached to it.
    this.pendingQueue.dropForSession(sessionId)
  }

  async cancel(): Promise<void> {
    const sessionId = this.requireActiveSession()
    const restore = this.completions.cancel(sessionId)
    try {
      if (this.subagentAddress === undefined) {
        await this.requireClient().sessionCancel({ sessionId: sessionId as SessionId })
      } else if (this.subagentAddress.mode === 'continuable') {
        await this.requireClient().subagentInterrupt(this.subagentAddress.childSessionId, this.subagentAddress.parentSessionId)
      }
    } catch (cause) {
      restore()
      throw cause
    }
  }

  async selectSubagent(childSessionId: string, mode: 'one-shot' | 'continuable'): Promise<void> {
    const parentSessionId = this.subagentAddress?.childSessionId ?? this.requireActiveSession() as SessionId
    const address: SubagentAddress = {
      parentSessionId,
      childSessionId: childSessionId as SessionId,
      mode,
    }
    const list = await this.requireClient().subagentList(childSessionId)
    this.subagentAddress = address
    this.activeSessionId = childSessionId
    this.followCursor.set(childSessionId, 0)
    this.entries = []
    this.assistantStream.reset()
    this.hasMore = false
    this.models = undefined
    this.skills = []
    this.jobs = []
    this.queue = []
    this.subagents = list.entries
    this.subagentCount = list.entries.length
    this.projections = {}
    this.fireChange()
  }

  async selectParentSession(): Promise<void> {
    const parent = this.subagentAddress?.parentSessionId
    if (parent === undefined) return
    await this.selectSession(String(parent))
  }

  async selectModel(provider: string, model: string, reasoningEffort?: string, persist = true, signals?: PromptEffortSignals): Promise<void> {
    if (this.subagentAddress !== undefined) throw new Error(vscode.l10n.t('Sub-agents use the model selected when they were created.'))
    const sessionId = this.requireActiveSession()
    // Relay catalogs advertise prefixed ids (`deepseek/deepseek-v4-flash`
    // under a `commandcode` group) and the runtime matches selectModel by that
    // exact id, so the catalog id is passed through verbatim.
    let resolvedModel = model
    // The persisted model belongs to the provider the user last used, not
    // necessarily to the provider they are on now. When the catalog is loaded
    // and the requested model is not offered by this provider, fall back to
    // the provider's own first advertised model — never guess by bare id
    // suffix, because the same name under a different provider is a different
    // product.
    const providerModels = this.modelsFor(provider)
    if (providerModels.length > 0 && !providerModels.some((entry) => entry.id === model)) {
      resolvedModel = providerModels[0]!.id
    }
    // 'auto' is an extension-side selection layer: it is translated to one of
    // the model's own tiers here, never forwarded to the harness verbatim.
    let resolved: string | undefined
    if (reasoningEffort !== undefined && reasoningEffort !== '') {
      resolved = resolveEffortIntent(reasoningEffort as EffortIntent, this.reasoningEffortOptions(provider, resolvedModel), this.autoSignals(signals))
    }
    const selected = await this.requireClient().sessionSelectModel({
      sessionId: sessionId as SessionId,
      provider,
      model: resolvedModel,
      ...(resolved === undefined ? {} : { reasoningEffort: resolved }),
    })
    if (this.models !== undefined) this.models = { ...this.models, current: selected.selected }
    // Commit the per-session intent only after the harness accepted the
    // change, so a failed RPC cannot leave a stale intent behind.
    if (reasoningEffort !== undefined && reasoningEffort !== '') {
      await this.metaStore.setEffortIntent(sessionId, isAutoEffort(reasoningEffort) ? 'auto' : reasoningEffort as EffortIntent)
    }
    if (persist) {
      await this.configuration.setProviderIfConfigured(provider)
      // Persist the model unconditionally: relay providers expose ids outside
      // the bundled MODEL_OPTIONS whitelist, and leaving the default model as
      // `deepseek-v4-flash` while the provider is `commandcode` makes every
      // new session fail with "no configured model".
      await this.configuration.setModelId(resolvedModel)
      if (resolved !== undefined) await this.configuration.setReasoningEffortIfKnown(resolved)
    }
    this.fireChange()
  }

  async selectReasoning(reasoningEffort: string): Promise<void> {
    const current = this.models?.current
    if (current === undefined) throw new Error(vscode.l10n.t('The model catalog for the current session has not loaded yet.'))
    await this.selectModel(current.provider, current.model, reasoningEffort)
  }

  async toggleSessionPin(sessionId: string): Promise<void> {
    if (!this.summaries.has(sessionId)) throw new Error(vscode.l10n.t('Session not found.'))
    await this.metaStore.updateMeta(sessionId, (meta) => togglePinned(meta))
    this.fireChange()
  }

  async setSessionTags(sessionId: string, tags: readonly string[]): Promise<void> {
    if (!this.summaries.has(sessionId)) throw new Error(vscode.l10n.t('Session not found.'))
    await this.metaStore.updateMeta(sessionId, (meta) => setTags(meta, tags))
    this.fireChange()
  }

  /** True when a prompt sent right now would queue behind a running turn. */
  private isSessionBusy(sessionId: string): boolean {
    return this.pendingQueue.isBusy(sessionId)
  }

  /** Whether the active session's host command catalog contains a slash command. */
  hasHostCommand(name: string): boolean {
    return this.commands.some((command) => command.kind === 'host' && command.name === name)
  }

  async selectPreset(agentPreset: string): Promise<void> {
    await this.configuration.setAgentPresetIfKnown(agentPreset)
    const sessionId = this.activeSessionId
    const summary = sessionId === undefined ? undefined : this.summaries.get(sessionId)
    if (sessionId !== undefined && summary?.blank === true) {
      await this.requireClient().agentPresetSelect(sessionId as SessionId, agentPreset)
      this.summaries.set(sessionId, { ...summary, agentPreset })
    }
    this.fireChange()
  }

  async selectPermission(value: string): Promise<void> {
    if (value === 'custom') return
    if (!isPermissionPresetId(value)) {
      throw new Error(vscode.l10n.t('Unknown sandbox permission preset: {0}', value))
    }
    await this.applyPermission(value, true)
  }

  /** Refreshes the slash-command menu from the active session's host registration. */
  async refreshCommands(): Promise<void> {
    const sessionId = this.activeSessionId
    if (sessionId === undefined) return
    const generation = this.selectionGeneration
    try {
      const commands = await this.commandsFor(sessionId)
      if (!this.isCurrentSelection(sessionId, generation)) return
      this.commands = commands
    } catch (cause) {
      if (!this.isCurrentSelection(sessionId, generation)) return
      this.commands = projectionCommands(undefined, this.labels)
      this.output.appendLine(vscode.l10n.t('[gateway] Failed to refresh the command list: {0}', errorMessage(cause)))
    }
    this.fireChange()
  }

  async setPlanMode(active: boolean): Promise<void> {
    await this.executeHostCommand(active ? '/plan' : '/plan off')
  }

  async createGoal(objective: string): Promise<void> {
    const sessionId = this.requireActiveSession()
    await this.requireClient().goalCreate(sessionId as SessionId, { objective })
  }

  async mutateGoal(action: 'pause' | 'resume' | 'complete' | 'clear'): Promise<void> {
    const sessionId = this.requireActiveSession()
    const goal = projectionGoal(this.projections.goal)
    if (goal === undefined) throw new Error(vscode.l10n.t('The current session has no goal.'))
    const ref = { id: goal.id as never, revision: goal.revision }
    await this.requireClient().goalAction(action, sessionId as SessionId, ref)
  }

  async rename(title: string): Promise<void> {
    const sessionId = this.requireActiveSession()
    const renamed = await this.requireClient().sessionRename({ sessionId: sessionId as SessionId, title })
    // A manual rename makes the title the user's own: a later first message
    // must not overwrite it, so the session opts out of auto-titling.
    this.metaStore.markAutoTitled(sessionId)
    this.applyTitleProjection(sessionId, renamed.title)
    this.fireChange()
  }

  async fork(atSeq?: number): Promise<void> {
    const sessionId = this.requireActiveSession()
    const forked = await this.requireClient().sessionFork({
      sessionId: sessionId as SessionId,
      ...(atSeq === undefined ? {} : { atSeq }),
    })
    await this.refreshSessionList()
    await this.selectSession(String(forked.sessionId))
  }

  /** Reloads the session list after an external import and optionally opens one. */
  async reloadSessions(selectSessionId?: string): Promise<void> {
    await this.refreshSessionList()
    if (selectSessionId !== undefined && this.summaries.has(selectSessionId)) {
      await this.selectSession(selectSessionId)
    }
  }

  /**
   * Hides one history row from grouping surfaces via the official Harness
   * archive set. Blank drafts may be archived too, so an unwanted
   * new-conversation stub can be hidden; unknown ids are a no-op.
   */
  async archiveSession(id: string): Promise<void> {
    await this.archives.archive(id, (sessionId) => this.summaries.has(sessionId))
  }

  /**
   * Returns the unified diff between an isolated session's branch and its base
   * branch, for the "Review diff" end-of-session action.
   */
  async worktreeDiff(sessionId: string): Promise<string | undefined> {
    return this.worktrees.diffText(sessionId)
  }

  /**
   * Diff of the most recently concluded turn: the isolated worktree diff when
   * the session runs in one, else the shared checkout's uncommitted diff
   * against HEAD. Used by the "Review" action on the edited-files card.
   */
  async recentTurnDiff(sessionId: string | undefined): Promise<string | undefined> {
    if (sessionId === undefined) return undefined
    const isolated = await this.worktrees.diffText(sessionId)
    if (isolated !== undefined) return isolated
    const repoRoot = this.worktrees.repoRootFor(sessionId)
    if (repoRoot === undefined) return undefined
    return this.worktrees.workingTreeDiff(repoRoot)
  }

  /** The worktree record for one session, if isolated (host-side triage reads it). */
  worktreeRecord(sessionId: string): { readonly baseBranch: string; readonly branch: string } | undefined {
    const record = this.worktrees.recordFor(sessionId)
    return record === undefined ? undefined : { baseBranch: record.baseBranch, branch: record.branch }
  }

  /** The currently open session id, if any. */
  openSessionId(): string | undefined {
    return this.activeSessionId
  }

  /**
   * The worktree root of the currently active session, when isolated. File
   * references rendered for that conversation resolve against this root first,
   * so links point at the copy the agent actually edited.
   */
  activeWorktreeRoot(): string | undefined {
    return this.activeSessionId === undefined ? undefined : this.worktrees.recordFor(this.activeSessionId)?.worktreePath
  }

  /** Merges an isolated session's branch back into its base branch. */
  async worktreeMerge(sessionId: string): Promise<{ ok: boolean; message: string }> {
    const outcome = await this.worktrees.mergeBack(sessionId)
    if (outcome.ok) {
      await this.refreshSessionList()
      this.fireChange()
    }
    return outcome
  }

  /**
   * Auto-merge for `worktreeAutoMerge = onTurnEnd`: when a conversation turn
   * completes, the session's worktree changes are merged back into the base
   * branch and — when the main checkout was clean — synced into the main
   * working tree, so the project reflects the session's work without a manual
   * step. The session keeps its worktree for the next turn; consecutive turns
   * merge their incremental delta. Safe by construction: a dirty main checkout
   * is never clobbered (the branch still advances, reported `merged-dirty`),
   * and a conflicting merge leaves the worktree intact for manual triage.
   */
  private maybeAutoMergeWorktree(sessionId: string): void {
    if (this.configuration.get().worktreeAutoMerge !== 'onTurnEnd') return
    if (this.worktrees.recordFor(sessionId) === undefined) return
    if (this.autoMergingSessions.has(sessionId)) return
    this.autoMergingSessions.add(sessionId)
    void this.worktreeMerge(sessionId)
      .then((outcome) => {
        if (outcome.ok) {
          if (outcome.message === 'merged-dirty') {
            void vscode.window.showWarningMessage(vscode.l10n.t(
              'Session {0} changes were merged into {1}, but your working tree had uncommitted changes and still trails the branch.',
              sessionId,
              this.worktrees.recordFor(sessionId)?.baseBranch ?? 'the base branch',
            ))
          }
          // 'merged' and 'no-changes' need no user attention.
          return
        }
        if (outcome.message !== 'no-worktree') {
          void vscode.window.showErrorMessage(vscode.l10n.t(
            'Could not auto-merge session {0}: {1}. The session worktree was kept for manual triage.',
            sessionId,
            outcome.message,
          ))
        }
      })
      .catch((cause: unknown) => {
        this.output.appendLine(vscode.l10n.t('[gateway] Auto-merge failed for session {0}: {1}', sessionId, errorMessage(cause)))
      })
      .finally(() => {
        this.autoMergingSessions.delete(sessionId)
      })
  }



  /** Removes an isolated session's worktree and branch; the session log stays. */
  async worktreeDiscard(sessionId: string): Promise<{ ok: boolean; message: string }> {
    const outcome = await this.worktrees.discard(sessionId)
    if (outcome.ok) {
      await this.refreshSessionList()
      this.fireChange()
    }
    return outcome
  }

  /** Removes worktrees whose session no longer exists (deleted or crashed mid-create). */
  async cleanupOrphanWorktrees(): Promise<string[]> {
    const live = new Set(this.summaries.keys())
    const removed = await this.worktrees.cleanupOrphans(live)
    if (removed.length > 0) {
      this.output.appendLine(vscode.l10n.t('[gateway] Removed {0} orphaned worktree(s): {1}', removed.length, removed.join(', ')))
      this.fireChange()
    }
    return removed
  }

  /**
   * Brings a Harness-archived session back to this workbench's default list.
   * The bundled runtime (0.1.1-rc.2) has no unarchive RPC, so restore is a
   * durable overlay on the official set.
   */
  async restoreSession(sessionId: string): Promise<void> {
    await this.archives.restore(sessionId)
  }

  /** Downloads the current session's log ZIP (with descendants) for saving. */
  async exportSession(sessionId?: string, includeDescendants = true): Promise<Uint8Array> {
    const client = this.requireClient()
    if (!(client instanceof NodeGatewayClient)) throw new Error(vscode.l10n.t('The current Gateway does not support session export.'))
    const id = sessionId ?? this.requireActiveSession()
    return await client.exportSession(id, includeDescendants)
  }

  async answerApproval(key: string, outcome: 'allowed-once' | 'rejected'): Promise<void> {
    await this.respondToInteraction(key, 'approval', { kind: 'result', value: outcome })
  }

  async answerQuestions(
    key: string,
    answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[],
  ): Promise<void> {
    await this.respondToInteraction(key, 'question', {
      kind: 'result',
      value: {
        answers: answers.map((answer) => ({
          id: answer.id,
          selected: [...answer.selected],
          ...(answer.custom === undefined || answer.custom.trim() === '' ? {} : { custom: answer.custom.trim() }),
        })),
      },
    })
  }

  dispose(): void {
    this.disconnect()
    this.runtimeSubscription.dispose()
    this.changeEmitter.dispose()
    this.completionEmitter.dispose()
  }

  private startEventStreams(): void {
    this.streamAbort?.abort()
    this.completions.clear()
    this.interactions.disconnect()
    this.fireChange()
    const abort = new AbortController()
    this.streamAbort = abort
    void this.pumpControl(abort.signal)
    void this.pumpRemoteEvents(abort.signal)
    void this.pumpWorkspace(abort.signal)
    void this.pumpActiveFollow(abort.signal)
  }

  /** Host-wide live state (queue/jobs/projections): `session/control`. */
  private async pumpControl(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        for await (const frame of this.requireClient().sessionControl(signal)) {
          this.handleControl(frame)
          this.markConnected()
        }
      } catch (cause) {
        if (!signal.aborted) this.output.appendLine(vscode.l10n.t('[gateway] Reconnecting control stream: {0}', errorMessage(cause)))
      }
      if (!signal.aborted) await this.waitToReconnect(signal)
    }
  }

  /** Host-wide forwarded events (session added/removed/status, commands, …): `$events`. */
  private async pumpRemoteEvents(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let generation: number | undefined
      try {
        for await (const remote of this.requireClient().remoteEvents(signal)) {
          // Abort can race a buffered frame from the old socket.
          if (signal.aborted) break
          if (remote.type === 'ready') {
            generation = this.interactions.beginConnection(remote.clientId)
            this.markConnected()
            continue
          }
          if (remote.type === 'waterfall') {
            if (generation !== undefined) this.handleWaterfall(remote, generation)
            continue
          }
          if (remote.type === 'cancel') {
            if (generation !== undefined && this.interactions.cancel(remote.eventId, generation)) this.fireChange()
            continue
          }
          if (remote.type === 'emit') {
            this.handleRemoteEvent(remote.event, remote.args)
          }
        }
      } catch (cause) {
        if (!signal.aborted) this.output.appendLine(vscode.l10n.t('[gateway] Reconnecting remote-event stream: {0}', errorMessage(cause)))
      } finally {
        // A host replays live requests after the next ready frame. Drop old
        // delivery/client IDs even if no cancellation arrived before the loss.
        if (generation !== undefined && this.interactions.disconnect(generation)) this.fireChange()
        if (!signal.aborted) this.completions.clear()
      }
      if (!signal.aborted) await this.waitToReconnect(signal)
    }
  }

  /** Workspace/browse state (archived set): `workspace/follow`. */
  private async pumpWorkspace(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        for await (const frame of this.requireClient().workspaceFollow(signal)) {
          this.handleWorkspace(frame)
          this.markConnected()
        }
      } catch (cause) {
        if (!signal.aborted) this.output.appendLine(vscode.l10n.t('[gateway] Reconnecting workspace stream: {0}', errorMessage(cause)))
      }
      if (!signal.aborted) await this.waitToReconnect(signal)
    }
  }

  /** Keeps the active session's follow stream in sync with the current selection. */
  private async pumpActiveFollow(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (this.activeSessionId === undefined) {
        await this.waitToReconnect(signal)
        continue
      }
      const sessionId = this.activeSessionId
      const address = this.activeFollowAddress()
      if (address === undefined) {
        await this.waitToReconnect(signal)
        continue
      }
      const followAddress = address
      // A per-follow abort lets selectSession force a fresh snapshot when the
      // selection changes. Without it the pump can sit idle on the old
      // session's live stream (which never re-sends its snapshot), so a
      // switched-away-and-back session renders an empty conversation.
      const followAbort = new AbortController()
      this.followAbort = followAbort
      const onSharedAbort = (): void => followAbort.abort()
      signal.addEventListener('abort', onSharedAbort, { once: true })
      try {
        for await (const frame of this.requireClient().sessionFollow({ address: followAddress as import('./gateway-wire.js').SessionAddress, maxMessages: 80 }, followAbort.signal)) {
          if (this.activeSessionId !== sessionId) break
          this.handleFollowFrame(sessionId, frame)
          this.markConnected()
        }
      } catch (cause) {
        if (!signal.aborted && !followAbort.signal.aborted) {
          this.output.appendLine(vscode.l10n.t('[gateway] Reconnecting session stream: {0}', errorMessage(cause)))
        }
      }
      signal.removeEventListener('abort', onSharedAbort)
      if (this.followAbort === followAbort) this.followAbort = undefined
      if (!signal.aborted && !followAbort.signal.aborted && this.activeSessionId === sessionId) await this.waitToReconnect(signal)
    }
  }

  private activeFollowAddress(): import('./gateway-wire.js').SessionAddress | undefined {
    if (this.activeSessionId === undefined) return undefined
    if (this.subagentAddress !== undefined) {
      return { kind: 'subagent', parentSessionId: this.subagentAddress.parentSessionId, childSessionId: this.subagentAddress.childSessionId, mode: this.subagentAddress.mode }
    }
    return { kind: 'session', sessionId: this.activeSessionId as SessionId }
  }

  private handleFollowFrame(sessionId: string, frame: FollowFrame): void {
    if (frame.type === 'assistant-stream') {
      this.assistantStream.accept(frame.frame)
      this.fireChange()
      return
    }
    if (frame.type === 'snapshot') {
      const records = NodeGatewayClient.expandRecords(frame.records as unknown[]) as HistoryEntry[]
      this.followCursor.set(sessionId, frame.cursor)
      // Merging keeps events received during the read (and repair re-reads).
      this.entries = mergeHistory(records, this.entries)
      this.assistantStream.reset(frame.assistantStream)
      for (const { event } of this.entries) this.assistantStream.settle(event)
      this.hasMore = frame.hasMore
      this.projections = recordValue((frame.projections as { readonly values?: Record<string, unknown> } | undefined)?.values)
      this.applyTitleProjection(sessionId, projectionTitle((frame.projections as { readonly values?: Record<string, unknown> } | undefined)?.values))
      this.resolveFollowSnapshotWaiter(sessionId)
      this.fireChange()
      return
    }
    const event = frame.event as unknown as HistoryEntry['event']
    this.acceptEvent({ event })
    this.assistantStream.settle(event)
    const summary = this.summaries.get(sessionId)
    if (summary !== undefined) {
      this.summaries.set(sessionId, {
        ...summary,
        updatedAt: Math.max(summary.updatedAt, event.time),
        blank: event.type === 'turn/start' ? false : summary.blank,
      })
    }
    this.maybeAutoTitle(sessionId, event)
    if (event.type === 'turn/end') {
      this.pendingQueue.release(sessionId)
      this.maybeAutoMergeWorktree(sessionId)
      // Background-session turn/end notifications are NOT raised here: this handler is only ever invoked
      // by pumpActiveFollow(), which breaks its loop the moment activeSessionId changes (see the check just
      // before handleFollowFrame is called) — so `sessionId` below is always the active session already.
      // The `api-session/status` branch of handleRemoteEvent() is the host-wide signal used instead.
    }
    this.fireChange()
  }

  private handleControl(frame: ControlFrame): void {
    const active = this.activeSessionId
    if (frame.type === 'baseline') {
      if (active !== undefined) {
        this.queue = frame.value.queues[active as SessionId] ?? this.queue
        this.jobs = frame.value.jobs[active as SessionId] ?? this.jobs
      }
      if (frame.value.projections !== undefined && active !== undefined) {
        for (const [sessionId, projection] of Object.entries(frame.value.projections)) {
          const value = (projection as { readonly values?: Record<string, unknown> }).values ?? {}
          this.projections = { ...this.projections, ...value }
          this.applyTitleProjection(sessionId, projectionTitle(value))
        }
      }
    } else if (frame.type === 'queue') {
      if (String(frame.sessionId) === active) this.queue = frame.items
    } else if (frame.type === 'jobs') {
      if (String(frame.sessionId) === active) this.jobs = frame.jobs
    } else if (frame.type === 'projection') {
      if (String(frame.sessionId) === active) this.projections[frame.key] = frame.value
      if (frame.key === 'title') this.applyTitleProjection(String(frame.sessionId), typeof frame.value === 'string' ? frame.value : undefined)
    }
    this.fireChange()
  }

  private handleRemoteEvent(event: string, args: readonly unknown[]): void {
    if (event === 'api-session/added') {
      const summary = args[0] as SessionSummary | undefined
      if (summary !== undefined) this.summaries.set(String(summary.sessionId), summary)
      void this.refreshSessionList()
    } else if (event === 'api-session/removed') {
      const removed = String(args[0] ?? '')
      this.summaries.delete(removed)
      this.pendingQueue.dropForSession(removed)
      this.pendingQueue.forget(removed)
      this.metaStore.removeSession(removed)
      this.interactions.removeSession(removed)
      this.completions.remove(removed)
    } else if (event === 'api-session/status') {
      const id = String(args[0] ?? '')
      const running = args[1] === true
      const summary = this.summaries.get(id)
      if (summary !== undefined) this.summaries.set(id, { ...summary, running, blank: running ? false : summary.blank })
      if (!running) this.pendingQueue.forget(id)
      const completion = this.completions.status(id, running)
      // Host-wide live edges cover both foreground and background conversations.
      // Child agents are part of their parent's work, not separate desktop alerts.
      if (completion !== undefined && summary !== undefined && summary.parentSessionId === undefined && summary.origin !== 'subagent') {
        this.completionEmitter.fire({ title: this.sessionTitle(id), failed: completion.failed })
      }
    } else if (event === 'api-session/activity') {
      const id = String(args[0] ?? '')
      const updatedAt = typeof args[1] === 'number' ? args[1] : undefined
      const summary = this.summaries.get(id)
      if (summary !== undefined && updatedAt !== undefined) this.summaries.set(id, { ...summary, updatedAt: Math.max(summary.updatedAt, updatedAt) })
    } else if (event === 'api-session/error') {
      const id = String(args[0] ?? '')
      const message = String(args[1] ?? '')
      this.completions.fail(id)
      this.output.appendLine(`[agent ${id}] ${message}`)
    } else if (event === 'commands/change' || event === 'agent-preset/selected') {
      void this.refreshCommands()
    } else if (event === 'llm/adapters-updated' || event === 'settings/document-updated') {
      void Promise.all([
        this.connectionSettings.refresh(),
        this.refreshModelCatalog(),
      ]).catch((cause: unknown) => {
        this.output.appendLine(vscode.l10n.t('[gateway] Failed to refresh provider settings: {0}', errorMessage(cause)))
      })
    }
    this.fireChange()
  }

  private handleWaterfall(frame: RemoteWaterfallEvent, generation: number): void {
    const pending = this.interactions.receive(frame, generation)
    if (pending === undefined) return
    this.fireChange()
    if (pending.sessionId === this.activeSessionId) return
    this.notifyPendingInteraction(pending)
  }

  /** Navigation does not own a request; its originating agent/session does. */
  private notifyPendingInteraction(pending: PendingInteraction): void {
    const title = this.sessionTitle(pending.sessionId)
    const actionLabel = vscode.l10n.t('Switch to conversation')
    const notification = pending.kind === 'approval'
      ? vscode.window.showWarningMessage(
        vscode.l10n.t('Harness session "{0}" requires approval for tool "{1}".', title, pending.view.toolName),
        actionLabel,
      )
      : vscode.window.showInformationMessage(
        vscode.l10n.t('Harness session "{0}" is waiting for your answer.', title),
        actionLabel,
      )
    void notification.then((action) => {
      // Toasts can outlive a cancellation or socket reconnect.
      if (action !== actionLabel || !this.interactions.has(pending.key)) return
      void this.openSession(pending.sessionId)
        .then(() => vscode.commands.executeCommand('deepseekHarness.chatView.focus'))
        .catch((err: unknown) => {
          this.output.appendLine(vscode.l10n.t('[gateway] Failed to switch session: {0}', errorMessage(err)))
        })
    })
  }

  private handleWorkspace(frame: unknown): void {
    const value = frame as { readonly type?: string; readonly value?: { readonly archivedSessionIds?: readonly unknown[] }; readonly archivedSessionIds?: readonly unknown[] }
    const archived = value.type === 'baseline' ? value.value?.archivedSessionIds : value.type === 'archived' ? value.archivedSessionIds : undefined
    if (archived !== undefined) {
      this.archivedFromHost = archived.map(String)
      // A host snapshot is authoritative: establish the baseline before
      // installing the set so the sweep inside install() treats the archived
      // ids as authoritative, even on the first frame.
      this.archives.installFromHost(this.archivedFromHost)
    }
    this.fireChange()
  }

  private acceptEvent(entry: HistoryEntry): void {
    const lastSeq = this.entries.at(-1)?.event.seq
    if (lastSeq !== undefined && entry.event.seq > lastSeq + 1) {
      void this.repairHistory()
      return
    }
    const existing = this.entries.findIndex((value) => value.event.seq === entry.event.seq)
    if (existing >= 0) this.entries[existing] = entry
    else this.entries.push(entry)
  }

  private resolveFollowSnapshotWaiter(sessionId: string): void {
    const resolve = this.followSnapshotWaiters.get(sessionId)
    this.followSnapshotWaiters.delete(sessionId)
    resolve?.()
  }

  /** Awaits the follow snapshot for `sessionId` (bounded; moves on without it). */
  private async waitForFollowSnapshot(sessionId: string, timeoutMs = 10_000): Promise<void> {
    const waiter = new Promise<void>((resolve) => {
      this.followSnapshotWaiters.set(sessionId, resolve)
    })
    const timer = setTimeout(() => this.resolveFollowSnapshotWaiter(sessionId), timeoutMs)
    try {
      await waiter
    } finally {
      clearTimeout(timer)
    }
  }

  private followAddressFor(sessionId: string): import('./gateway-wire.js').SessionAddress | undefined {
    const summary = this.summaries.get(sessionId)
    if (summary?.origin === 'subagent' && summary.parentSessionId !== undefined) {
      return { kind: 'subagent', parentSessionId: summary.parentSessionId, childSessionId: sessionId as SessionId, mode: summary.origin === 'subagent' ? 'continuable' : 'one-shot' }
    }
    return { kind: 'session', sessionId: sessionId as SessionId }
  }

  private async repairHistory(): Promise<void> {
    if (this.activeSessionId === undefined) return
    try {
      const address = this.activeFollowAddress()
      if (address === undefined) return
      // The follow stream heals itself on reconnect; a full page re-read is
      // only needed when the stream is absent, so refresh via the control
      // baseline instead of a second history RPC.
      await this.refreshSessionList()
      const cursor = this.followCursor.get(this.activeSessionId)
      if (cursor !== undefined) {
        const page = await this.requireClient().sessionPage({
          address,
          throughSeq: cursor,
          maxMessages: 80,
        })
        this.entries = NodeGatewayClient.expandRecords(page.records as unknown[]) as HistoryEntry[]
        this.hasMore = page.hasMore
      }
      this.fireChange()
    } catch (cause) {
      this.output.appendLine(vscode.l10n.t('[gateway] Failed to repair session history: {0}', errorMessage(cause)))
    }
  }

  private async refreshSessionList(): Promise<void> {
    const items = await this.requireClient().sessionList()
    const seen = new Set(items.map((summary) => String(summary.sessionId)))
    for (const key of [...this.summaries.keys()]) if (!seen.has(key)) this.summaries.delete(key)
    for (const summary of items) this.summaries.set(String(summary.sessionId), summary)
    this.fireChange()
  }







  /** The model's supported reasoning tiers, falling back to the harness set.
   * Provider is matched first: distinct providers may expose the same model id
   * with different effort catalogs. Relay catalogs prefix ids, so the bare
   * suffix is matched too. */
  private reasoningEffortOptions(provider: string, model: string): readonly { readonly id: string }[] {
    const bare = model.split('/').pop() ?? model
    const efforts = this.models?.groups
      .find((group) => group.id === provider)
      ?.models.find((entry) => entry.id === model || entry.id.split('/').pop() === bare || entry.id === bare)
      ?.reasoning?.efforts
    if (efforts !== undefined && efforts.length > 0) return efforts
    return DEFAULT_REASONING_OPTIONS
  }

  /** Task signals used when resolving an 'auto' effort; prompt-level overrides win. */
  private autoSignals(prompt?: PromptEffortSignals): AutoEffortSignals {
    return {
      promptTokens: prompt?.promptTokens ?? 0,
      attachmentCount: prompt?.attachmentCount ?? 0,
      imageCount: prompt?.imageCount ?? 0,
      // Only the currently loaded history page (max 80 messages) is available
      // here, so this heuristic is intentionally window-scoped.
      historyTurns: projectSessionStats(this.entries).turns,
    }
  }



  private sessionTitle(sessionId: string): string {
    const summary = this.summaries.get(sessionId)
    if (summary !== undefined) return sessionListItem(summary, this.labels).title
    return sessionId
  }

  private visibleSummaries(): SessionSummary[] {
    return this.orderedSummaries().filter((summary) => !this.archives.isArchived(String(summary.sessionId)) && this.inCurrentWorkspace(summary))
  }



  private sessionListItemWithIsolation(summary: SessionSummary): ReturnType<typeof sessionListItem> {
    const item = sessionListItem(summary, this.labels)
    if (this.worktrees.recordFor(String(summary.sessionId)) !== undefined) return { ...item, isolated: true }
    // No worktree: the session runs directly in the shared workspace folder
    // (git missing, non-git workspace, detached HEAD, or worktree-add failure).
    // Mark it so the user can tell fenced sessions from ones that share the
    // same code with every other non-isolated session.
    return { ...item, shared: true }
  }

  private async refreshPresets(): Promise<void> {
    this.presets = (await this.requireClient().agentPresetList()).presets
    this.fireChange()
  }

  private orderedSummaries(): SessionSummary[] {
    return [...this.summaries.values()]
      // Blank (never-written) sessions are drafts, not history: they must not
      // appear in the history panel or be auto-resumed. They stay in `summaries`
      // so the composer can still use one it just created, and a blank draft is
      // dropped as soon as the user switches away or a real turn begins.
      .filter((summary) => !summary.blank)
      .sort((left, right) => {
        const leftRank = this.metaStore.metaSortRankFor(String(left.sessionId))
        const rightRank = this.metaStore.metaSortRankFor(String(right.sessionId))
        if (leftRank !== rightRank) return leftRank - rightRank
        return right.updatedAt - left.updatedAt
      })
  }

  /** The first workspace folder open in this window, or undefined when none is. */
  private currentWorkspaceCwd(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  }

  /**
   * Whether a session belongs to the project currently open in this window.
   * With no workspace folder open there is no project to scope by, so every
   * session is visible; otherwise only sessions recorded against that exact
   * folder are shown (history follows the project, nothing is deleted). An
   * isolated session's cwd is its worktree inside the repo, so scoping maps it
   * back to the repository root first.
   */
  private inCurrentWorkspace(summary: SessionSummary): boolean {
    const cwd = this.worktrees.displayCwd(String(summary.sessionId), summary.cwd)
    return sameWorkspacePath(cwd, this.currentWorkspaceCwd())
  }

  private isCurrentSelection(sessionId: string, generation: number): boolean {
    return this.activeSessionId === sessionId && this.selectionGeneration === generation
  }

  private async commandsFor(sessionId: string): Promise<readonly CommandEntry[]> {
    const client = this.requireClient()
    return projectionCommands(await client.listCommands(sessionId), this.labels)
  }

  private logOptionalCatalogFailure(name: string, cause: unknown): void {
    this.output.appendLine(vscode.l10n.t('[gateway] Failed to load the {0} catalog: {1}', name, errorMessage(cause)))
  }

  private async applyPermission(value: PermissionPresetId, persist: boolean): Promise<void> {
    await this.executeHostCommand(`/permission ${value}`)
    this.commitPermissionProjection(value)
    if (persist) await this.configuration.setPermissionModeIfKnown(value)
    this.fireChange()
  }

  /** Keeps the selector deterministic even before the projection push arrives. */
  private commitPermissionProjection(value: PermissionPresetId): void {
    const current = projectionPermissions(this.projections.permissions)
    if (current === undefined || !current.options.some((option) => option.value === value)) return
    this.projections.permissions = { ...current, currentValue: value }
  }

  private isRegisteredHostCommand(line: string): boolean {
    const name = /^\/([^\s/]+)/u.exec(line)?.[1]
    return name !== undefined && this.commands.some((command) => command.kind === 'host' && command.name === name)
  }

  private async executeHostCommand(line: string): Promise<void> {
    if (this.subagentAddress !== undefined) throw new Error(vscode.l10n.t('Sub-agents do not support host slash commands.'))
    const client = this.requireClient()
    if (!(client instanceof NodeGatewayClient)) throw new Error(vscode.l10n.t('The current Gateway does not support host slash commands.'))
    const execution = await client.executeCommand(this.requireActiveSession(), line)
    if (execution === undefined) throw new Error(vscode.l10n.t('Harness did not recognize command: {0}', line))
    if (execution.result?.kind === 'error') throw new Error(execution.result.text ?? vscode.l10n.t('Command failed: {0}', line))
  }

  private applyTitleProjection(sessionId: string, title: string | undefined): void {
    if (title === undefined) return
    const summary = this.summaries.get(sessionId)
    if (summary === undefined) return
    const existing = summary.projections
    const values = existing === undefined
      ? { title }
      : { ...(existing.values as Record<string, unknown>), title }
    const projections: SessionSummary['projections'] = existing === undefined
      ? { asOfSeq: -1, values: { title } }
      : { ...existing, values: { ...(existing.values as Record<string, unknown>), title } }
    this.summaries.set(sessionId, { ...summary, projections })
  }

  /**
   * Names a session from its first human message. Harness never projects a
   * title on its own, so every conversation would otherwise show the fallback
   * folder name in the history list. Only the first user message counts: once
   * a session has been auto-named it is left alone, so a manual rename is
   * never overwritten by a later message.
   */
  private maybeAutoTitle(sessionId: string, event: HistoryEntry['event']): void {
    if (event.type !== 'user/message') return
    const source = event.data?.source
    if (source?.kind !== 'user') return
    // rename() operates on the active session only, so a background session's
    // message must never rename whatever happens to be active right now.
    if (sessionId !== this.activeSessionId) return
    if (this.metaStore.isAutoTitled(sessionId)) return
    this.metaStore.markAutoTitled(sessionId)
    const title = conversationTitle(event.data.content)
    if (title === undefined || title === '') return
    void this.rename(title).catch((cause: unknown) => {
      // A failed rename must not break the message flow; the session keeps its
      // fallback title and can be named manually from the header.
      this.metaStore.clearAutoTitled(sessionId)
      this.output.appendLine(vscode.l10n.t('[gateway] Could not auto-title session {0}: {1}', sessionId, errorMessage(cause)))
    })
  }

  private async respondToInteraction(key: string, kind: PendingInteraction['kind'], outcome: RemoteEventOutcome): Promise<void> {
    const pending = this.interactions.beginResponse(key, kind)
    if (pending === undefined) {
      throw new Error(kind === 'approval'
        ? vscode.l10n.t('This approval request is no longer active.')
        : vscode.l10n.t('This question is no longer active.'))
    }
    let succeeded = false
    try {
      await this.requireClient().resolveRemoteEvent(pending.clientId, pending.eventId, outcome)
      succeeded = true
    } finally {
      this.interactions.finishResponse(pending, succeeded)
      this.fireChange()
    }
  }

  private markConnected(): void {
    // During initial bootstrap, both sockets open before the selected cold
    // session has finished resuming and loading its command catalog. Keep the
    // composer gated until start() commits the complete baseline.
    if (this.phase !== 'starting') this.phase = 'connected'
    this.error = undefined
    this.fireChange()
  }

  private async waitToReconnect(signal: AbortSignal): Promise<void> {
    this.phase = 'reconnecting'
    this.fireChange()
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 800)
      signal.addEventListener('abort', () => {
        clearTimeout(timeout)
        resolve()
      }, { once: true })
    })
    if (!signal.aborted) {
      await this.refreshSessionList().catch((cause: unknown) => {
        this.output.appendLine(vscode.l10n.t('[gateway] Failed to refresh the reconnect baseline: {0}', errorMessage(cause)))
      })
      await this.repairHistory()
    }
  }

  private requireClient(): NodeGatewayClient {
    if (this.client === undefined) throw new Error(vscode.l10n.t('Harness Gateway is not connected.'))
    return this.client
  }

  private requireActiveSession(): string {
    if (this.activeSessionId === undefined) throw new Error(vscode.l10n.t('Create or select a session first.'))
    return this.activeSessionId
  }

  private disconnect(): void {
    this.selectionGeneration += 1
    this.completions.clear()
    this.streamAbort?.abort()
    this.streamAbort = undefined
    this.interactions.disconnect()
    this.client = undefined
    this.connectionSettings.disconnect()
    this.phase = 'idle'
    // A new connection must re-establish the official archive baseline: bump
    // the revision so any in-flight workspace.list response is discarded, and
    // clear the flag so an empty archivedIds is not treated as authoritative.
    this.archives.markDisconnected()
    this.fireChange()
  }

  private fireChange(): void {
    if (this.publishScheduled) return
    this.publishScheduled = true
    setTimeout(() => {
      this.publishScheduled = false
      this.changeEmitter.fire()
    }, 16)
  }
}
/** Error-code extractor for steer fallbacks (RemoteError leaf fields). */
function codeOf(cause: unknown): { readonly code?: string; readonly message?: string } {
  const record = typeof cause === 'object' && cause !== null ? cause as Record<string, unknown> : undefined
  const code = typeof record?.code === 'string' ? record.code : undefined
  const message = typeof record?.message === 'string'
    ? record.message
    : cause instanceof Error ? cause.message : String(cause)
  return { ...(code === undefined ? {} : { code }), message }
}

/** Mints a client-side prompt correlation id (branded at the RPC edge). */
function newPromptRequestId(): import('@deepseek-ai/dsh-api-session-controller/types').SessionRequestId {
  return `vr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` as unknown as import('@deepseek-ai/dsh-api-session-controller/types').SessionRequestId
}

const START_BASELINE_TIMEOUT_S = 45
/** Remembers the last session the user had open so a reload resumes it. */
const DEFAULT_REASONING_OPTIONS: readonly { readonly id: string }[] = [
  { id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' },
]
