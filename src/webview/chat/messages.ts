import type { ActiveSessionView, ChatItem } from '../../domain/workbench-state.js'
import { splitCarriedBlocks } from '../../domain/carry-over.js'
import { renderMarkdown, resetReferenceValidation } from '../markdown.js'
import {
  components,
  elements,
  followStream,
  interactionArmed,
  messageSignatures,
  node,
  optimisticBubbles,
  payload,
  renderedSessionId,
  setOptimisticBubbles,
  setRenderedSessionId,
  setStickToBottomOnLoad,
  stickToBottomOnLoad,
  t,
} from './context.js'
import { markdownActions } from './markdown-actions.js'
import { appendTodoRows, todoListSignature, todoProgress, type TodoEntry } from './todo-list.js'
import type { OptimisticBubble } from './types.js'
import {
  captureDisclosures,
  copyText,
  estimateReasoningTokens,
  formatTokenCount,
  isNearBottom,
  messageSignature,
  patchStreamingMessage,
  restoreDisclosures,
  scrollConversationToBottom,
  setMessageMetadata,
} from './utils.js'

export function cancelStickToBottom(): void {
  if (stickToBottomOnLoad) setStickToBottomOnLoad(false)
}

/**
 * Instant scroll write: position restoration must not animate, otherwise the
 * `scroll-behavior: smooth` container turns every state push into a glide
 * that fights the reader's scrollbar.
 */
function setConversationScroll(top: number): void {
  const conversation = elements.conversation
  const previous = conversation.style.scrollBehavior
  conversation.style.scrollBehavior = 'auto'
  conversation.scrollTop = top
  conversation.style.scrollBehavior = previous
}

export function renderMessages(active: ActiveSessionView | undefined): void {
  const realMessages = active?.messages || []
  const sessionId = active?.id || ''
  const sessionChanged = sessionId !== renderedSessionId
  if (sessionChanged) {
    setStickToBottomOnLoad(true)
    // A new transcript means a new existence ledger: verified references from
    // the previous session must be re-checked before becoming clickable again.
    resetReferenceValidation()
  }
  if (sessionChanged && optimisticBubbles.length > 0) setOptimisticBubbles([])
  reconcileOptimistic(realMessages)
  const messages = [...realMessages, ...optimisticBubbles]
  // Keep forcing the view to the bottom while a newly opened session is still
  // loading: selectSession first pushes an empty state (which would otherwise
  // scroll to the top), then the transcript arrives in a later state push.
  // The isNearBottom probe runs against the *pre-render* geometry: file
  // references (clickable links) and images inside a user message can grow the
  // transcript asynchronously after render, so a pre-render probe here would
  // otherwise misclassify "user is reading an older message" as "at bottom"
  // and yank the view down to the newest bubble.
  const wasNearBottom = isNearBottom(elements.conversation)
  const shouldStick = stickToBottomOnLoad || sessionChanged || (followStream && wasNearBottom)
  const previousTop = elements.conversation.scrollTop
  const previousHeight = elements.conversation.scrollHeight
  const previousFirstId = (elements.messages.firstElementChild as HTMLElement | null)?.dataset.messageId
  const conclusionId = latestConclusionId(messages)
  const running = active?.running ?? false
  // The step timeline spine only exists while a conversation is in flight;
  // once the turn ends the rail disappears from the finished transcript.
  elements.messages.classList.toggle('timeline-live', running)
  const existing = new Map(Array.from(elements.messages.children).map((child) => [(child as HTMLElement).dataset.messageId ?? '', child as HTMLElement]))
  const retained = new Set<string>()
  let cursor = elements.messages.firstElementChild

  for (const item of messages) {
    const id = String(item.id)
    const signature = messageSignature(item)
    let element = existing.get(id)
    if (!element) {
      element = renderMessage(item, conclusionId, running)
      setMessageMetadata(element, id, signature)
    } else if (messageSignatures.get(element) !== signature) {
      if (patchStreamingMessage(element, item)) {
        messageSignatures.set(element, signature)
      } else {
        const wasCursor = element === cursor
        const disclosureState = captureDisclosures(element)
        const replacement = renderMessage(item, conclusionId, running)
        restoreDisclosures(replacement, disclosureState)
        setMessageMetadata(replacement, id, signature)
        element.replaceWith(replacement)
        element = replacement
        if (wasCursor) cursor = replacement
      }
    }
    retained.add(id)
    if (element !== cursor) elements.messages.insertBefore(element, cursor)
    cursor = element.nextElementSibling
  }

  for (const [id, element] of existing) {
    if (!retained.has(id)) element.remove()
  }
  // The copy button only survives on the finished conclusion; remove any that
  // are stale (streaming moved on, turn restarted, or a new conclusion
  // replaced the old one).
  for (const footer of Array.from(elements.messages.querySelectorAll<HTMLElement>('.message-copy-footer'))) {
    const article = footer.closest('article')
    if (running || article?.dataset.messageId !== conclusionId) footer.remove()
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
  elements.empty.classList.toggle('hidden', messages.length > 0)
  const prepended = !sessionChanged && previousFirstId !== undefined
    && messages.findIndex((item) => String(item.id) === previousFirstId) > 0
  const pinnedInteraction = shouldStick && !interactionArmed
  if (pinnedInteraction) {
    scrollConversationToBottom()
  } else if (prepended) {
    // Anchor the pre-render position so history prepends don't shift the view.
    setConversationScroll(previousTop + elements.conversation.scrollHeight - previousHeight)
  } else if (!stickToBottomOnLoad) {
    // Streaming below the viewport must not steal the reader's position, but
    // a freshly opened session must keep pinning to the bottom until its
    // load-scroll has actually landed.
    setConversationScroll(previousTop)
  }
  // Keep forcing the bottom until the freshly opened session's transcript has
  // actually landed there. Clearing it as soon as messages exist lets the
  // catalog pushes (models/skills/subagents/commands) that follow an open
  // reset the view to the top before the load-scroll applies.
  //
  // The release probe must also wait for layout to settle: file references and
  // images inside a user message are decorated into clickable links during
  // render, which can grow the transcript *after* this synchronous pass. If we
  // probed isNearBottom here, a message that starts just below the fold would
  // measure as "near bottom", clear the pin too early, and then the next
  // catalog push would strand the user's own bubble at the bottom.
  if (stickToBottomOnLoad && messages.length > 0) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (stickToBottomOnLoad && isNearBottom(elements.conversation)) setStickToBottomOnLoad(false)
      })
    })
  }
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

