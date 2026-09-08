import type { ActiveSessionView, ChatItem } from '../../domain/workbench-state.js'
import { splitCarriedBlocks } from '../../domain/carry-over.js'
import { projectProcessingStatus } from '../../domain/processing-status.js'
import { projectReasoningTimeline } from '../../domain/reasoning-timeline.js'
import { projectTurnProcesses } from '../../domain/turn-process.js'
import { visibleTranscript } from '../../domain/transcript-context.js'
import { createContextNotice } from '../runtime-context/notice.js'
import { renderMarkdown, resetReferenceValidation } from '../markdown.js'
import { createSessionChangesCard } from '../session-changes/component.js'
import { ProcessingIndicator } from '../processing-indicator/component.js'
import { retryStatusText, activityPhrases } from '../processing-indicator/labels.js'
import { ReasoningTimeline } from '../reasoning-timeline/component.js'
import { TurnProcessComponent } from '../turn-process/component.js'
import { createToolCardHeader } from '../tool-card/header.js'
import {
  components,
  elements,
  node,
  optimisticBubbles,
  payload,
  post,
  renderedSessionId,
  setOptimisticBubbles,
  setRenderedSessionId,
  t,
} from './context.js'
import type { IconName } from '../icons.js'
import { markdownActions } from './markdown-actions.js'
import { MessageReconciler } from './message-reconciler.js'
import { conversationScroll } from './scroll.js'
import { TurnChangesController } from './turn-changes-controller.js'
import { appendTodoRows, todoListSignature, todoProgress, type TodoEntry } from './todo-list.js'
import type { OptimisticBubble } from './types.js'
import {
  captureDisclosures,
  copyText,
  cssEscape,
  estimateReasoningTokens,
  formatTokenCount,
  patchStreamingMessage,
  restoreDisclosures,
} from './utils.js'

const messageReconciler = new MessageReconciler()
const turnProcess = new TurnProcessComponent(document, t)
const processingIndicator = new ProcessingIndicator({
  document, accessibleLabel: t('processing'), phrases: activityPhrases(t),
  retryLabel: (retry) => retryStatusText(retry, t),
})
const reasoningTimeline = new ReasoningTimeline(document)
const turnChangesController = new TurnChangesController(() => createSessionChangesCard({
  document,
  translate: t,
  onOpenFile: (path) => post('openFile', { path }),
  onReview: () => post('sessionChangesReview'),
  onUndo: () => post('sessionChangesUndo'),
}))

