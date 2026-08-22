import type {
  AgentPresetEntry,
  JobView,
  ModelReasoningEffort,
  SessionSummary,
  SkillEntry,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { HistoryEntry } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {} from '@deepseek-ai/dsh-commands/types'
import type { ContextPressureView } from './context-pressure.js'
import type { SessionChangesView } from './session-changes.js'
import { projectTurnDurations, type TurnDurationView } from './turn-duration.js'

export type ConnectionPhase = 'idle' | 'starting' | 'connected' | 'reconnecting' | 'error'

export interface SessionListItem {
  readonly id: string
  readonly title: string
  readonly cwd?: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly agentPreset?: string
}

export interface ChatBlock {
  readonly kind: 'text' | 'reasoning' | 'image'
  readonly text: string
  /** Present only while the runtime is still emitting deltas for this block. */
  readonly streaming?: boolean
  /** Wall-clock timing derived from chunk events; only reasoning blocks carry it. */
  readonly duration?: TurnDurationView
  /** Reasoning tokens reported by the adapter for the step; only reasoning blocks carry it. */
  readonly reasoningTokens?: number
}

export interface ChatItem {
  readonly id: string
  readonly seq: number
  readonly time: number
  readonly kind: 'message' | 'context' | 'tool' | 'notice'
  readonly role?: 'user' | 'assistant'
  readonly title?: string
  readonly status?: 'running' | 'success' | 'error' | 'info'
  readonly blocks?: readonly ChatBlock[]
  readonly detail?: string
  /** Tool result text; present on a merged tool item once its result arrives. */
  readonly result?: string
  /**
   * Turn timing, attached to the turn's last assistant message so the
   * cumulative "worked for" counter lives at the bottom of the turn; tool
   * cards intentionally carry no timer of their own (Claude Code style).
   */
  readonly workDuration?: TurnDurationView
}

export interface PendingApprovalView {
  readonly key: string
  readonly toolName: string
  readonly reason?: string
}

export interface QuestionOptionView {
  readonly label: string
  readonly description?: string
}

export interface PendingQuestionView {
  readonly key: string
  readonly questions: readonly {
    readonly id: string
    readonly question: string
    readonly header?: string
    readonly detail?: string
    readonly options: readonly QuestionOptionView[]
    readonly multiSelect: boolean
  }[]
}

export interface ModelView {
  readonly provider: string
  /** Provider display name, e.g. "DeepSeek + 自动识图". */
  readonly providerName: string
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoning: readonly ModelReasoningEffort[]
}

export interface ActiveSessionView {
  readonly id: string
  readonly title: string
  readonly running: boolean
  readonly blank: boolean
  readonly agentPreset?: string
  readonly hasMore: boolean
  readonly model?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  readonly models: readonly ModelView[]
  readonly messages: readonly ChatItem[]
  readonly todos: readonly { readonly content: string; readonly status: string }[]
  readonly skills: readonly SkillEntry[]
  readonly jobs: readonly JobView[]
  readonly queue: readonly QueuedPromptView[]
  readonly approvals: readonly PendingApprovalView[]
  readonly questions: readonly PendingQuestionView[]
  readonly subagentCount: number
  readonly subagents: readonly SubagentView[]
  readonly parentSessionId?: string
  readonly subagentMode?: 'one-shot' | 'continuable'
  readonly permissions?: PermissionView
  readonly commands?: readonly CommandEntry[]
  readonly plan?: { readonly active: boolean; readonly pending: boolean }
  readonly goal?: GoalView
  readonly tokenUsage?: TokenUsageView
  readonly contextPressure?: ContextPressureView
  readonly changes?: SessionChangesView
}

/**
 * One still-pending composer prompt. Queued items are not durable session
 * events — the authoritative `session/queue` snapshot drives this list, and
 * `placement` decides where each item renders (QueueDock vs conversation tail).
 */
export interface QueuedPromptView {
  readonly id: string
  readonly placement: 'queued' | 'steering' | 'context'
  readonly text: string
  readonly hasMedia: boolean
}

export type SubagentView = {
  readonly kind: 'child'
  readonly id: string
  readonly activity: 'running' | 'inactive'
  readonly hasChildren: boolean
  readonly mode: 'one-shot' | 'continuable'
  readonly label?: string
} | {
  readonly kind: 'diagnostic'
  readonly id: string
  readonly reason: string
}

export interface PermissionView {
  readonly currentValue: string
  readonly options: readonly { readonly value: string; readonly name: string; readonly description?: string }[]
}

/**
 * A slash-command entry shown in the composer menu. `host` commands are
 * registered by the Harness runtime (`/compact`, `/plan`, …) and execute when
 * the composed line is sent; `extension` commands are handled locally by this
 * extension (model / reasoning / preset pickers).
 */
export interface CommandEntry {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
  readonly kind: 'host' | 'extension'
}

export interface WorkbenchLabels {
  readonly commandModel: string
  readonly commandReasoning: string
  readonly commandPreset: string
  readonly newConversation: string
  readonly toolResult: string
  readonly slashCommand: string
  readonly imageAttachment: string
  readonly completed: string
  readonly session: string
  readonly context: string
  readonly generationStopped: string
  readonly outputLimitReached: string
  readonly taskBlocked: string
  readonly turnFailed: string
}

export const ENGLISH_WORKBENCH_LABELS: WorkbenchLabels = {
  commandModel: 'Switch the current session model (Flash / Pro)',
  commandReasoning: 'Switch reasoning effort (off / low / high / max)',
  commandPreset: 'Switch Agent Preset (standard / code / minimal / cordis)',
  newConversation: 'New conversation',
  toolResult: 'Tool result',
  slashCommand: 'Slash command',
  imageAttachment: '[Image attachment]',
  completed: 'Completed',
  session: 'Session',
  context: 'Context',
  generationStopped: 'Generation stopped',
  outputLimitReached: 'Output limit reached',
  taskBlocked: 'Task blocked',
  turnFailed: 'Turn failed',
}

/** Extension-owned slash commands, appended after the runtime's host list. */
export const EXTENSION_COMMANDS: readonly CommandEntry[] = extensionCommands(ENGLISH_WORKBENCH_LABELS)

/** Projects the runtime `commands/list` payload into menu entries plus the local extensions. */
export function projectionCommands(value: unknown, labels = ENGLISH_WORKBENCH_LABELS): readonly CommandEntry[] {
  const hosts: CommandEntry[] = []
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isRecord(item) || typeof item.name !== 'string' || typeof item.description !== 'string'
        || item.description.trim() === '') continue
      const input = isRecord(item.input) && typeof item.input.hint === 'string' && item.input.hint.trim() !== ''
        ? { hint: item.input.hint }
        : undefined
      hosts.push({ name: item.name, description: item.description, ...(input === undefined ? {} : { input }), kind: 'host' })
    }
  }
  hosts.sort((left, right) => left.name < right.name ? -1 : 1)
  return [...hosts, ...extensionCommands(labels)]
}

