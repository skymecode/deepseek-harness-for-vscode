import * as vscode from 'vscode'
import type {
  ClientResponse,
  HistoryEntry,
  HostFrame,
  IApiClient,
  JobView,
  MessageId,
  MuxFrame,
  QueuedInboxItem,
  RpcId,
  RpcResponse,
  SessionId,
  SessionModels,
  SessionSummary,
  SkillEntry,
  SubagentAddress,
  SubagentListEntry,
} from '@deepseek-ai/dsh-client-connection/client'
import type { PromptContentPart } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { AgentPresetEntry } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ConfigurationService } from '../config/configuration.js'
import { buildCarryOverMessage, type CarryTurn } from '../domain/carry-over.js'
import { projectionContextPressure } from '../domain/context-pressure.js'
import { isPermissionPresetId, type PermissionPresetId } from '../domain/permissions.js'
import { isProviderRouteInUse } from '../domain/provider.js'
import type { PromptAttachment } from '../domain/prompt-context.js'
import { agentPresetTransition, type PromptConfiguration } from '../domain/prompt-configuration.js'
import { conversationTitle } from '../domain/session-title.js'
import { projectSessionChanges } from '../domain/session-changes.js'
import { isAutoEffort, resolveEffortIntent, type AutoEffortSignals, type EffortIntent, type PromptEffortSignals } from '../domain/session-effort.js'
import { pickAutoModel, type ModelProfileInput } from '../domain/model-profile.js'
import {
  metaSortRank,
  readSessionMeta,
  setTags,
  togglePinned,
  type SessionMeta,
} from '../domain/session-meta.js'
import { projectSessionStats, projectionSessionStats } from '../domain/session-stats.js'
import { sameWorkspacePath } from '../domain/workspace-scope.js'
import type { WorktreeService } from '../editor/worktree-service.js'
import {
  RESTORED_ARCHIVE_STATE_KEY,
  isEffectivelyArchived,
  partitionSessionLists,
  pruneRestoredArchiveIds,
  readRestoredArchiveIds,
} from '../domain/archived-sessions.js'
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
  type PendingApprovalView,
  type PendingQuestionView,
  type QueuedPromptView,
  type SubagentView,
  type WorkbenchLabels,
} from '../domain/workbench-state.js'
import type { HarnessHostRuntime } from '../runtime/web-runtime.js'
import type { ConnectionSettingsService } from '../services/connection-settings-service.js'
import { NodeGatewayClient } from './node-gateway-client.js'

interface PendingApprovalRecord extends PendingApprovalView {
  readonly rpcId: RpcId
  readonly approvalId: string
}

interface PendingQuestionRecord extends PendingQuestionView {
  readonly rpcId: RpcId
}

/**
 * One FIFO slot aligned with the runtime queue: a configuration awaiting
 * application at the next turn boundary, or a `none` marker keeping the
 * alignment for a queued prompt that carried no configuration.
 */
type PendingConfigEntry =
  | { readonly configuration: PromptConfiguration; readonly signals?: PromptEffortSignals }
  | { readonly none: true }

/**
 * Application service for the native VS Code workbench. It owns Gateway
 * connectivity and durable session state; neither the webview nor the runtime
 * launcher contains Harness business logic.
 */