export function renderMessages(active: ActiveSessionView | undefined): void {
  conversationScroll.beforeLayout()
  const realMessages = visibleTranscript(active?.messages || [])
  const sessionId = active?.id || ''
  const sessionChanged = sessionId !== renderedSessionId
  if (sessionChanged) {
    // A new transcript means a new existence ledger: verified references from
    // the previous session must be re-checked before becoming clickable again.
    resetReferenceValidation()
  }
  if (sessionChanged && optimisticBubbles.length > 0) setOptimisticBubbles([])
  reconcileOptimistic(realMessages)
  const running = active?.running ?? false
  const rawMessages = [...realMessages, ...optimisticBubbles]
  const processing = projectProcessingStatus(active, rawMessages, payload?.state.phase, optimisticBubbles.length > 0)
  const presentation = projectTurnProcesses(rawMessages, running)
  const messages = settleRunningDurations(presentation.messages, running)
  const conclusionId = latestConclusionId(messages)
  messageReconciler.reconcile(elements.messages, sessionId, messages, {
    groups: turnProcess.prepare(sessionId, presentation.groups),
    tail: processingIndicator.element,
    create: (item) => renderMessage(item),
    patch: patchStreamingMessage,
    replace: (element, item) => {
      const replacement = renderMessage(item)
      restoreDisclosures(replacement, captureDisclosures(element))
      return replacement
    },
    release: (element) => components.streamingMessage.dispose(element),
  })
  // The copy button only survives on the finished conclusion; remove any that
  // are stale (streaming moved on, turn restarted, or a new conclusion
  // replaced the old one).
  for (const footer of Array.from(elements.messages.querySelectorAll<HTMLElement>('.message-copy-footer'))) {
    const article = footer.closest('article')
    if (running || article?.dataset.messageId !== conclusionId) footer.remove()
  }
  // Finalizing now patches the original streaming node instead of remounting
  // it, so add the conclusion action independently of initial rendering.
  const conclusion = !running ? messages.find((item) => item.id === conclusionId) : undefined
  if (conclusion !== undefined) {
    const article = elements.messages.querySelector<HTMLElement>(`[data-message-id="${cssEscape(conclusion.id)}"]`)
    if (article !== null && article.querySelector('.message-copy-footer') === null) article.append(createCopyFooter(conclusion))
  }
  // Keep worked-time footers only under DeepSeek bubbles; remove any that
  // leaked onto user bubbles.
  for (const footer of Array.from(elements.messages.querySelectorAll<HTMLElement>('article.message:not(.assistant) .work-duration'))) {
    footer.remove()
  }
  // Live todo cards: `todo/write` events change only the session's projected
  // todos, never the tool item's own signature, so the reconciliation loop
  // above would otherwise leave them stale. Refresh every card whose bound
  // checklist diverged from the current session state.
  refreshTodoCards(active?.todos ?? [])
  elements.empty.classList.toggle('hidden', messages.length > 0 || processing.kind !== 'hidden')
  // Per-turn edited-file cards sit below their conclusion; reconcile them
  // BEFORE the scroll logic so the bottom-pin measurement includes card
  // heights (otherwise the first card pushes the transcript past the view).
  turnChangesController.reconcile(elements.messages, sessionId, active?.turnChanges)
  // One silent-handoff tail, never a history item or a fixed overlay. Update
  // before measuring so auto-follow includes it and manual scroll stays put.
  processingIndicator.update(elements.messages, sessionId, processing)
  reasoningTimeline.update(elements.messages, sessionId, projectReasoningTimeline(messages, running))
  // New sessions follow even if their transcript arrives after an empty state.
  // Later renders preserve the reader's text anchor, including history prepends.
  if (sessionChanged) conversationScroll.toBottom()
  else conversationScroll.afterLayout()
  setRenderedSessionId(sessionId)
}


