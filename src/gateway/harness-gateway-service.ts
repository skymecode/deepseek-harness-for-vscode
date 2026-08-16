import * as vscode from 'vscode'
import type {
  ClientResponse,
  HistoryEntry,
  HostFrame,
  IApiClient,
  JobView,
  MuxFrame,
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
import { projectionContextPressure } from '../domain/context-pressure.js'
import { isPermissionPresetId, type PermissionPresetId } from '../domain/permissions.js'
import { isProviderRouteInUse } from '../domain/provider.js'
import type { PromptAttachment } from '../domain/prompt-context.js'
import { agentPresetTransition, type PromptConfiguration } from '../domain/prompt-configuration.js'
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
  private approvals = new Map<string, PendingApprovalRecord>()
  private questions = new Map<string, PendingQuestionRecord>()
  private subagentCount = 0
  private subagents: SubagentListEntry[] = []
  private subagentAddress: SubagentAddress | undefined
  private projections: Record<string, unknown> = {}
  private readonly labels = localizedWorkbenchLabels()
  private commands: readonly CommandEntry[] = projectionCommands(undefined, this.labels)
  private phase: HarnessWorkbenchState['phase'] = 'idle'
  private error: string | undefined
  private publishScheduled = false
  private selectionGeneration = 0

  readonly onDidChange = this.changeEmitter.event

  constructor(
    private readonly runtime: HarnessHostRuntime,
    private readonly configuration: ConfigurationService,
    private readonly connectionSettings: ConnectionSettingsService,
    private readonly output: vscode.OutputChannel,
  ) {
    this.runtimeSubscription = runtime.onDidChangeState((state) => {
      if (state.phase === 'error') {
        this.phase = 'error'
        this.error = state.error
        this.fireChange()
      }
    })
  }

  async start(): Promise<void> {
    this.phase = 'starting'
    this.error = undefined
    this.fireChange()
    try {
      const url = await this.runtime.start()
      this.client = new NodeGatewayClient(url)
      valueOf(await this.client.host.describe({}))
      await this.connectionSettings.connect(this.client)
      this.startEventStreams()
      await Promise.all([this.refreshSessionList(), this.refreshPresets()])
      const requested = this.activeSessionId
      const next = requested !== undefined && this.summaries.has(requested)
        ? requested
        : this.orderedSummaries()[0]?.sessionId
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
    const hasApiKey = this.connectionSettings.hasConfiguredProvider
    const summaries = this.orderedSummaries().map((summary) => sessionListItem(summary, this.labels))
    const activeSummary = this.activeSessionId === undefined ? undefined : this.summaries.get(this.activeSessionId)
    const projected = projectConversation(this.entries, this.labels)
    const permissions = projectionPermissions(this.projections.permissions)
    const plan = projectionPlan(this.projections.plan)
    const goal = projectionGoal(this.projections.goal)
    const tokenUsage = projectionTokenUsage(this.projections.tokenUsage)
    const contextPressure = projectionContextPressure(this.projections.contextPressure)
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
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
        reasoning: model.reasoning?.efforts ?? [],
      }))) ?? [],
      messages: projected.messages,
      todos: projected.todos,
      skills: this.skills,
      jobs: this.jobs,
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
    }
    return {
      phase: this.phase,
      ...(this.error === undefined ? {} : { error: this.error }),
      hasApiKey,
      sessions: summaries,
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
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
    const created = valueOf(await client.sessions.create({ cwd, agentPreset: selectedPreset }))
    if (agentPreset !== undefined) await this.configuration.setAgentPresetIfKnown(agentPreset)
    await this.refreshSessionList()
    await this.selectSession(String(created.sessionId))
    await this.selectModel(config.provider, config.model, config.reasoningEffort, false)
    const permission = projectionPermissions(this.projections.permissions)?.currentValue
    if (permission !== config.permissionMode) await this.applyPermission(config.permissionMode, false)
    return String(created.sessionId)
  }

  /**
   * Commits composer choices immediately before the next prompt. Harness locks
   * an Agent Preset after a conversation starts, so changing DSH mode creates a
   * fresh session while model/reasoning changes remain session-local.
   */
  async applyPromptConfiguration(selection: PromptConfiguration): Promise<void> {
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
        sessionId = await this.createSession(selection.agentPreset)
      } else {
        await this.configuration.setAgentPresetIfKnown(selection.agentPreset)
      }
    }
    await this.selectModel(selection.provider, selection.model, selection.reasoningEffort)
  }

  async searchSessions(query: string): Promise<{ readonly sessionId: string; readonly snippet: string }[]> {
    const normalized = query.trim()
    if (normalized === '') return []
    const result = valueOf(await this.requireClient().sessions.search({ query: normalized }))
    return result.items.map((item) => ({ sessionId: String(item.sessionId), snippet: item.snippet }))
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

  async prompt(
    text: string,
    mode: 'queue' | 'steer' = 'queue',
    attachments: readonly PromptAttachment[] = [],
  ): Promise<void> {
    const normalized = text.trim()
    if (normalized === '' && attachments.length === 0) return
    if (this.activeSessionId === undefined) await this.createSession()
    const sessionId = this.requireActiveSession()
    if (this.subagentAddress === undefined && this.isRegisteredHostCommand(normalized)) {
      await this.executeHostCommand(normalized)
      return
    }
    const content: PromptContentPart[] = [
      ...attachments.map(attachmentPart),
      ...(normalized === '' ? [] : [{ type: 'text' as const, text: normalized }]),
    ]
    if (this.subagentAddress === undefined) {
      valueOf(await this.requireClient().sessions.prompt({
        sessionId: sessionId as SessionId,
        mode,
        content,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }))
    } else {
      if (this.subagentAddress.mode === 'one-shot') throw new Error(vscode.l10n.t('One-shot sub-agent history is read-only.'))
      valueOf(await this.requireClient().subagents.prompt({
        ...this.subagentAddress,
        content: content.flatMap((part) => part.type === 'text' ? [{ type: 'text' as const, text: part.text }] : []),
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }))
    }
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

  async selectModel(provider: string, model: string, reasoningEffort?: string, persist = true): Promise<void> {
    if (this.subagentAddress !== undefined) throw new Error(vscode.l10n.t('Sub-agents use the model selected when they were created.'))
    const sessionId = this.requireActiveSession()
    const selected = valueOf(await this.requireClient().sessions.selectModel({
      sessionId: sessionId as SessionId,
      provider,
      model,
      ...(reasoningEffort === undefined || reasoningEffort === '' ? {} : { reasoningEffort }),
    }))
    if (this.models !== undefined) this.models = { ...this.models, current: selected.selected }
    if (persist) {
      await this.configuration.setProviderIfConfigured(provider)
      await this.configuration.setModelIfKnown(model)
      if (reasoningEffort !== undefined) await this.configuration.setReasoningEffortIfKnown(reasoningEffort)
    }
    this.fireChange()
  }

  async selectReasoning(reasoningEffort: string): Promise<void> {
    const current = this.models?.current
    if (current === undefined) throw new Error(vscode.l10n.t('The model catalog for the current session has not loaded yet.'))
    await this.selectModel(current.provider, current.model, reasoningEffort)
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
      this.summaries.delete(String(frame.sessionId))
    } else if (frame.type === 'host/session-status') {
      const id = String(frame.sessionId)
      const summary = this.summaries.get(id)
      if (summary !== undefined) this.summaries.set(id, { ...summary, running: frame.running, blank: frame.running ? false : summary.blank })
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

  private async refreshPresets(): Promise<void> {
    this.presets = valueOf(await this.requireClient().agentPresets.list({})).presets
    this.fireChange()
  }

  private orderedSummaries(): SessionSummary[] {
    return [...this.summaries.values()].sort((left, right) => right.updatedAt - left.updatedAt)
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
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

function localizedWorkbenchLabels(): WorkbenchLabels {
  return {
    commandModel: vscode.l10n.t('Switch the current session model (Flash / Pro)'),
    commandReasoning: vscode.l10n.t('Switch reasoning effort (off / high / max)'),
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