export class HarnessGatewayService implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>()
  private readonly runtimeSubscription: vscode.Disposable
  private client: IApiClient | undefined
  private streamAbort: AbortController | undefined
  private summaries = new Map<string, SessionSummary>()
  private entries: HistoryEntry[] = []
  private hasMore = false
  private activeSessionId: string | undefined
  private models: SessionModels | undefined
  private presets: readonly AgentPresetEntry[] = []
  private skills: readonly SkillEntry[] = []
  private jobs: readonly JobView[] = []
  private queue: readonly QueuedInboxItem[] = []
  private approvals = new Map<string, PendingApprovalRecord>()
  private questions = new Map<string, PendingQuestionRecord>()
  private subagentCount = 0
  private subagents: SubagentListEntry[] = []
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
  private archivedIds = new Set<string>()
  // Sessions whose title was generated from their first user message. A
  // session is only auto-named once; after that the title is the user's to
  // edit, so a later message never overwrites a manual rename.
  private readonly autoTitledSessions = new Set<string>()
  // Restore overlay is persisted as a whole array via globalState, which is
  // shared across VS Code windows: concurrent archive/restore from two windows
  // is last-write-wins and may overwrite the other window's overlay. This is a
  // known, accepted limitation of the workbench-side restore (the official
  // runtime has no unarchive RPC); each window keeps its own in-memory view
  // and re-syncs on the next host snapshot.
  private restoredIds = new Set<string>()
  private archiveRevision = 0
  private archiveBaselineLoaded = false
  /** Per-session reasoning-effort intent ('auto' is an extension-side layer). */
  private readonly effortIntents = new Map<string, EffortIntent>()
  /** Locally-owned session metadata (pin / tags). */
  private readonly metaBySession = new Map<string, SessionMeta>()
  /**
   * Configurations awaiting application, FIFO-aligned with the runtime queue:
   * one entry per prompt admitted while the session was busy. Applied at the
   * next turn boundary so a queued prompt never loses its configuration and
   * no running turn is ever mutated mid-flight.
   */
  private readonly pendingConfigurations = new Map<string, PendingConfigEntry[]>()
  /** Sessions for which this client admitted a prompt whose turn events have
   * not arrived yet; guards the idle fast path against same-client rapid sends. */
  private readonly admittedSessions = new Set<string>()

  readonly onDidChange = this.changeEmitter.event

  constructor(
    private readonly runtime: HarnessHostRuntime,
    private readonly configuration: ConfigurationService,
    private readonly connectionSettings: ConnectionSettingsService,
    private readonly output: vscode.OutputChannel,
    private readonly globalState: vscode.Memento,
    private readonly worktrees: WorktreeService,
  ) {
    this.restoredIds = new Set(readRestoredArchiveIds(globalState.get(RESTORED_ARCHIVE_STATE_KEY)))
    loadEffortIntents(globalState.get(EFFORT_INTENT_STATE_KEY), this.effortIntents)
    loadSessionMeta(globalState.get(SESSION_META_STATE_KEY), this.metaBySession)
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
      const url = await this.runtime.start()
      this.client = new NodeGatewayClient(url)
      valueOf(await this.client.host.describe({}))
      await this.connectionSettings.connect(this.client)
      this.startEventStreams()
      await Promise.all([this.refreshSessionList(), this.refreshArchiveSet(), this.refreshPresets()])
      // The VSCode Memento can be rebuilt empty (state.vscdb), which wipes the
      // worktree registry. Recover records from disk mirrors so isolated
      // sessions keep their Review/Merge/Discard affordances across resets.
      const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)
      await this.worktrees.recover(workspaceRoots)
      // Sweep worktrees whose session no longer exists (crash between worktree
      // add and session create, or a session removed out-of-band).
      void this.cleanupOrphanWorktrees()
      const requested = this.activeSessionId
      const next = requested !== undefined && this.summaries.has(requested) && !this.isArchived(requested)
        ? requested
        : this.visibleSummaries()[0]?.sessionId
      if (next !== undefined) {
        try {
          await this.openSession(String(next))
        } catch (cause) {
          // One damaged or legacy transcript must not take down the Gateway.
          // The user can still create a new session and inspect the log.
          this.output.appendLine(vscode.l10n.t('[gateway] Failed to load recent sessions: {0}', errorMessage(cause)))
        }
      }
      this.phase = 'connected'
    } catch (cause) {
      this.phase = 'error'
      this.error = errorMessage(cause)
      this.output.appendLine(`[gateway] ${this.error}`)
    }
    this.fireChange()
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
    const partitioned = partitionSessionLists(
      scoped.map((summary) => {
        const item = this.sessionListItemWithIsolation(summary)
        const meta = this.metaFor(String(summary.sessionId))
        return meta === undefined ? item : { ...item, meta }
      }),
      this.archivedIds,
      this.restoredIds,
    )
    const activeSummary = this.activeSessionId === undefined ? undefined : this.summaries.get(this.activeSessionId)
    const projected = projectConversation(this.entries, this.labels)
    const permissions = projectionPermissions(this.projections.permissions)
    const plan = projectionPlan(this.projections.plan)
    const goal = projectionGoal(this.projections.goal)
    const tokenUsage = projectionTokenUsage(this.projections.tokenUsage)
    const contextPressure = projectionContextPressure(this.projections.contextPressure)
    const changes = projectSessionChanges(this.entries)
    const stats = projectionSessionStats(this.projections.sessionStats) ?? projectSessionStats(this.entries)
    const effortIntent = activeSummary === undefined ? undefined : this.effortIntents.get(String(activeSummary.sessionId))
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
      skills: this.skills,
      jobs: this.jobs,
      queue: this.queue.map(queuedPromptView),
      approvals: [...this.approvals.values()].map(stripApprovalTransport),
      questions: [...this.questions.values()].map(stripQuestionTransport),
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
    this.models = valueOf(await this.requireClient().sessions.models({ sessionId: this.activeSessionId as SessionId }))
    this.fireChange()
  }

  async createSession(agentPreset?: string): Promise<string> {
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
      created = valueOf(await client.sessions.create({ cwd: prepared.cwd, sessionId: sessionId as SessionId, agentPreset: selectedPreset }))
    } catch (cause) {
      // Roll back the freshly created worktree so a failed create cannot leak it.
      if (prepared.isolated) {
        await this.worktrees.discard(sessionId).catch(() => undefined)
        await this.worktrees.forgetSession(sessionId)
      }
      throw cause
    }
    if (!prepared.isolated && prepared.reason !== undefined) {
      const note = prepared.reason === 'no-git-repo'
        ? vscode.l10n.t('The workspace is not a git repository, so this session shares the workspace folder instead of an isolated worktree.')
        : prepared.reason === 'detached-head'
          ? vscode.l10n.t('The repository has no active branch (detached HEAD), so this session shares the workspace folder instead of an isolated worktree.')
          : vscode.l10n.t('Could not create an isolated worktree for this session, so it shares the workspace folder.')
      void vscode.window.showInformationMessage(note)
    }
    if (agentPreset !== undefined) await this.configuration.setAgentPresetIfKnown(agentPreset)
    await this.refreshSessionList()
    await this.selectSession(String(created.sessionId))
    await this.selectModel(config.provider, config.model, config.reasoningEffort, false)
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
    const result = valueOf(await this.requireClient().sessions.search({ query: normalized }))
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
    const generation = ++this.selectionGeneration
    this.activeSessionId = sessionId
    this.subagentAddress = undefined
    this.entries = []
    this.hasMore = false
    this.models = undefined
    this.skills = []
    this.jobs = []
    this.queue = []
    this.approvals.clear()
    this.questions.clear()
    this.subagentCount = 0
    this.subagents = []
    this.projections = {}
    this.commands = projectionCommands(undefined, this.labels)
    this.fireChange()

    const client = this.requireClient()
    const id = sessionId as SessionId

    // History is persistence-backed and can be rendered without a live Agent.
    // Load it first so a cold session is useful even if its preset can no
    // longer be resumed. Mux events received during the read are merged in.
    const historyValue = valueOf(await client.sessions.history({ sessionId: id, maxMessages: 80 }))
    if (!this.isCurrentSelection(sessionId, generation)) return
    this.entries = mergeHistory(historyValue.events, this.entries)
    this.hasMore = historyValue.hasMore
    this.projections = recordValue(historyValue.projections?.values)
    this.applyTitleProjection(sessionId, projectionTitle(historyValue.projections?.values))
    this.fireChange()

    // session.models owns the official cold-session resume path. It must
    // settle before skills.list: the latter intentionally never attaches an
    // Agent and otherwise races into "not found (not attached)" on startup.
    try {
      const models = valueOf(await client.sessions.models({ sessionId: id }))
      if (!this.isCurrentSelection(sessionId, generation)) return
      this.models = models
      this.fireChange()
    } catch (cause) {
      this.output.appendLine(vscode.l10n.t('[gateway] Failed to load the model catalog for session {0}: {1}', sessionId, errorMessage(cause)))
    }
    if (!this.isCurrentSelection(sessionId, generation)) return

    // These catalogs are independent after resume. A missing optional plugin
    // degrades only its panel instead of failing the entire workbench.
    const [skills, subagents, commands] = await Promise.allSettled([
      client.skills.list({ sessionId: id }),
      client.subagents.list({ parentSessionId: id }),
      this.commandsFor(sessionId),
    ])
    if (!this.isCurrentSelection(sessionId, generation)) return
    if (skills.status === 'fulfilled') this.skills = valueOf(skills.value).skills
    else this.logOptionalCatalogFailure('Skills', skills.reason)
    if (subagents.status === 'fulfilled') {
      this.subagents = valueOf(subagents.value).entries
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
    const page = this.subagentAddress === undefined
      ? valueOf(await this.requireClient().sessions.history({
        sessionId: sessionId as SessionId,
        beforeSeq,
        maxMessages: 60,
      }))
      : valueOf(await this.requireClient().subagents.history({
        ...this.subagentAddress,
        beforeSeq,
        maxMessages: 60,
      }))
    const existing = new Set(this.entries.map((entry) => entry.event.seq))
    this.entries = [...page.events.filter((entry) => !existing.has(entry.event.seq)), ...this.entries]
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
    let sessionId = this.requireActiveSession()

    // Auto-isolation: sessions created through the host's native fork path
    // (uuid id, parentSession) inherit the parent's shared cwd and have no
    // worktree, so their work is not fenced. Before the first message lands,
    // move the conversation into a fresh isolated worktree when the shared
    // checkout is clean; a dirty checkout is left alone (migrating would
    // strand its uncommitted changes outside the new worktree).
    if (this.subagentAddress === undefined && !this.isSessionIsolated(sessionId)) {
      await this.migrateUnisolatedSession(sessionId)
      // createSession() inside the migration may switch the active session.
      // Rebind before staging configuration so FIFO/busy state follows the
      // session that will actually receive the prompt.
      sessionId = this.requireActiveSession()
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
      if (transition === 'create-session' || !this.isSessionBusy(sessionId)) {
        // Fresh-session forks are idle by construction; the idle fast path
        // applies in-order ahead of admission.
        await this.applyPromptConfiguration(configuration, signals)
      } else {
        const entry: PendingConfigEntry = {
          configuration,
          ...(signals === undefined ? {} : { signals }),
        }
        deferredEntry = this.pendConfiguration(sessionId, entry)
      }
    } else if (this.isSessionBusy(sessionId)) {
      // Keep the FIFO alignment with the runtime queue: a config-less prompt
      // still owns one queue slot.
      deferredEntry = this.pendConfiguration(sessionId, { none: true })
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
    if (ordinarySession) this.admittedSessions.add(target)

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
        valueOf(await this.requireClient().sessions.prompt({
          sessionId: target as SessionId,
          mode,
          content,
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }))
      } else {
        if (this.subagentAddress.mode === 'one-shot') throw new Error(vscode.l10n.t('One-shot sub-agent history is read-only.'))
        if (content.some((part) => part.type === 'image')) {
          throw new Error(vscode.l10n.t('Image attachments are not supported in sub-agent conversations.'))
        }
        valueOf(await this.requireClient().subagents.prompt({
          ...this.subagentAddress,
          content: content.flatMap((part) => part.type === 'text' ? [{ type: 'text' as const, text: part.text }] : []),
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }))
      }
      if (ordinarySession) this.clearCarryOver(target)
    } catch (cause) {
      // The message never entered the queue: roll back the admission marker
      // and the pending slot so nothing is applied for a prompt that will
      // never run.
      if (ordinarySession) this.admittedSessions.delete(target)
      if (deferredEntry !== undefined) this.unpendConfiguration(sessionId, deferredEntry)
      throw cause
    }
  }

  /**
   * Promotes one still-pending queued prompt into the current turn, so it is
   * answered immediately instead of after the running turn completes. When the
   * running turn was just cancelled the host refuses steering (an idle agent
   * accepts no steer and returns `steer-unavailable`); in that case withdraw
   * the still-pending text item and re-send its content so the message still
   * goes out instead of being stranded in the queue dock. Items carrying image
   * attachments keep the original error, because their content is a reference
   * that cannot be re-submitted through the prompt contract.
   */
  async steerQueued(itemId: string): Promise<void> {
    const sessionId = this.requireActiveSession()
    const client = this.requireClient()
    const response = await client.sessions.updateQueue({
      sessionId: sessionId as SessionId,
      itemId: itemId as MessageId,
      action: { kind: 'steer' },
    })
    if (response.result.ok) return
    if (response.result.error.code !== 'steer-unavailable') {
      throw new Error(response.result.error.message)
    }
    const item = this.queue.find((candidate) => candidate.id === itemId)
    if (item === undefined || item.message.content.some((block) => block.type === 'image')) {
      throw new Error(response.result.error.message)
    }
    const text = item.message.content
      .filter((block): block is { readonly type: 'text'; readonly text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    if (text.trim() === '') throw new Error(response.result.error.message)
    const removed = await client.sessions.updateQueue({
      sessionId: sessionId as SessionId,
      itemId: itemId as MessageId,
      action: { kind: 'remove' },
    })
    if (!removed.result.ok) throw new Error(removed.result.error.message)
    // The fallback re-submits the text as a new queue item. The current prompt
    // RPC does not return that item's id, so no pending configuration can be
    // safely rebound to it; clear the old slots rather than applying one to a
    // different queued prompt at a later boundary.
    this.pendingConfigurations.delete(sessionId)
    await client.sessions.prompt({
      sessionId: sessionId as SessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
  }

  /** Withdraws one still-pending queued prompt before the agent claims it. */
  async removeQueued(itemId: string): Promise<void> {
    const sessionId = this.requireActiveSession()
    valueOf(await this.requireClient().sessions.updateQueue({
      sessionId: sessionId as SessionId,
      itemId: itemId as MessageId,
      action: { kind: 'remove' },
    }))
    // Removing an item breaks the FIFO alignment between the runtime queue
    // and the pending configurations; drop them instead of applying a stale
    // configuration to the wrong prompt.
    this.pendingConfigurations.delete(sessionId)
  }

  /** Rewrites the text of one still-pending queued prompt. */
  async editQueued(itemId: string, text: string): Promise<void> {
    const sessionId = this.requireActiveSession()
    valueOf(await this.requireClient().sessions.updateQueue({
      sessionId: sessionId as SessionId,
      itemId: itemId as MessageId,
      action: { kind: 'edit', content: [{ type: 'text', text }] },
    }))
    // Same alignment concern as removeQueued: an edited item still occupies
    // its queue slot, but its original configuration intent is no longer
    // reliably attached to it.
    this.pendingConfigurations.delete(sessionId)
  }

  async cancel(): Promise<void> {
    const sessionId = this.requireActiveSession()
    if (this.subagentAddress === undefined) {
      valueOf(await this.requireClient().sessions.cancel({ sessionId: sessionId as SessionId }))
    } else if (this.subagentAddress.mode === 'continuable') {
      valueOf(await this.requireClient().subagents.interrupt(this.subagentAddress))
    }
  }

  async selectSubagent(childSessionId: string, mode: 'one-shot' | 'continuable'): Promise<void> {
    const parentSessionId = this.subagentAddress?.childSessionId ?? this.requireActiveSession() as SessionId
    const address: SubagentAddress = {
      parentSessionId,
      childSessionId: childSessionId as SessionId,
      mode,
    }
    const history = valueOf(await this.requireClient().subagents.history({ ...address, maxMessages: 80 }))
    const list = valueOf(await this.requireClient().subagents.list({ parentSessionId: childSessionId as SessionId }))
    this.subagentAddress = address
    this.activeSessionId = childSessionId
    this.entries = history.events
    this.hasMore = history.hasMore
    this.models = undefined
    this.skills = []
    this.jobs = []
    this.queue = []
    this.subagents = list.entries
    this.subagentCount = list.entries.length
    this.projections = recordValue(history.projections?.values)
    this.approvals.clear()
    this.questions.clear()
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
    // 'auto' is an extension-side selection layer: it is translated to one of
    // the model's own tiers here, never forwarded to the harness verbatim.
    let resolved: string | undefined
    if (reasoningEffort !== undefined && reasoningEffort !== '') {
      resolved = resolveEffortIntent(reasoningEffort as EffortIntent, this.reasoningEffortOptions(provider, model), this.autoSignals(signals))
    }
    const selected = valueOf(await this.requireClient().sessions.selectModel({
      sessionId: sessionId as SessionId,
      provider,
      model,
      ...(resolved === undefined ? {} : { reasoningEffort: resolved }),
    }))
    if (this.models !== undefined) this.models = { ...this.models, current: selected.selected }
    // Commit the per-session intent only after the harness accepted the
    // change, so a failed RPC cannot leave a stale intent behind.
    if (reasoningEffort !== undefined && reasoningEffort !== '') {
      const candidate = new Map(this.effortIntents)
      candidate.set(sessionId, isAutoEffort(reasoningEffort) ? 'auto' : reasoningEffort as EffortIntent)
      try {
        await this.persistEffortIntents(candidate)
        this.effortIntents.clear()
        for (const [key, value] of candidate) this.effortIntents.set(key, value)
      } catch {
        // The persistence helper logs the failure. Keep the previous in-memory
        // intent so a failed write cannot make the UI claim a durable change.
      }
    }
    if (persist) {
      await this.configuration.setProviderIfConfigured(provider)
      await this.configuration.setModelIfKnown(model)
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
    await this.updateSessionMeta(sessionId, (meta) => togglePinned(meta))
  }

  async setSessionTags(sessionId: string, tags: readonly string[]): Promise<void> {
    await this.updateSessionMeta(sessionId, (meta) => setTags(meta, tags))
  }

  /**
   * Persists the candidate meta before committing it to memory: a failed write
   * must not leave a ghost state that the UI would echo as if it had worked.
   */
  private async updateSessionMeta(sessionId: string, update: (meta: SessionMeta | undefined) => SessionMeta): Promise<void> {
    if (!this.summaries.has(sessionId)) throw new Error(vscode.l10n.t('Session not found.'))
    const next = update(this.metaFor(sessionId))
    const candidate = new Map(this.metaBySession)
    if (readSessionMeta(next) === undefined) candidate.delete(sessionId)
    else candidate.set(sessionId, next)
    await this.persistSessionMeta(candidate)
    this.metaBySession.clear()
    for (const [key, value] of candidate) this.metaBySession.set(key, value)
    this.fireChange()
  }

  private metaFor(sessionId: string): SessionMeta | undefined {
    return this.metaBySession.get(sessionId)
  }

  /** True while events or this client's own admission say a turn is running. */
  private isTurnRunning(sessionId: string): boolean {
    return this.summaries.get(sessionId)?.running === true || this.admittedSessions.has(sessionId)
  }

  /** True when a prompt sent right now would queue behind a running turn. */
  private isSessionBusy(sessionId: string): boolean {
    return this.isTurnRunning(sessionId)
  }

  private pendConfiguration(sessionId: string, entry: PendingConfigEntry): PendingConfigEntry {
    const list = this.pendingConfigurations.get(sessionId)
    if (list === undefined) this.pendingConfigurations.set(sessionId, [entry])
    else list.push(entry)
    return entry
  }

  private unpendConfiguration(sessionId: string, entry: PendingConfigEntry): void {
    const list = this.pendingConfigurations.get(sessionId)
    if (list === undefined) return
    const index = list.indexOf(entry)
    if (index !== -1) list.splice(index, 1)
    if (list.length === 0) this.pendingConfigurations.delete(sessionId)
  }

  /**
   * Applies the oldest queued configuration at a turn boundary. Runs only when
   * no turn is believed to be running (never mutates a live turn); a skipped
   * or failed application retries at the next boundary instead of losing the
   * user's configuration. `none` markers are consumed to keep FIFO alignment
   * with the runtime queue.
   */
  private flushPendingConfiguration(sessionId: string): void {
    const list = this.pendingConfigurations.get(sessionId)
    const entry = list?.[0]
    if (entry === undefined) return
    if (this.isTurnRunning(sessionId)) return
    if ('none' in entry) {
      list!.shift()
      if (list!.length === 0) this.pendingConfigurations.delete(sessionId)
      return
    }
    void this.applyPromptConfiguration(entry.configuration, entry.signals).then(
      () => {
        const current = this.pendingConfigurations.get(sessionId)
        if (current === undefined || current[0] !== entry) return
        current.shift()
        if (current.length === 0) this.pendingConfigurations.delete(sessionId)
      },
      (cause: unknown) => {
        this.output.appendLine(vscode.l10n.t('[gateway] Failed to apply a queued configuration: {0}', errorMessage(cause)))
      },
    )
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
      valueOf(await this.requireClient().agentPresets.select({
        sessionId: sessionId as SessionId,
        agentPreset,
      }))
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
    valueOf(await this.requireClient().goals.create({ sessionId: sessionId as SessionId, objective }))
  }

  async mutateGoal(action: 'pause' | 'resume' | 'complete' | 'clear'): Promise<void> {
    const sessionId = this.requireActiveSession()
    const goal = projectionGoal(this.projections.goal)
    if (goal === undefined) throw new Error(vscode.l10n.t('The current session has no goal.'))
    const ref = { id: goal.id as never, revision: goal.revision }
    const api = this.requireClient().goals
    if (action === 'pause') valueOf(await api.pause({ sessionId: sessionId as SessionId, ref }))
    else if (action === 'resume') valueOf(await api.resume({ sessionId: sessionId as SessionId, ref }))
    else if (action === 'complete') valueOf(await api.complete({ sessionId: sessionId as SessionId, ref }))
    else valueOf(await api.clear({ sessionId: sessionId as SessionId, ref }))
  }

  async rename(title: string): Promise<void> {
    const sessionId = this.requireActiveSession()
    const renamed = valueOf(await this.requireClient().sessions.rename({
      sessionId: sessionId as SessionId,
      title,
    }))
    // A manual rename makes the title the user's own: a later first message
    // must not overwrite it, so the session opts out of auto-titling.
    this.autoTitledSessions.add(sessionId)
    this.applyTitleProjection(sessionId, renamed.title)
    this.fireChange()
  }

  async fork(atSeq?: number): Promise<void> {
    const sessionId = this.requireActiveSession()
    const forked = valueOf(await this.requireClient().sessions.fork({
      sessionId: sessionId as SessionId,
      ...(atSeq === undefined ? {} : { atSeq }),
    }))
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
    const summary = this.summaries.get(id)
    if (summary === undefined) return
    const snapshot = new Set(this.restoredIds)
    this.restoredIds.delete(id)
    try {
      const archived = valueOf(await this.requireClient().workspace.archiveSession({
        sessionId: id as SessionId,
      })).archivedSessionIds
      this.installArchivedIds(archived.map(String), false)
    } catch (cause) {
      await this.rollbackRestoredOverlay(snapshot, cause)
      throw cause
    }
    try {
      await this.persistRestoredIds()
    } catch (cause) {
      await this.rollbackRestoredOverlay(snapshot, cause)
      throw cause
    }
    this.fireChange()
  }

  /**
   * Restores the exact pre-operation overlay and flushes it to disk. A
   * concurrent host frame may have persisted a partial overlay (the deleted id)
   * in the background while our RPC was pending; rolling back memory alone
   * would leave that stale partial state on disk, losing the restore after
   * restart. Re-persisting the snapshot closes the gap.
   */
  private async rollbackRestoredOverlay(snapshot: ReadonlySet<string>, cause: unknown): Promise<void> {
    this.restoredIds = new Set(snapshot)
    try {
      await this.persistRestoredIds()
    } catch (persistCause) {
      this.output.appendLine(vscode.l10n.t('[gateway] Failed to roll back the restored session list: {0}', errorMessage(persistCause)))
    }
    this.output.appendLine(vscode.l10n.t('[gateway] Archive operation failed: {0}', errorMessage(cause)))
  }

  /**
   * Returns the unified diff between an isolated session's branch and its base
   * branch, for the "Review diff" end-of-session action.
   */
  async worktreeDiff(sessionId: string): Promise<string | undefined> {
    return this.worktrees.diffText(sessionId)
  }

  /** The worktree record for one session, if isolated (host-side triage reads it). */
  worktreeRecord(sessionId: string): { readonly baseBranch: string; readonly branch: string } | undefined {
    const record = this.worktrees.recordFor(sessionId)
    return record === undefined ? undefined : { baseBranch: record.baseBranch, branch: record.branch }
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
    if (!this.archivedIds.has(sessionId)) return
    const snapshot = new Set(this.restoredIds)
    this.restoredIds.add(sessionId)
    try {
      await this.persistRestoredIds()
    } catch (cause) {
      // Roll back the exact pre-operation overlay so a failed persistence
      // cannot report a restore that would vanish after restart, cannot drop
      // an ID that was already present before this call, and cannot leave a
      // stale partial overlay on disk from a concurrent host frame.
      this.restoredIds = new Set(snapshot)
      try {
        await this.persistRestoredIds()
      } catch (persistCause) {
        this.output.appendLine(vscode.l10n.t('[gateway] Failed to roll back the restored session list: {0}', errorMessage(persistCause)))
      }
      throw cause
    }
    this.fireChange()
  }

  /** Downloads the current session's log ZIP (with descendants) for saving. */
  async exportSession(sessionId?: string, includeDescendants = true): Promise<Uint8Array> {
    const client = this.requireClient()
    if (!(client instanceof NodeGatewayClient)) throw new Error(vscode.l10n.t('The current Gateway does not support session export.'))
    const id = sessionId ?? this.requireActiveSession()
    return await client.exportSession(id, includeDescendants)
  }

  async answerApproval(key: string, outcome: 'allowed-once' | 'rejected'): Promise<void> {
    const pending = this.approvals.get(key)
    if (pending === undefined) throw new Error(vscode.l10n.t('This approval request is no longer active.'))
    await this.respond(pending.rpcId, {
      sessionId: this.requireActiveSession(),
      approvalId: pending.approvalId,
      outcome,
    })
  }

  async answerQuestions(
    key: string,
    answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[],
  ): Promise<void> {
    const pending = this.questions.get(key)
    if (pending === undefined) throw new Error(vscode.l10n.t('This question is no longer active.'))
    await this.respond(pending.rpcId, {
      sessionId: this.requireActiveSession(),
      answer: {
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
  }

  private startEventStreams(): void {
    this.streamAbort?.abort()
    const abort = new AbortController()
    this.streamAbort = abort
    void this.pumpMux(abort.signal)
    void this.pumpHost(abort.signal)
  }

  private async pumpMux(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        for await (const envelope of this.requireClient().events.mux({}, signal, () => this.markConnected())) {
          this.handleMux(envelope.rpcId, envelope.payload)
        }
      } catch (cause) {
        if (!signal.aborted) this.output.appendLine(vscode.l10n.t('[gateway] Reconnecting Mux stream: {0}', errorMessage(cause)))
      }
      if (!signal.aborted) await this.waitToReconnect(signal)
    }
  }

  private async pumpHost(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        for await (const envelope of this.requireClient().events.host({}, signal, () => this.markConnected())) {
          this.handleHost(envelope.payload)
        }
      } catch (cause) {
        if (!signal.aborted) this.output.appendLine(vscode.l10n.t('[gateway] Reconnecting Host stream: {0}', errorMessage(cause)))
      }
      if (!signal.aborted) await this.waitToReconnect(signal)
    }
  }

  private handleMux(rpcId: RpcId, frame: MuxFrame): void {
    if (frame.type === 'session/event') {
      const id = String(frame.sessionId)
      if (id === this.activeSessionId) this.acceptEvent({ event: frame.event, ...(frame.view === undefined ? {} : { view: frame.view }) })
      const summary = this.summaries.get(id)
      if (summary !== undefined) {
        this.summaries.set(id, {
          ...summary,
          updatedAt: Math.max(summary.updatedAt, frame.event.time),
          blank: frame.event.type === 'turn/start' ? false : summary.blank,
        })
      }
      this.maybeAutoTitle(id, frame.event)
      if (frame.event.type === 'turn/end') {
        this.admittedSessions.delete(id)
        this.flushPendingConfiguration(id)
      }
    } else if (frame.type === 'approval/requested' && String(frame.sessionId) === this.activeSessionId) {
      const key = `approval:${String(rpcId)}`
      this.approvals.set(key, {
        key,
        rpcId,
        approvalId: String(frame.approvalId),
        toolName: frame.toolName,
        ...(frame.reason === undefined ? {} : { reason: frame.reason }),
      })
    } else if (frame.type === 'approval/resolved') {
      for (const [key, pending] of this.approvals) {
        if (pending.approvalId === String(frame.approvalId)) this.approvals.delete(key)
      }
    } else if (frame.type === 'question/requested' && String(frame.sessionId) === this.activeSessionId) {
      const key = `question:${String(rpcId)}`
      this.questions.set(key, {
        key,
        rpcId,
        questions: frame.questions.map((question) => ({
          id: question.id,
          question: question.question,
          ...(question.header === undefined ? {} : { header: question.header }),
          ...(question.detail === undefined ? {} : { detail: question.detail }),
          options: question.options ?? [],
          multiSelect: question.multiSelect ?? false,
        })),
      })
    } else if (frame.type === 'question/resolved') {
      this.questions.delete(`question:${String(frame.questionRpcId)}`)
    } else if (frame.type === 'session/jobs' && String(frame.sessionId) === this.activeSessionId) {
      this.jobs = frame.jobs
    } else if (frame.type === 'session/queue' && String(frame.sessionId) === this.activeSessionId) {
      this.queue = frame.items
    } else if (frame.type === 'session/projection') {
      if (String(frame.sessionId) === this.activeSessionId) this.projections[frame.key] = frame.value
      if (frame.key === 'title') this.applyTitleProjection(String(frame.sessionId), typeof frame.value === 'string' ? frame.value : undefined)
    }
    this.fireChange()
  }

  private handleHost(frame: HostFrame): void {
    if (frame.type === 'host/session-added') {
      void this.refreshSessionList()
    } else if (frame.type === 'host/session-removed') {
      const removed = String(frame.sessionId)
      this.summaries.delete(removed)
      this.pendingConfigurations.delete(removed)
      this.admittedSessions.delete(removed)
      if (this.effortIntents.delete(removed)) void this.persistEffortIntents().catch(() => undefined)
      if (this.metaBySession.delete(removed)) void this.persistSessionMeta().catch(() => undefined)
      // Remove the worktree and its retained project identity now that the
      // Host has authoritatively removed the session.
      void this.cleanupOrphanWorktrees()
    } else if (frame.type === 'host/archived-sessions-changed') {
      // A host snapshot is authoritative: establish the baseline before
      // installing the set so the sweep inside installArchivedIds treats the
      // archived ids as authoritative, even on the first frame.
      this.archiveBaselineLoaded = true
      this.installArchivedIds(frame.archivedSessionIds.map(String))
    } else if (frame.type === 'host/session-status') {
      const id = String(frame.sessionId)
      const summary = this.summaries.get(id)
      if (summary !== undefined) this.summaries.set(id, { ...summary, running: frame.running, blank: frame.running ? false : summary.blank })
      if (!frame.running) this.admittedSessions.delete(id)
    } else if (frame.type === 'host/agent-error') {
      this.output.appendLine(`[agent ${String(frame.sessionId)}] ${frame.message}`)
    } else if (frame.type === 'host/remote-event'
      && (frame.event === 'commands/change' || frame.event === 'agent-preset/selected')) {
      void this.refreshCommands()
    } else if (frame.type === 'host/remote-event'
      && (frame.event === 'llm/adapters-updated' || frame.event === 'settings/document-updated')) {
      void Promise.all([
        this.connectionSettings.refresh(),
        this.refreshModelCatalog(),
      ]).catch((cause: unknown) => {
        this.output.appendLine(vscode.l10n.t('[gateway] Failed to refresh provider settings: {0}', errorMessage(cause)))
      })
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

  private async repairHistory(): Promise<void> {
    if (this.activeSessionId === undefined) return
    try {
      const history = this.subagentAddress === undefined
        ? valueOf(await this.requireClient().sessions.history({
          sessionId: this.activeSessionId as SessionId,
          maxMessages: 80,
        }))
        : valueOf(await this.requireClient().subagents.history({
          ...this.subagentAddress,
          maxMessages: 80,
        }))
      this.entries = history.events
      this.hasMore = history.hasMore
      this.fireChange()
    } catch (cause) {
      this.output.appendLine(vscode.l10n.t('[gateway] Failed to repair session history: {0}', errorMessage(cause)))
    }
  }

  private async refreshSessionList(): Promise<void> {
    const items = valueOf(await this.requireClient().sessions.list({})).items
    this.summaries = new Map(items.map((summary) => [String(summary.sessionId), summary]))
    this.fireChange()
  }

  private async refreshArchiveSet(): Promise<void> {
    try {
      const revision = this.archiveRevision
      const archived = valueOf(await this.requireClient().workspace.list({})).archivedSessionIds
      // Discard a stale response: a host/archived-sessions-changed event or a
      // newer authoritative refresh may have advanced the set while this RPC
      // was in flight. Only an up-to-date revision may replace the state.
      if (this.archiveRevision !== revision) return
      // Establish the baseline before installing the set: installArchivedIds
      // sweeps the active selection, and the sweep must see the baseline as
      // loaded to treat archived ids as authoritative.
      this.archiveBaselineLoaded = true
      this.installArchivedIds(archived.map(String))
    } catch (cause) {
      // Keep the previous set: a transient failure should not unhide archived sessions.
      this.output.appendLine(vscode.l10n.t('[gateway] Failed to load the archived session set: {0}', errorMessage(cause)))
    }
    this.fireChange()
  }

  /**
   * Applies an authoritative archived-id snapshot. With `persist` (host events
   * and standalone refreshes) the pruned overlay is written in the background;
   * transactional callers pass false and own the single persistRestoredIds
   * call after the whole operation succeeds, so no concurrent write can leak
   * a partial overlay.
   */
  private installArchivedIds(ids: readonly string[], persist = true): void {
    const next = new Set(ids)
    const pruned = pruneRestoredArchiveIds(next, this.restoredIds)
    const archivedChanged = next.size !== this.archivedIds.size
      || [...next].some((id) => !this.archivedIds.has(id))
    this.archivedIds = next
    this.archiveRevision += archivedChanged ? 1 : 0
    if (persist && pruned.size !== this.restoredIds.size) {
      this.restoredIds = new Set(pruned)
      void this.persistRestoredIds().catch((cause: unknown) => {
        // Background pruning must not fail the caller; persistRestoredIds already
        // logs the underlying failure.
        this.output.appendLine(vscode.l10n.t('[gateway] Failed to persist pruned restored sessions: {0}', errorMessage(cause)))
      })
    }
    // Sweep after the overlay has been applied: a session that was restored in
    // this workbench and is archived again must be swept now that its restore
    // overlay is gone. Every authoritative archive-set change sweeps the active
    // selection — a session archived by another window / the official Web UI,
    // or one that became archived while offline and re-enters via the reconnect
    // baseline — instead of staying selected while only visible in the
    // Archived filter.
    this.sweepArchivedSelection()
  }

  private sweepArchivedSelection(): void {
    const active = this.activeSessionId
    if (active === undefined) return
    if (!this.isArchived(active)) return
    void this.leaveArchivedSelection().catch((cause: unknown) => {
      this.output.appendLine(vscode.l10n.t('[gateway] Failed to leave the archived session: {0}', errorMessage(cause)))
    })
  }

  private async persistRestoredIds(): Promise<void> {
    try {
      await this.globalState.update(RESTORED_ARCHIVE_STATE_KEY, [...this.restoredIds])
    } catch (cause) {
      this.output.appendLine(vscode.l10n.t('[gateway] Failed to save the restored session list: {0}', errorMessage(cause)))
      throw cause
    }
  }

  private async persistEffortIntents(source: ReadonlyMap<string, EffortIntent> = this.effortIntents): Promise<void> {
    try {
      await this.globalState.update(EFFORT_INTENT_STATE_KEY, Object.fromEntries(source))
    } catch (cause) {
      this.output.appendLine(vscode.l10n.t('[gateway] Failed to save the session reasoning intent: {0}', errorMessage(cause)))
      throw cause
    }
  }

  private async persistSessionMeta(source: ReadonlyMap<string, SessionMeta> = this.metaBySession): Promise<void> {
    try {
      await this.globalState.update(SESSION_META_STATE_KEY, Object.fromEntries(source))
    } catch (cause) {
      this.output.appendLine(vscode.l10n.t('[gateway] Failed to save the session metadata: {0}', errorMessage(cause)))
      throw cause
    }
  }

  /** The model's supported reasoning tiers, falling back to the harness set.
   * Provider is matched first: distinct providers may expose the same model id
   * with different effort catalogs. */
  private reasoningEffortOptions(provider: string, model: string): readonly { readonly id: string }[] {
    const efforts = this.models?.groups
      .find((group) => group.id === provider)
      ?.models.find((entry) => entry.id === model)
      ?.reasoning?.efforts
    if (efforts !== undefined && efforts.length > 0) return efforts
    return DEFAULT_REASONING_OPTIONS
  }

  /** Task signals used when resolving an 'auto' effort; prompt-level overrides win. */
  private autoSignals(prompt?: PromptEffortSignals): AutoEffortSignals {
    return {
      promptTokens: prompt?.promptTokens ?? 0,
      attachmentCount: prompt?.attachmentCount ?? 0,
      // Only the currently loaded history page (max 80 messages) is available
      // here, so this heuristic is intentionally window-scoped.
      historyTurns: projectSessionStats(this.entries).turns,
    }
  }

  private isArchived(sessionId: string): boolean {
    // Until the official archive set has been loaded once, an empty archivedIds
    // must not be treated as authoritative: that would expose (or hide) the
    // wrong sessions after a startup failure of workspace.list. Be conservative
    // and treat nothing as archived until the baseline is known.
    if (!this.archiveBaselineLoaded) return false
    return isEffectivelyArchived(sessionId, this.archivedIds, this.restoredIds)
  }

  private visibleSummaries(): SessionSummary[] {
    return this.orderedSummaries().filter((summary) => !this.isArchived(String(summary.sessionId)) && this.inCurrentWorkspace(summary))
  }

  private async leaveArchivedSelection(): Promise<void> {
    const next = this.visibleSummaries()[0]
    if (next !== undefined) {
      // openSession resolves sub-agent rows through their parent; selectSession
      // would route a sub-agent through the ordinary session APIs.
      await this.openSession(String(next.sessionId))
      return
    }
    await this.createSession()
  }

  private sessionListItemWithIsolation(summary: SessionSummary): ReturnType<typeof sessionListItem> {
    const item = sessionListItem(summary, this.labels)
    if (this.worktrees.recordFor(String(summary.sessionId)) === undefined) return item
    return { ...item, isolated: true }
  }

  private async refreshPresets(): Promise<void> {
    this.presets = valueOf(await this.requireClient().agentPresets.list({})).presets
    this.fireChange()
  }

  private orderedSummaries(): SessionSummary[] {
    return [...this.summaries.values()].sort((left, right) => {
      const leftRank = metaSortRank(this.metaBySession.get(String(left.sessionId)))
      const rightRank = metaSortRank(this.metaBySession.get(String(right.sessionId)))
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
    if (!(client instanceof NodeGatewayClient)) return projectionCommands(undefined, this.labels)
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
    const projections = existing === undefined
      ? { asOfSeq: -1, values: { title } }
      : { ...existing, values: { ...existing.values, title } }
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
    if (this.autoTitledSessions.has(sessionId)) return
    this.autoTitledSessions.add(sessionId)
    const title = conversationTitle(event.data.content)
    if (title === undefined || title === '') return
    void this.rename(title).catch((cause: unknown) => {
      // A failed rename must not break the message flow; the session keeps its
      // fallback title and can be named manually from the header.
      this.autoTitledSessions.delete(sessionId)
      this.output.appendLine(vscode.l10n.t('[gateway] Could not auto-title session {0}: {1}', sessionId, errorMessage(cause)))
    })
  }

  private async respond(rpcId: RpcId, value: unknown): Promise<void> {
    const message: ClientResponse = { type: 'client-response', rpcId, result: { ok: true, value } }
    const receipt = await this.requireClient().respond(message)
    if (!receipt.accepted) throw new Error(vscode.l10n.t('Harness rejected the response: {0}', receipt.reason))
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

  private requireClient(): IApiClient {
    if (this.client === undefined) throw new Error(vscode.l10n.t('Harness Gateway is not connected.'))
    return this.client
  }

  private requireActiveSession(): string {
    if (this.activeSessionId === undefined) throw new Error(vscode.l10n.t('Create or select a session first.'))
    return this.activeSessionId
  }

  private disconnect(): void {
    this.selectionGeneration += 1
    this.streamAbort?.abort()
    this.streamAbort = undefined
    this.client = undefined
    this.connectionSettings.disconnect()
    this.phase = 'idle'
    // A new connection must re-establish the official archive baseline: bump
    // the revision so any in-flight workspace.list response is discarded, and
    // clear the flag so an empty archivedIds is not treated as authoritative.
    this.archiveRevision += 1
    this.archiveBaselineLoaded = false
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

function attachmentPart(attachment: PromptAttachment): PromptContentPart {
  if (attachment.kind === 'image') {
    return {
      type: 'image',
      mediaType: attachment.mediaType,
      data: attachment.data,
      ...(attachment.name === undefined ? {} : { name: attachment.name }),
    }
  }
  const name = attachment.file === undefined
    ? vscode.l10n.t('Selection')
    : attachment.file
  const ext = name.includes('.') ? name.split('.').pop() ?? '' : ''
  const range = attachment.startLine !== undefined && attachment.endLine !== undefined
    ? vscode.l10n.t(' (lines {start}-{end})', { start: attachment.startLine, end: attachment.endLine })
    : ''
  const truncated = attachment.tooLong === true ? vscode.l10n.t(' (truncated)') : ''
  const label = attachment.kind === 'file' ? vscode.l10n.t('File') : vscode.l10n.t('Selection')
  return {
    type: 'text',
    text: `[${label}: ${name}${range}${truncated}]\n\`\`\`${ext}\n${attachment.text}\n\`\`\``,
  }
}

function valueOf<T>(response: RpcResponse<T>): T {
  if (!response.result.ok) throw new Error(response.result.error.message)
  return response.result.value
}

function stripApprovalTransport(value: PendingApprovalRecord): PendingApprovalView {
  return {
    key: value.key,
    toolName: value.toolName,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  }
}

function stripQuestionTransport(value: PendingQuestionRecord): PendingQuestionView {
  return { key: value.key, questions: value.questions }
}

/** Reduces one pending inbox item to the small, webview-friendly queue view. */
function queuedPromptView(item: QueuedInboxItem): QueuedPromptView {
  const text = item.message.content
    .filter((block): block is { readonly type: 'text'; readonly text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  return {
    id: String(item.id),
    placement: item.placement,
    text,
    hasMedia: item.message.content.some((block) => block.type === 'image'),
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Mints a session id for A2 worktree isolation. The id is created before the
 * session so the worktree can be laid out under it; the create RPC accepts a
 * preallocated id and echoes it back.
 */
function newSessionId(): string {
  return `dsh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? { ...value } : {}
}

/** Merge a persistence page with live Mux events that arrived during its read. */
function mergeHistory(base: readonly HistoryEntry[], live: readonly HistoryEntry[]): HistoryEntry[] {
  const bySeq = new Map<number, HistoryEntry>()
  for (const entry of base) bySeq.set(entry.event.seq, entry)
  for (const entry of live) bySeq.set(entry.event.seq, entry)
  return [...bySeq.values()].sort((left, right) => left.event.seq - right.event.seq)
}

/** Joins one message's content blocks into plain text for the mode-switch carry-over digest. */
function carryEventText(blocks: readonly unknown[]): string {
  const output: string[] = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null || !('type' in block)) continue
    const record = block as Record<string, unknown>
    if ((record.type === 'text' || record.type === 'reasoning') && typeof record.text === 'string') {
      output.push(record.text)
    }
  }
  return output.join('\n').trim()
}

function subagentView(entry: SubagentListEntry): SubagentView {
  if (entry.kind === 'diagnostic') return { kind: 'diagnostic', id: String(entry.id), reason: entry.reason }
  return {
    kind: 'child',
    id: String(entry.id),
    activity: entry.activity,
    hasChildren: entry.hasChildren,
    mode: entry.mode,
    ...('label' in entry && entry.label !== undefined ? { label: entry.label } : {}),
  }
}

const EFFORT_INTENT_STATE_KEY = 'deepseekHarness.sessionEffortIntents'
const SESSION_META_STATE_KEY = 'deepseekHarness.sessionMeta'
const DEFAULT_REASONING_OPTIONS: readonly { readonly id: string }[] = [
  { id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' },
]

function isEffortIntent(value: unknown): value is EffortIntent {
  return value === 'auto' || value === 'off' || value === 'low' || value === 'high' || value === 'max'
}

function loadEffortIntents(raw: unknown, target: Map<string, EffortIntent>): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
  for (const [sessionId, value] of Object.entries(raw)) {
    if (isEffortIntent(value)) target.set(sessionId, value)
  }
}

function loadSessionMeta(raw: unknown, target: Map<string, SessionMeta>): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
  for (const [sessionId, value] of Object.entries(raw)) {
    const meta = readSessionMeta(value)
    if (meta !== undefined) target.set(sessionId, meta)
  }
}

function localizedWorkbenchLabels(): WorkbenchLabels {
  return {
    commandModel: vscode.l10n.t('Switch the current session model (Flash / Pro)'),
    commandReasoning: vscode.l10n.t('Switch reasoning effort (off / low / high / max)'),
    commandPreset: vscode.l10n.t('Switch Agent Preset (standard / code / minimal / cordis)'),
    newConversation: vscode.l10n.t('New conversation'),
    toolResult: vscode.l10n.t('Tool result'),
    slashCommand: vscode.l10n.t('Slash command'),
    imageAttachment: vscode.l10n.t('[Image attachment]'),
    completed: vscode.l10n.t('Completed'),
    session: vscode.l10n.t('Session'),
    context: vscode.l10n.t('Context'),
    generationStopped: vscode.l10n.t('Generation stopped'),
    outputLimitReached: vscode.l10n.t('Output limit reached'),
    taskBlocked: vscode.l10n.t('Task blocked'),
    turnFailed: vscode.l10n.t('Turn failed'),
  }
}