export function messageText(item: ChatItem): string {
  return (item.blocks || [])
    .filter((block) => block.kind === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function messageImageCount(item: ChatItem): number {
  return (item.blocks || []).filter((block) => block.kind === 'image').length
}

/**
 * When the session is not running, any turn that never emitted a `turn/end`
 * event (cancelled, interrupted, or an event that was dropped) would otherwise
 * keep its worked-time footer ticking forever. Freeze those durations at the
 * current time so the transcript settles once the agent is idle.
 */
function settleRunningDurations(messages: readonly ChatItem[], running: boolean): readonly ChatItem[] {
  if (running) return messages
  let changed = false
  const settled = messages.map((item): ChatItem => {
    if (item.workDuration === undefined || item.workDuration.endedAt !== undefined) return item
    changed = true
    return { ...item, workDuration: { ...item.workDuration, endedAt: Date.now() } }
  })
  return changed ? settled : messages
}

/** Drops optimistic bubbles whose real user/message has now surfaced (FIFO by content).
 *
 * A mode-switch carry-over payload rides inside the real message as a leading
 * hidden block, so reconciliation compares against the visible remainder only.
 */
function reconcileOptimistic(realMessages: readonly ChatItem[]): void {
  if (optimisticBubbles.length === 0) return
  const matched = new Set<string>()
  const pending: OptimisticBubble[] = []
  for (const bubble of optimisticBubbles) {
    const index = realMessages.findIndex((message) =>
      !matched.has(message.id)
      && message.kind === 'message'
      && message.role === 'user'
      && visibleUserText(message) === bubble.text
      && messageImageCount(message) === bubble.imageCount
    )
    const found = index === -1 ? undefined : realMessages[index]
    if (found === undefined) pending.push(bubble)
    else matched.add(found.id)
  }
  setOptimisticBubbles(pending)
}

/** User-typed text of one chat item with any carried-over lead block stripped. */
function visibleUserText(item: ChatItem): string {
  const blocks = item.kind === 'message' && item.role === 'user' ? splitCarriedBlocks(item.blocks ?? []).rest : item.blocks ?? []
  return blocks.filter((block) => block.kind === 'text').map((block) => block.text).join('\n').trim()
}

function latestConclusionId(messages: readonly ChatItem[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index]
    if (item?.kind === 'message' && item.role === 'assistant' && messageText(item) !== '') return item.id
  }
  return undefined
}

function createCopyFooter(item: ChatItem): HTMLButtonElement {
  const button = node('button', 'message-copy-footer') as HTMLButtonElement
  button.type = 'button'
  button.title = t('copyConclusion')
  button.setAttribute('aria-label', t('copyConclusion'))
  const icon = node('span', 'copy-icon', '⧉')
  const label = node('span', 'copy-label', t('copy'))
  button.append(icon, label)
  button.addEventListener('click', () => {
    copyText(messageText(item))
    button.classList.add('copied')
    icon.textContent = '✓'
    label.textContent = t('copied')
    setTimeout(() => {
      button.classList.remove('copied')
      icon.textContent = '⧉'
      label.textContent = t('copy')
    }, 2_000)
  })
  return button
}

function renderMessage(item: ChatItem): HTMLElement {
  if (item.kind === 'tool') return renderTool(item)
  if (item.kind === 'context') return renderContext(item)
  if (item.kind === 'notice') {
    if (item.contextNotice !== undefined) return createContextNotice(document, item.contextNotice, t)
    const notice = node('div', `notice ${item.status || ''}`)
    notice.append(node('strong', '', item.title || t('status')))
    if (item.detail) notice.append(node('span', '', item.detail))
    components.workDuration.update(notice, item.status === 'running' ? undefined : item.workDuration)
    return notice
  }
  const article = node('article', `message ${item.role || ''}`)
  const label = node('div', 'message-label', item.role === 'user' ? t('you') : 'DeepSeek')
  article.append(label)
  // A mode-switch carry-over payload rides as leading hidden text blocks:
  // collapse them into one context card so the previous conversation stays
  // out of sight but remains inspectable.
  const carried = item.role === 'user' ? splitCarriedBlocks(item.blocks ?? []) : undefined
  if (carried !== undefined && carried.carriedText !== '') {
    article.append(renderCarriedContextCard(carried.carriedText, String(item.id)))
  }
  const body = node('div', 'message-body')
  components.streamingMessage.render(body, carried === undefined ? item : { ...item, blocks: carried.rest })
  article.append(body)
  // Every DeepSeek bubble carries its worked-time footer (it ticks while the
  // turn runs and freezes when done). The copy button belongs only to the
  // finished turn's final conclusion.
  if (item.role === 'assistant') components.workDuration.update(article, item.workDuration)
  return article
}

function renderTool(item: ChatItem): HTMLElement {
  if (isTodoTool(item.title)) return renderTodoCard(item)
  const container = node('div', 'tool-item')
  const details = node('details', `tool-card ${item.status || ''}`) as HTMLDetailsElement
  details.dataset.disclosureKey = 'tool'
  details.append(createToolCardHeader(document, {
    title: toolDisplayName(item.title || t('tool')),
    glyph: toolIcon(item.title),
    status: item.status,
    ...(item.detail?.trim() ? { preview: toolPreviewText(item.detail) } : {}),
  }))
  if (item.detail && item.detail.trim() !== '') {
    details.append(toolSectionLabel(t('toolArguments'), estimateReasoningTokens(item.detail)))
    const detail = node('div', 'tool-detail')
    renderToolDetail(detail, item.detail, item.title)
    details.append(detail)
  }
  if (item.result && item.result.trim() !== '') {
    details.append(toolSectionLabel(t('toolResult'), estimateReasoningTokens(item.result)))
    const result = node('div', 'tool-detail')
    renderToolDetail(result, item.result, item.title)
    details.append(result)
  }
  container.append(details)
  // A turn's cumulative worked-time footer lands on the last visible item,
  // which is often a tool card; show it below the card so it never sits above
  // the tool call.
  if (item.workDuration !== undefined) components.workDuration.update(container, item.workDuration)
  return container
}

/** Section heading for a tool card, with a muted estimated token count. */
function toolSectionLabel(label: string, tokens: number | undefined): HTMLElement {
  const el = node('div', 'tool-section-label')
  el.append(document.createTextNode(label))
  if (tokens !== undefined) {
    el.append(node('span', 'tool-tokens', t('toolTokens', { tokens: formatTokenCount(tokens) })))
  }
  return el
}

const TODO_TOOL_NAMES = new Set(['todo_write', 'todo', 'task'])

function isTodoTool(name: string | undefined): boolean {
  return TODO_TOOL_NAMES.has(String(name || '').trim().toLowerCase())
}

/**
 * Renders a `todo_write` call as a live checklist card instead of a generic
 * tool card: an expanded ○/●/✓ list with a `x/y` progress readout. The card is
 * bound to the session's projected todos, so every later `todo/write` event
 * refreshes it in place (see {@link refreshTodoCards}).
 */
function renderTodoCard(item: ChatItem): HTMLElement {
  const container = node('div', 'tool-item')
  const details = node('details', 'tool-card todo-card') as HTMLDetailsElement
  details.dataset.disclosureKey = `todo-${String(item.id)}`
  details.dataset.autoOpen = 'true'
  details.open = true
  const summary = node('summary')
  const chevron = node('span', 'todo-chevron', '⌄')
  summary.append(chevron, node('span', 'tool-title', t('taskList')))
  const progress = node('span', 'todo-progress')
  summary.append(progress)
  details.append(summary)
  const body = node('div', 'todo-list')
  const todos = liveTodos(item)
  body.dataset.todoSignature = todoListSignature(todos)
  appendTodoRows(body, todos)
  details.append(body)
  // A failed write still surfaces its error under the checklist.
  if (item.status === 'error' && item.result && item.result.trim() !== '') {
    details.append(node('div', 'tool-detail todo-error', item.result))
  }
  container.append(details)
  updateTodoProgress(details, todos)
  if (item.workDuration !== undefined) components.workDuration.update(container, item.workDuration)
  return container
}

/** The session's current todos, falling back to the card's own call payload. */
function liveTodos(item: ChatItem): readonly TodoEntry[] {
  const current = payload?.state.active?.todos
  if (current !== undefined && current.length > 0) return current
  return todosFromDetail(item.detail)
}

function todosFromDetail(detail: string | undefined): TodoEntry[] {
  const trimmed = String(detail || '').trim()
  if (!isJsonText(trimmed)) return []
  try {
    const parsed = JSON.parse(trimmed) as { todos?: unknown }
    if (!Array.isArray(parsed.todos)) return []
    return parsed.todos
      .filter((entry): entry is TodoEntry => typeof entry === 'object' && entry !== null
        && typeof (entry as TodoEntry).content === 'string'
        && typeof (entry as TodoEntry).status === 'string')
  } catch {
    return []
  }
}

function updateTodoProgress(details: HTMLDetailsElement, todos: readonly TodoEntry[]): void {
  const progress = details.querySelector<HTMLElement>('.todo-progress')
  if (progress === null) return
  const { done, total } = todoProgress(todos)
  progress.textContent = `${done}/${total}`
  progress.classList.toggle('complete', total > 0 && done === total)
}

/**
 * Refreshes every live todo card in the stream whose bound checklist diverged
 * from the session's projected todos (a `todo/write` event landed). Called on
 * every state render so progress and rows track the agent's plan in real time.
 */
function refreshTodoCards(todos: readonly TodoEntry[]): void {
  const signature = todoListSignature(todos)
  for (const details of Array.from(elements.messages.querySelectorAll<HTMLDetailsElement>('.todo-card'))) {
    const body = details.querySelector<HTMLElement>('.todo-list')
    if (body === null) continue
    if (body.dataset.todoSignature === signature) continue
    body.dataset.todoSignature = signature
    body.replaceChildren()
    appendTodoRows(body, todos)
    updateTodoProgress(details, todos)
  }
}

function toolDisplayName(name: string | undefined): string {
  if (name === '') return name ?? ''
  return (name ?? '').charAt(0).toUpperCase() + (name ?? '').slice(1)
}

const TOOL_ICONS = new Map<string, IconName>([
  // Shell / command execution.
  ['bash', 'terminal'], ['shell', 'terminal'], ['terminal', 'terminal'], ['sh', 'terminal'], ['zsh', 'terminal'],
  ['powershell', 'terminal'], ['pwsh', 'terminal'], ['cmd', 'terminal'], ['bat', 'terminal'],
  ['exec', 'terminal'], ['exec_command', 'terminal'], ['run_command', 'terminal'],
  ['run', 'terminal'], ['command', 'terminal'], ['script', 'terminal'],
  // File editing.
  ['edit', 'edit'], ['str_replace_editor', 'edit'], ['str_replace', 'edit'], ['apply_patch', 'edit'],
  ['edit_file', 'edit'], ['replace', 'edit'], ['rewrite', 'edit'], ['write', 'edit'], ['create', 'edit'],
  ['create_file', 'edit'], ['append', 'edit'], ['append_file', 'edit'],
  // File reading / browsing.
  ['read', 'doc'], ['read_file', 'doc'], ['view', 'doc'], ['view_file', 'doc'], ['cat', 'doc'],
  ['ls', 'doc'], ['list', 'doc'], ['inspect', 'doc'], ['stat', 'doc'],
  // Search.
  ['glob', 'search'], ['grep', 'search'], ['search', 'search'], ['find', 'search'], ['rg', 'search'],
  ['ripgrep', 'search'], ['find_files', 'search'], ['search_files', 'search'],
  // Web / network.
  ['web_search', 'web'], ['web', 'web'], ['web_fetch', 'web'], ['fetch', 'web'], ['http', 'web'],
  ['url', 'web'], ['browser', 'web'], ['request', 'web'],
  // Workflow orchestration.
  ['workflow', 'workflow'], ['pipeline', 'workflow'], ['orchestrator', 'workflow'], ['parallel', 'workflow'],
  // Sub-agents.
  ['subagent', 'subagent'], ['subagent_fork', 'subagent'], ['agent', 'subagent'], ['spawn', 'subagent'], ['ralph', 'subagent'],
  // Goals.
  ['create_goal', 'pin'], ['update_goal', 'pin'], ['get_goal', 'pin'], ['goal', 'pin'],
  // Questions / confirmations.
  ['ask_user_question', 'question'], ['ask', 'question'], ['ask_user', 'question'], ['confirm', 'question'], ['prompt', 'question'],
  // Task lists.
  ['todo_write', 'checkSquare'], ['todo', 'checkSquare'], ['task', 'checkSquare'],
  // Interrupt / cancel.
  ['interrupt_agent', 'cancel'], ['cancel', 'cancel'], ['kill', 'cancel'], ['stop', 'cancel'], ['job_kill', 'cancel'],
  // Job control.
  ['job_list', 'tool'], ['job_output', 'tool'], ['job', 'tool'],
  // Vision / images.
  ['read_image', 'image'], ['vision_describe', 'image'], ['vision_ocr', 'image'], ['screenshot', 'image'],
  ['image', 'image'], ['ocr', 'image'],
  // Skills.
  ['skill', 'skillDoc'], ['skills', 'skillDoc'],
])

/** Best-effort SVG icon per tool name; dev_* helpers and unknown tools get a generic tool. */
function toolIcon(name: string | undefined): IconName {
  const normalized = String(name || '').trim().toLowerCase()
  if (normalized.startsWith('dev_')) return 'tool'
  return TOOL_ICONS.get(normalized) ?? 'tool'
}

function toolPreviewText(detail: string, toolName?: string): string {
  const trimmed = detail.trim()
  const named = toolName === undefined ? undefined : String(toolName).toLowerCase()
  if (isJsonText(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      // Bash-style calls preview the command line, edits the file path.
      if (isShellTool(named)) {
        const command = stringField(parsed, 'command', 'cmd', 'code', 'script')
        if (command !== undefined) return summarizeLine(command)
      }
      if (typeof parsed.description === 'string' && parsed.description.trim() !== '') {
        return summarizeLine(parsed.description)
      }
      const file = parsed.file_path ?? parsed.path ?? parsed.file
      if (typeof file === 'string' && file.trim() !== '') {
        return summarizeLine(file)
      }
      if (typeof parsed.command === 'string' && parsed.command.trim() !== '') {
        return summarizeLine(parsed.command)
      }
    } catch {
      // Fall through to raw text preview.
    }
  }
  return summarizeLine(detail)
}

function isShellTool(named: string | undefined): boolean {
  return named !== undefined && (named === 'bash' || named === 'shell' || named === 'exec'
    || named === 'exec_command' || named === 'run_command' || named === 'run'
    || named === 'command' || named === 'powershell' || named === 'pwsh' || named === 'terminal'
    || named === 'sh' || named === 'zsh' || named === 'cmd' || named === 'bat' || named === 'script')
}

function summarizeLine(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > 90 ? `${single.slice(0, 90)}…` : single
}

function renderToolDetail(target: HTMLElement, detail: string, toolName?: string): void {
  const trimmed = detail.trim()
  let source: string | undefined
  // Known argument shapes render as human-readable payloads, not raw JSON:
  // edit calls become a unified diff of old→new, file writes show the path
  // and content, and shell calls show the command line.
  const named = toolName === undefined ? undefined : String(toolName).toLowerCase()
  if (isJsonText(trimmed)) {
    let args: unknown
    try {
      args = JSON.parse(trimmed)
    } catch {
      args = undefined
    }
    if (args !== undefined) {
      const rendered = renderToolArguments(named, args)
      if (rendered !== undefined) {
        // renderToolArguments either emits a DOM-friendly fragment or plain
        // markdown; the diff variant is built as real elements so +/− lines
        // can carry diff colors without clashing with the HTML sanitizer.
        if (rendered instanceof DocumentFragment) {
          target.classList.add('tool-diff-view')
          target.append(rendered)
          return
        }
        target.classList.add('markdown-body')
        renderMarkdown(target, rendered, markdownActions)
        return
      }
      // Fall back to pretty JSON for unknown shapes.
      source = `\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\``
    }
  } else if (looksLikeDiff(trimmed)) {
    source = `\`\`\`diff\n${detail}\n\`\`\``
  } else if (looksLikeCode(trimmed) || trimmed.includes('\n')) {
    // Multi-line tool results (bash output, file contents, patch text) are
    // payloads, not prose: always render them as a code block.
    source = `\`\`\`\n${detail}\n\`\`\``
  }
  if (source === undefined) {
    target.textContent = detail
    return
  }
  target.classList.add('markdown-body')
  renderMarkdown(target, source, markdownActions)
}

/**
 * Renders known tool-argument shapes into a readable representation instead of
 * raw JSON. Edit calls return a DOM fragment of colored diff lines; other
 * recognized shapes return markdown source. Returns undefined when the shape
 * is not recognized so the caller can fall back to pretty JSON.
 */
function renderToolArguments(named: string | undefined, args: unknown): DocumentFragment | string | undefined {
  if (!isRecord(args)) return undefined
  // Edit-family tools: a unified diff of the old → new strings is far more
  // readable than the argument JSON, and matches the edited-files card.
  if (named !== undefined && (named === 'edit' || named === 'str_replace' || named === 'str_replace_editor' || named === 'apply_patch')) {
    const path = stringField(args, 'file_path', 'path', 'file')
    const oldText = stringField(args, 'old_string', 'old_str')
    const newText = stringField(args, 'new_string', 'new_str')
    if (oldText !== undefined && newText !== undefined) {
      return diffFragment(path, oldText, newText)
    }
    const content = stringField(args, 'file_text', 'content')
    if (path !== undefined && content !== undefined) {
      return `**${path}**\n\n\`\`\`\n${content}\n\`\`\``
    }
  }
  // Shell-family tools: show the command line.
  if (isShellTool(named)) {
    const command = stringField(args, 'command', 'cmd', 'code', 'script')
    if (command !== undefined) {
      return `\`\`\`bash\n${command}\n\`\`\``
    }
  }
  // Read-family: show the path and any start/end pointers.
  if (named !== undefined && (named === 'read' || named === 'read_file' || named === 'cat' || named === 'view' || named === 'view_file' || named === 'ls' || named === 'glob')) {
    const path = stringField(args, 'file_path', 'path', 'file', 'pattern', 'directory', 'cwd')
    if (path !== undefined) {
      return `**${path}**`
    }
  }
  // Search-family: query and path.
  if (named !== undefined && (named === 'grep' || named === 'search' || named === 'find' || named === 'rg' || named === 'search_files')) {
    const query = stringField(args, 'pattern', 'query', 'term', 'command')
    const path = stringField(args, 'path', 'cwd', 'directory')
    if (query !== undefined) {
      const header = path === undefined ? '' : ` **in** ${path}`
      return `\`\`\`bash\n${query}${header}\n\`\`\``
    }
  }
  return undefined
}

/** A diff-shaped DOM fragment: path header plus colored +/- lines. */
function diffFragment(path: string | undefined, oldText: string, newText: string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  if (path !== undefined) {
    const header = document.createElement('strong')
    header.className = 'tool-diff-path'
    header.textContent = path
    fragment.append(header)
  }
  const pre = document.createElement('pre')
  pre.className = 'tool-diff'
  const code = document.createElement('code')
  const oldLines = oldText === '' ? [] : oldText.split('\n')
  const newLines = newText === '' ? [] : newText.split('\n')
  for (const line of oldLines) {
    const span = document.createElement('span')
    span.className = 'diff-del'
    span.textContent = `− ${line}`
    code.append(span, '\n')
  }
  for (const line of newLines) {
    const span = document.createElement('span')
    span.className = 'diff-add'
    span.textContent = `+ ${line}`
    code.append(span, '\n')
  }
  pre.append(code)
  fragment.append(pre)
  return fragment
}

function stringField(args: Record<string, unknown>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isJsonText(text: string): boolean {
  return (text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))
}

function looksLikeDiff(text: string): boolean {
  return /^(?:diff --git |--- |\+\+\+ |@@ )/m.test(text)
}

function looksLikeCode(text: string): boolean {
  return /(?:^|\n)\s*(?:function|const|let|var|def|class|import|from|export|return|if|for|while|public|private|async|await)\b/m.test(text)
}

function renderContext(item: ChatItem): HTMLElement {
  const details = node('details', 'context-card') as HTMLDetailsElement
  details.dataset.disclosureKey = 'context'
  details.append(node('summary', '', item.title || t('context')))
  const text = (item.blocks || []).map((block) => block.text).join('\n')
  details.append(node('pre', '', text))
  return details
}

/** Collapsed transcript card holding the previous conversation's digest. */
function renderCarriedContextCard(text: string, messageId: string): HTMLElement {
  const details = node('details', `context-card carried-context`) as HTMLDetailsElement
  details.dataset.disclosureKey = `carry-${messageId}`
  details.append(node('summary', '', t('carriedContext')))
  const body = node('div', 'carried-context-body markdown-body')
  renderMarkdown(body, text, markdownActions)
  details.append(body)
  return details
}