function extensionCommands(labels: WorkbenchLabels): readonly CommandEntry[] {
  return [
    { name: 'model', description: labels.commandModel, kind: 'extension' },
    { name: 'reasoning', description: labels.commandReasoning, kind: 'extension' },
    { name: 'preset', description: labels.commandPreset, kind: 'extension' },
  ]
}

export interface TokenUsageView {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** Projects the harness `tokenUsage` session projection (0 when absent). */
export function projectionTokenUsage(value: unknown): TokenUsageView | undefined {
  if (!isRecord(value)) return undefined
  const uncachedInputTokens = value.uncachedInputTokens
  const outputTokens = value.outputTokens
  const cacheReadTokens = value.cacheReadTokens
  const cacheWriteTokens = value.cacheWriteTokens
  if (!isTokenCount(uncachedInputTokens) || !isTokenCount(outputTokens)
    || !isTokenCount(cacheReadTokens) || !isTokenCount(cacheWriteTokens)) return undefined
  return { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export interface GoalView {
  readonly id: string
  readonly revision: number
  readonly objective: string
  readonly phase: 'active' | 'paused' | 'blocked' | 'complete'
  readonly maxGoalRounds: number
  readonly roundsStarted: number
  readonly blockedReason?: string
}

export interface HarnessWorkbenchState {
  readonly phase: ConnectionPhase
  readonly error?: string
  readonly hasApiKey: boolean
  readonly sessions: readonly SessionListItem[]
  readonly archivedSessions: readonly SessionListItem[]
  readonly active?: ActiveSessionView
  readonly presets: readonly AgentPresetEntry[]
}

/** Converts a Host summary to the small, stable DTO sent into the webview. */
export function sessionListItem(summary: SessionSummary, labels = ENGLISH_WORKBENCH_LABELS): SessionListItem {
  const title = projectionTitle(summary.projections?.values)
  return {
    id: String(summary.sessionId),
    title: title ?? (summary.blank ? labels.newConversation : fallbackTitle(summary, labels)),
    ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
    updatedAt: summary.updatedAt,
    running: summary.running,
    blank: summary.blank,
    ...(summary.agentPreset === undefined ? {} : { agentPreset: summary.agentPreset }),
  }
}

export function projectionTitle(values: unknown): string | undefined {
  if (!isRecord(values)) return undefined
  const title = values.title
  return typeof title === 'string' && title.trim() !== '' ? title : undefined
}

export function projectionPermissions(value: unknown): PermissionView | undefined {
  if (!isRecord(value) || typeof value.currentValue !== 'string' || !Array.isArray(value.options)) return undefined
  const options = value.options.flatMap((option) => {
    if (!isRecord(option) || typeof option.value !== 'string' || typeof option.name !== 'string') return []
    return [{
      value: option.value,
      name: option.name,
      ...(typeof option.description === 'string' ? { description: option.description } : {}),
    }]
  })
  return { currentValue: value.currentValue, options }
}

export function projectionPlan(value: unknown): { readonly active: boolean; readonly pending: boolean } | undefined {
  if (!isRecord(value) || typeof value.active !== 'boolean' || typeof value.pending !== 'boolean') return undefined
  return { active: value.active, pending: value.pending }
}

export function projectionGoal(value: unknown): GoalView | undefined {
  if (!isRecord(value) || !isRecord(value.goal)) return undefined
  const goal = value.goal
  if (typeof goal.id !== 'string' || typeof goal.revision !== 'number' || typeof goal.objective !== 'string'
    || !isGoalPhase(goal.phase) || typeof goal.maxGoalRounds !== 'number') return undefined
  const blockedReason = isRecord(goal.blockedReason) && typeof goal.blockedReason.message === 'string'
    ? goal.blockedReason.message
    : undefined
  return {
    id: goal.id,
    revision: goal.revision,
    objective: goal.objective,
    phase: goal.phase,
    maxGoalRounds: goal.maxGoalRounds,
    roundsStarted: typeof value.roundsStarted === 'number' ? value.roundsStarted : 0,
    ...(blockedReason === undefined ? {} : { blockedReason }),
  }
}

/**
 * Projects the append-only Harness event log into a native chat transcript.
 * Raw events remain the source of truth; this function is intentionally pure.
 */
export function projectConversation(entries: readonly HistoryEntry[], labels = ENGLISH_WORKBENCH_LABELS): {
  readonly messages: ChatItem[]
  readonly todos: { readonly content: string; readonly status: string }[]
} {
  const messages: ChatItem[] = []
  const messageTurns = new Map<string, number>()
  const addMessage = (message: ChatItem, turn?: number): void => {
    messages.push(message)
    if (turn !== undefined) messageTurns.set(message.id, turn)
  }
  const finalSteps = new Set<string>()
  const blockTimes = new Map<string, Map<number, TurnDurationView>>()
  const stepUsage = new Map<string, { readonly reasoningTokens?: number }>()
  const partials = new Map<string, PartialBlocks>()
  const commandRuns = new Map<string, {
    readonly seq: number
    readonly time: number
    readonly name: string
    readonly args?: string
  }>()
  const commandDones = new Map<string, {
    readonly seq: number
    readonly time: number
    readonly kind: 'success' | 'error'
    readonly text?: string
  }>()
  let todos: { readonly content: string; readonly status: string }[] = []

  for (const { event } of entries) {
    if (event.type === 'assistant/message') {
      finalSteps.add(stepKey(event.data.turn, event.data.step))
      if (event.data.usage !== undefined) stepUsage.set(stepKey(event.data.turn, event.data.step), event.data.usage)
    } else if (event.type === 'assistant/chunk') {
      // Track per-block wall-clock times for every chunk, including chunks of
      // steps later replaced by a finalized assistant message, and capture the
      // streamed usage record (adapter-reported reasoning tokens) per step.
      const chunk = event.data.chunk
      const key = stepKey(event.data.turn, event.data.step)
      if (chunk.type === 'usage') {
        stepUsage.set(key, chunk.usage)
      } else if ('index' in chunk && typeof chunk.index === 'number') {
        const times = blockTimes.get(key) ?? new Map<number, TurnDurationView>()
        blockTimes.set(key, times)
        if (chunk.type === 'block-end') {
          times.set(chunk.index, { startedAt: times.get(chunk.index)?.startedAt ?? event.time, endedAt: event.time })
        } else if (!times.has(chunk.index)) {
          times.set(chunk.index, { startedAt: event.time })
        }
      }
    } else if (event.type === 'command/run') {
      commandRuns.set(String(event.data.commandId), {
        seq: event.seq,
        time: event.time,
        name: event.data.name,
        ...(event.data.args === undefined ? {} : { args: event.data.args }),
      })
    } else if (event.type === 'command/done') {
      commandDones.set(String(event.data.commandId), {
        seq: event.seq,
        time: event.time,
        kind: event.data.kind,
        ...(event.data.text === undefined ? {} : { text: event.data.text }),
      })
    }
  }

  for (const { event } of entries) {
    switch (event.type) {
      case 'user/message': {
        if (isReplacement(event.surfaceOp)) break
        const source = event.data.source
        const human = source.kind === 'user'
        addMessage({
          id: `event-${event.seq}`,
          seq: event.seq,
          time: event.time,
          kind: human ? 'message' : 'context',
          role: 'user',
          ...(!human ? { title: contextTitle(source, labels) } : {}),
          blocks: projectBlocks(event.data.content, labels),
        })
        break
      }
      case 'assistant/chunk': {
        const key = stepKey(event.data.turn, event.data.step)
        if (finalSteps.has(key)) break
        const partial = partials.get(key) ?? new PartialBlocks(event.seq, event.time, labels)
        partial.push(event.data.chunk, event.time)
        partials.set(key, partial)
        break
      }
      case 'assistant/message': {
        if (isReplacement(event.surfaceOp)) break
        const key = stepKey(event.data.turn, event.data.step)
        const times = blockTimes.get(key)
        const usage = stepUsage.get(key)
        const blocks = projectTimedBlocks(event.data.message.content, times, usage, labels)
        if (blocks.length > 0) {
          addMessage({
            id: `event-${event.seq}`,
            seq: event.seq,
            time: event.time,
            kind: 'message',
            role: 'assistant',
            blocks,
          }, event.data.turn)
        }
        break
      }
      case 'tool/call': {
        addMessage({
          id: `tool-${String(event.data.callId)}`,
          seq: event.seq,
          time: event.time,
          kind: 'tool',
          title: event.data.name,
          status: 'running',
          detail: prettyJson(event.data.arguments),
        }, event.data.turn)
        break
      }
      case 'tool/result': {
        // Merge the result into its call card so one tool reads as one row;
        // a standalone card is kept only when the call is absent from this
        // history page (out-of-order tail).
        const callId = String(event.data.message.source.callId)
        const status = event.data.error === undefined ? 'success' : 'error'
        const result = blockText(event.data.message.content, labels)
        const callIndex = messages.findIndex((item) => item.id === `tool-${callId}`)
        const call = messages[callIndex]
        if (call !== undefined) {
          messages[callIndex] = { ...call, status, result }
        } else {
          addMessage({
            id: `tool-${callId}-result`,
            seq: event.seq,
            time: event.time,
            kind: 'tool',
            title: labels.toolResult,
            status,
            detail: result,
          }, event.data.turn)
        }
        break
      }
      case 'command/run': {
        const commandId = String(event.data.commandId)
        const done = commandDones.get(commandId)
        addMessage(commandItem(commandId, {
          seq: event.seq,
          time: event.time,
          name: event.data.name,
          ...(event.data.args === undefined ? {} : { args: event.data.args }),
        }, done, labels))
        break
      }
      case 'command/done': {
        const commandId = String(event.data.commandId)
        if (commandRuns.has(commandId)) break
        addMessage(commandItem(commandId, undefined, {
          seq: event.seq,
          time: event.time,
          kind: event.data.kind,
          ...(event.data.text === undefined ? {} : { text: event.data.text }),
        }, labels))
        break
      }
      case 'todo/write':
        todos = event.data.todos.map((item) => ({ content: item.content, status: item.status }))
        break
      case 'turn/end':
        if (event.data.reason.kind !== 'completed') {
          addMessage({
            id: `turn-${event.data.turn}-end`,
            seq: event.seq,
            time: event.time,
            kind: 'notice',
            title: turnEndTitle(event.data.reason.kind, labels),
            status: event.data.reason.kind === 'error' ? 'error' : 'info',
            ...('error' in event.data.reason ? { detail: event.data.reason.error.message } : {}),
          }, event.data.turn)
        }
        break
      default:
        break
    }
  }

  for (const [key, partial] of partials) {
    addMessage({
      id: `partial-${key}`,
      seq: partial.seq,
      time: partial.time,
      kind: 'message',
      role: 'assistant',
      status: 'running',
      blocks: partial.blocks(),
    }, turnFromStepKey(key))
  }
  messages.sort((left, right) => left.seq - right.seq)
  attachTurnDurations(messages, messageTurns, projectTurnDurations(entries))
  return { messages, todos }
}

/** Attaches one cumulative footer per turn to its last visible item. */
function attachTurnDurations(
  messages: ChatItem[],
  messageTurns: ReadonlyMap<string, number>,
  durations: ReadonlyMap<number, TurnDurationView>,
): void {
  // Attach to the turn's very last item (which may be a tool card) so the
  // cumulative timer sits below the tool calls instead of above them.
  // Falls back to the last assistant message when no last item is recorded.
  const lastAssistantIndex = new Map<number, number>()
  const lastIndex = new Map<number, number>()
  messages.forEach((message, index) => {
    const turn = messageTurns.get(message.id)
    if (turn === undefined) return
    lastIndex.set(turn, index)
    if (message.kind === 'message' && message.role === 'assistant') lastAssistantIndex.set(turn, index)
  })
  for (const [turn, duration] of durations) {
    const index = lastIndex.get(turn) ?? lastAssistantIndex.get(turn)
    const message = index === undefined ? undefined : messages[index]
    if (index !== undefined && message !== undefined && message.workDuration === undefined) {
      messages[index] = { ...message, workDuration: duration }
    }
  }
}

function commandItem(
  commandId: string,
  run: { readonly seq: number; readonly time: number; readonly name: string; readonly args?: string } | undefined,
  done: { readonly seq: number; readonly time: number; readonly kind: 'success' | 'error'; readonly text?: string } | undefined,
  labels: WorkbenchLabels,
): ChatItem {
  const title = run === undefined ? labels.slashCommand : `/${run.name}${run.args ?? ''}`
  return {
    id: `command-${commandId}`,
    seq: run?.seq ?? done?.seq ?? 0,
    time: run?.time ?? done?.time ?? 0,
    kind: 'notice',
    title,
    status: done === undefined ? 'running' : done.kind,
    ...(done?.text === undefined ? {} : { detail: done.text }),
  }
}

class PartialBlocks {
  readonly seq: number
  readonly time: number
  private readonly values = new Map<number, ChatBlock>()
  private readonly times = new Map<number, TurnDurationView>()
  private usage: { readonly reasoningTokens?: number } | undefined

  constructor(seq: number, time: number, private readonly labels: WorkbenchLabels) {
    this.seq = seq
    this.time = time
  }

  push(chunk: Extract<HistoryEntry['event'], { type: 'assistant/chunk' }>['data']['chunk'], time: number): void {
    switch (chunk.type) {
      case 'block-start':
        if (chunk.blockType === 'text' || chunk.blockType === 'reasoning') {
          this.values.set(chunk.index, { kind: chunk.blockType, text: '', streaming: true })
          this.times.set(chunk.index, { startedAt: time })
        }
        break
      case 'text-delta':
        this.append(chunk.index, 'text', chunk.text)
        this.markStarted(chunk.index, time)
        break
      case 'reasoning-delta':
        this.append(chunk.index, 'reasoning', chunk.text)
        this.markStarted(chunk.index, time)
        break
      case 'usage':
        this.usage = chunk.usage
        break
      case 'block-end': {
        const blocks = projectBlocks([chunk.block], this.labels)
        const block = blocks[0]
        if (block !== undefined) this.values.set(chunk.index, block)
        this.times.set(chunk.index, { startedAt: this.times.get(chunk.index)?.startedAt ?? time, endedAt: time })
        break
      }
      default:
        break
    }
  }

  blocks(): ChatBlock[] {
    const entries = [...this.values.entries()].sort(([a], [b]) => a - b)
    // The step's adapter-reported reasoning tokens cover the whole step, so
    // attach them to the final reasoning block where the count is complete.
    let lastReasoningIndex = -1
    for (const [index, value] of entries) {
      if (value.kind === 'reasoning') lastReasoningIndex = index
    }
    return entries.map(([index, value]) => {
      const time = value.kind === 'reasoning' ? this.times.get(index) : undefined
      const tokens = value.kind === 'reasoning' && index === lastReasoningIndex
        ? this.usage?.reasoningTokens
        : undefined
      if (time === undefined && tokens === undefined) return value
      return {
        ...value,
        ...(time === undefined ? {} : { duration: time }),
        ...(tokens === undefined ? {} : { reasoningTokens: tokens }),
      }
    })
  }

  private markStarted(index: number, time: number): void {
    if (!this.times.has(index)) this.times.set(index, { startedAt: time })
  }

  private append(index: number, kind: 'text' | 'reasoning', text: string): void {
    const previous = this.values.get(index)
    this.values.set(index, { kind, text: (previous?.kind === kind ? previous.text : '') + text, streaming: true })
  }
}

/** Like projectBlocks, attaching chunk timing and usage to reasoning blocks by content index. */
function projectTimedBlocks(
  content: readonly unknown[],
  times: ReadonlyMap<number, TurnDurationView> | undefined,
  usage: { readonly reasoningTokens?: number } | undefined,
  labels: WorkbenchLabels,
): ChatBlock[] {
  const result: ChatBlock[] = []
  content.forEach((value, index) => {
    const block = projectBlocks([value], labels)[0]
    if (block === undefined) return
    const time = block.kind === 'reasoning' ? times?.get(index) : undefined
    const tokens = block.kind === 'reasoning' ? usage?.reasoningTokens : undefined
    if (time === undefined && tokens === undefined) {
      result.push(block)
      return
    }
    result.push({
      ...block,
      ...(time === undefined ? {} : { duration: time }),
      ...(tokens === undefined ? {} : { reasoningTokens: tokens }),
    })
  })
  return result
}

function projectBlocks(blocks: readonly unknown[], labels: WorkbenchLabels): ChatBlock[] {
  const result: ChatBlock[] = []
  for (const value of blocks) {
    if (!isRecord(value) || typeof value.type !== 'string') continue
    if ((value.type === 'text' || value.type === 'reasoning') && typeof value.text === 'string') {
      result.push({ kind: value.type, text: value.text })
    } else if (value.type === 'image') {
      result.push({ kind: 'image', text: labels.imageAttachment })
    }
  }
  return result
}

function blockText(blocks: readonly unknown[], labels: WorkbenchLabels): string {
  const output: string[] = []
  const visit = (values: readonly unknown[]): void => {
    for (const value of values) {
      if (!isRecord(value)) continue
      if (typeof value.text === 'string') output.push(value.text)
      if (Array.isArray(value.content)) visit(value.content)
    }
  }
  visit(blocks)
  return output.join('\n').trim() || labels.completed
}

function fallbackTitle(summary: SessionSummary, labels: WorkbenchLabels): string {
  const folder = summary.cwd?.split(/[\\/]/u).filter(Boolean).at(-1)
  return folder === undefined ? `${labels.session} ${String(summary.sessionId).slice(0, 8)}` : folder
}

function contextTitle(source: { readonly kind: string }, labels: WorkbenchLabels): string {
  return source.kind === 'plugin' ? labels.context : source.kind
}

function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

function turnFromStepKey(key: string): number {
  return Number(key.slice(0, key.indexOf(':')))
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), undefined, 2)
  } catch {
    return value
  }
}

function turnEndTitle(kind: string, labels: WorkbenchLabels): string {
  if (kind === 'aborted') return labels.generationStopped
  if (kind === 'max-tokens') return labels.outputLimitReached
  if (kind === 'blocked') return labels.taskBlocked
  return labels.turnFailed
}

function isReplacement(value: unknown): boolean {
  return isRecord(value) && value.op === 'replace'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isGoalPhase(value: unknown): value is GoalView['phase'] {
  return value === 'active' || value === 'paused' || value === 'blocked' || value === 'complete'
}