function renderMessage(item: ChatItem, conclusionId: string | undefined, running: boolean): HTMLElement {
  if (item.kind === 'tool') return renderTool(item)
  if (item.kind === 'context') return renderContext(item)
  if (item.kind === 'notice') {
    const notice = node('div', `notice ${item.status || ''}`)
    notice.append(node('strong', '', item.title || t('status')))
    if (item.detail) notice.append(node('span', '', item.detail))
    components.workDuration.update(notice, item.status === 'running' ? undefined : item.workDuration, item.status === 'running')
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
  if (!running && item.role === 'assistant' && item.id === conclusionId) article.append(createCopyFooter(item))
  return article
}

function renderTool(item: ChatItem): HTMLElement {
  if (isTodoTool(item.title)) return renderTodoCard(item)
  const container = node('div', 'tool-item')
  const details = node('details', `tool-card ${item.status || ''}`) as HTMLDetailsElement
  details.dataset.disclosureKey = 'tool'
  const summary = node('summary')
  // One merged row per tool: a per-tool glyph on the call card; standalone
  // result cards (call missing from this history page) keep a status mark.
  const isResultOnly = String(item.id || '').endsWith('-result')
  const icon = isResultOnly
    ? (item.status === 'error' ? '✕' : '✓')
    : toolIcon(item.title)
  summary.append(node('span', 'tool-status', icon), node('span', 'tool-title', toolDisplayName(item.title || t('tool'))))
  if (item.detail && item.detail.trim() !== '') {
    summary.append(node('span', 'tool-preview', toolPreviewText(item.detail)))
  }
  details.append(summary)
  if (item.detail && item.detail.trim() !== '') {
    details.append(toolSectionLabel(t('toolArguments'), estimateReasoningTokens(item.detail)))
    const detail = node('div', 'tool-detail')
    renderToolDetail(detail, item.detail)
    details.append(detail)
  }
  if (item.result && item.result.trim() !== '') {
    details.append(toolSectionLabel(t('toolResult'), estimateReasoningTokens(item.result)))
    const result = node('div', 'tool-detail')
    renderToolDetail(result, item.result)
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
 * tool card: an expanded ○/●/☑ list with a `x/y` progress readout. The card is
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

const TOOL_ICONS = new Map<string, string>([
  // Shell / command execution.
  ['bash', '❯'], ['shell', '❯'], ['terminal', '❯'], ['sh', '❯'], ['zsh', '❯'],
  ['powershell', '❯'], ['exec', '❯'], ['exec_command', '❯'], ['run_command', '❯'],
  ['run', '❯'], ['command', '❯'],
  // File editing.
  ['edit', '✎'], ['str_replace_editor', '✎'], ['str_replace', '✎'], ['apply_patch', '✎'],
  ['edit_file', '✎'], ['replace', '✎'], ['rewrite', '✎'], ['write', '✎'], ['create', '✎'],
  ['create_file', '✎'], ['append', '✎'], ['append_file', '✎'],
  // File reading / browsing.
  ['read', '≡'], ['read_file', '≡'], ['view', '≡'], ['view_file', '≡'], ['cat', '≡'],
  ['ls', '≡'], ['list', '≡'], ['inspect', '≡'], ['stat', '≡'],
  // Search.
  ['glob', '⌕'], ['grep', '⌕'], ['search', '⌕'], ['find', '⌕'], ['rg', '⌕'],
  ['ripgrep', '⌕'], ['find_files', '⌕'], ['search_files', '⌕'],
  // Web / network.
  ['web_search', '≋'], ['web', '≋'], ['web_fetch', '≋'], ['fetch', '≋'], ['http', '≋'],
  ['url', '≋'], ['browser', '≋'], ['request', '≋'],
  // Workflow orchestration.
  ['workflow', '⇄'], ['pipeline', '⇄'], ['orchestrator', '⇄'], ['parallel', '⇄'],
  // Sub-agents.
  ['subagent', '◎'], ['subagent_fork', '◎'], ['agent', '◎'], ['spawn', '◎'], ['ralph', '◎'],
  // Goals.
  ['create_goal', '⚑'], ['update_goal', '⚑'], ['get_goal', '⚑'], ['goal', '⚑'],
  // Questions / confirmations.
  ['ask_user_question', '?'], ['ask', '?'], ['ask_user', '?'], ['confirm', '?'], ['prompt', '?'],
  // Task lists.
  ['todo_write', '☑'], ['todo', '☑'], ['task', '☑'],
  // Interrupt / cancel.
  ['interrupt_agent', '✕'], ['cancel', '✕'], ['kill', '✕'], ['stop', '✕'], ['job_kill', '✕'],
  // Job control.
  ['job_list', '▤'], ['job_output', '▤'], ['job', '▤'],
  // Vision / images.
  ['read_image', '▣'], ['vision_describe', '▣'], ['vision_ocr', '▣'], ['screenshot', '▣'],
  ['image', '▣'], ['ocr', '▣'],
  // Skills.
  ['skill', '✦'], ['skills', '✦'],
])

/** Best-effort glyph per tool name; dev_* helpers and unknown tools get a gear. */
function toolIcon(name: string | undefined): string {
  const normalized = String(name || '').trim().toLowerCase()
  if (normalized.startsWith('dev_')) return '⚙'
  return TOOL_ICONS.get(normalized) ?? '⚙'
}

function toolPreviewText(detail: string): string {
  const trimmed = detail.trim()
  if (isJsonText(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
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

function summarizeLine(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > 90 ? `${single.slice(0, 90)}…` : single
}

function renderToolDetail(target: HTMLElement, detail: string): void {
  const trimmed = detail.trim()
  let source: string | undefined
  if (isJsonText(trimmed)) {
    try {
      source = `\`\`\`json\n${JSON.stringify(JSON.parse(trimmed), null, 2)}\n\`\`\``
    } catch {
      source = undefined
    }
  } else if (looksLikeDiff(trimmed)) {
    source = `\`\`\`diff\n${detail}\n\`\`\``
  } else if (looksLikeCode(trimmed)) {
    source = `\`\`\`\n${detail}\n\`\`\``
  }
  if (source === undefined) {
    target.textContent = detail
    return
  }
  target.classList.add('markdown-body')
  renderMarkdown(target, source, markdownActions)
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
