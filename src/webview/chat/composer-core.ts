import type { ActiveSessionView, QueuedPromptView } from '../../domain/workbench-state.js'
import { applyIcon, icon } from '../icons.js'
import { composerStatusText } from '../composer-status.js'
import {
  components,
  elements,
  node,
  pastedImages,
  payload,
  post,
  queuedEditingId,
  queuedSignature,
  setQueuedEditingId,
  setQueuedSignature,
  t,
} from './context.js'

export function renderComposer(active: ActiveSessionView | undefined): void {
  const ready = payload?.state.phase === 'connected' || payload?.state.phase === 'reconnecting'
  elements.prompt.disabled = !ready
  if (active?.subagentMode === 'one-shot') elements.prompt.disabled = true
  elements.prompt.placeholder = active?.running ? t('queuedPromptPlaceholder') : t('promptPlaceholder')
  elements.send.disabled = !ready || (!active?.running && elements.prompt.value.trim() === '' && pastedImages.length === 0)
  elements.send.textContent = active?.running ? '■' : '↑'
  elements.send.title = active?.running ? t('stopGenerating') : t('sendTitle')
  components.contextMeter.update(active?.contextPressure)
  elements.composerStatus.textContent = composerStatusText(active, {
    oneShotReadOnly: t('oneShotReadOnly'),
    continuableSubagent: t('continuableSubagent'),
  })
}

/** Compact in-composer running status; never overlays the transcript viewport. */
export function renderActivityStatus(active: ActiveSessionView | undefined): void {
  // The host only flips `running` for LLM turns; host commands such as
  // /compact surface as a notice item that stays `running` until command/done.
  const commandRunning = (active?.messages ?? []).some((item) => item.kind === 'notice' && item.status === 'running')
  elements.activityStatus.classList.toggle('hidden', active?.running !== true && !commandRunning)
  const retry = active?.retry
  if (retry === undefined) {
    elements.activityRetry.classList.add('hidden')
    elements.activityRetry.textContent = ''
    elements.activityRetry.removeAttribute('title')
    return
  }
  elements.activityRetry.classList.remove('hidden')
  elements.activityRetry.textContent = retryStatusText(retry)
  elements.activityRetry.title = elements.activityRetry.textContent
}

/** One-line live model-request retry label, e.g. "model request timed out · retrying (2/5)…". */
function retryStatusText(retry: NonNullable<ActiveSessionView['retry']>): string {
  const reason = retryReasonLabel(retry.code)
  const attempt = retry.mode === 'always'
    ? t('retryingAlways', { reason })
    : t('retryingWithAttempt', { reason, attempt: retry.attempt, max: retry.maxRetries ?? retry.attempt })
  if (retry.started) return attempt
  const seconds = retryDelaySeconds(retry.delayMs)
  return seconds > 0 ? `${attempt} · ${t('retryInSeconds', { seconds })}` : attempt
}

function retryReasonLabel(code: string | undefined): string {
  switch (code) {
    case 'TIMEOUT': return t('retryReasonTimeout')
    case 'TRANSPORT': return t('retryReasonTransport')
    case 'SERVER': return t('retryReasonServer')
    case 'RATE_LIMIT': return t('retryReasonRateLimit')
    case 'EMPTY_RESPONSE': return t('retryReasonEmptyResponse')
    default: return t('retryReasonGeneric')
  }
}

function retryDelaySeconds(delayMs: number | undefined): number {
  if (delayMs === undefined) return 0
  return Math.max(1, Math.round(delayMs / 1000))
}

/** QueueDock: prompts the user queued while a turn was running. */
export function renderQueued(active: ActiveSessionView | undefined, force = false): void {
  const queue = (active?.queue ?? []).filter((item) => item.placement === 'queued')
  const signature = JSON.stringify(queue)
  // Rebuilding the dock on every streamed chunk would wipe an in-flight edit
  // (focus + typed draft). Rebuild only when the pending queue itself changed,
  // or when a user action in the dock asks for an immediate repaint.
  if (!force && signature === queuedSignature) return
  setQueuedSignature(signature)
  if (queuedEditingId !== null && !queue.some((item) => item.id === queuedEditingId)) setQueuedEditingId(null)
  elements.queuedPanel.classList.toggle('hidden', queue.length === 0)
  elements.queuedPanel.textContent = ''
  if (queue.length === 0) return
  elements.queuedPanel.append(node('div', 'queued-title', t('queuedMessages')))
  for (const item of queue) {
    elements.queuedPanel.append(queuedEditingId === item.id ? queuedEditRow(item) : queuedItemRow(item))
  }
}

function queuedItemRow(item: QueuedPromptView): HTMLElement {
  const row = node('div', 'queued-item')
  const text = item.text || (item.hasMedia ? '(media)' : '')
  row.append(node('span', 'queued-text', text))
  const actions = node('span', 'queued-actions')
  const steer = node('button', 'queued-action') as HTMLButtonElement
  applyIcon(steer, icon('sendNow', 13))
  steer.title = t('sendNow')
  steer.setAttribute('aria-label', t('sendNow'))
  steer.addEventListener('click', () => post('steerQueued', { itemId: item.id }))
  const edit = node('button', 'queued-action') as HTMLButtonElement
  applyIcon(edit, icon('edit', 13))
  edit.title = t('editQueued')
  edit.setAttribute('aria-label', t('editQueued'))
  edit.addEventListener('click', () => {
    setQueuedEditingId(item.id)
    renderQueued(payload?.state.active, true)
  })
  const remove = node('button', 'queued-action', '✕') as HTMLButtonElement
  remove.title = t('removeQueued')
  remove.setAttribute('aria-label', t('removeQueued'))
  remove.addEventListener('click', () => post('removeQueued', { itemId: item.id }))
  actions.append(steer, edit, remove)
  row.append(actions)
  return row
}

function queuedEditRow(item: QueuedPromptView): HTMLElement {
  const row = node('div', 'queued-item')
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'queued-edit-input'
  input.value = item.text
  input.setAttribute('aria-label', t('editQueued'))
  const save = node('button', 'queued-action', '✓') as HTMLButtonElement
  save.title = t('save')
  save.addEventListener('click', () => {
    const text = input.value.trim()
    setQueuedEditingId(null)
    renderQueued(payload?.state.active, true)
    if (text !== '') post('editQueued', { itemId: item.id, text })
  })
  const cancel = node('button', 'queued-action', '✕') as HTMLButtonElement
  cancel.title = t('cancel')
  cancel.addEventListener('click', () => {
    setQueuedEditingId(null)
    renderQueued(payload?.state.active, true)
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) save.click()
    if (event.key === 'Escape') cancel.click()
  })
  row.append(input, save, cancel)
  requestAnimationFrame(() => input.focus())
  return row
}

export function resizePrompt(): void {
  elements.prompt.style.height = 'auto'
  elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight, 180)}px`
  if (payload) renderComposer(payload.state.active)
}
