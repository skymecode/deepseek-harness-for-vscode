import type { ChatItem } from '../../domain/workbench-state.js'
import { components, t } from './context.js'
import { conversationScroll } from './scroll.js'

/** Mutates only text inside the active assistant card for smooth token flow. */
export function patchStreamingMessage(element: HTMLElement, item: ChatItem): boolean {
  if (item.kind !== 'message' || item.role !== 'assistant' || element.tagName !== 'ARTICLE') return false
  const body = element.querySelector('.message-body')
  if (!body) return false
  if (!components.streamingMessage.patch(body as HTMLElement, item)) return false
  // Keep the ticking worked-time footer under the streaming DeepSeek bubble.
  components.workDuration.update(element, item.workDuration)
  return true
}

export function captureDisclosures(root: HTMLElement): Map<string, boolean> {
  const state = new Map<string, boolean>()
  for (const details of disclosureElements(root)) state.set(details.dataset.disclosureKey || '', details.open)
  return state
}

export function restoreDisclosures(root: HTMLElement, state: Map<string, boolean>): void {
  for (const details of disclosureElements(root)) {
    // autoOpen='true' always reopens (live todo cards). autoOpen='false' is a
    // *default*, not a lock: the reader's explicit expand/collapse must win
    // across rebuilds, so a collapsed-default block that the user opened stays
    // open (and a history reasoning card never snaps shut just because a newer
    // reasoning block below forces a full re-render). The captured state is the
    // source of truth; only a never-seen block falls back to the default.
    if (details.dataset.autoOpen === 'true') {
      details.open = true
    } else if (details.dataset.autoOpen === 'false') {
      details.open = state.has(details.dataset.disclosureKey || '')
        ? state.get(details.dataset.disclosureKey || '') === true
        : false
    } else {
      details.open = state.get(details.dataset.disclosureKey || '') === true
    }
  }
}

function disclosureElements(root: HTMLElement): HTMLDetailsElement[] {
  const descendants = Array.from(root.querySelectorAll('details'))
  return root.tagName === 'DETAILS' ? [root as HTMLDetailsElement, ...descendants] : descendants
}

/** Explicit navigation; layout/stream following is owned by the controller. */
export function scrollConversationToBottom(): void {
  conversationScroll.toBottom()
}

/** A stream frame must honor existing intent, never re-enable following. */
export function pinConversationToBottom(): void {
  conversationScroll.afterLayout()
}

export function formatRelativeTime(time: number): string {
  const delta = Date.now() - time
  if (delta < 60_000) return t('justNow')
  if (delta < 3_600_000) return t('minutesAgo', { count: Math.floor(delta / 60_000) })
  if (delta < 86_400_000) return t('hoursAgo', { count: Math.floor(delta / 3_600_000) })
  return new Date(time).toLocaleDateString()
}

export function formatTokenCount(count: number): string {
  return Number(count).toLocaleString()
}

export function estimateReasoningTokens(text: string): number {
  return Math.max(1, Math.round(String(text || '').trim().length / 4))
}

export function cssEscape(value: string): string {
  return window.CSS?.escape ? window.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
}

export function copyText(text: string): void {
  if (navigator.clipboard?.writeText !== undefined) {
    navigator.clipboard.writeText(text).catch(() => legacyCopy(text))
  } else {
    legacyCopy(text)
  }
}

function legacyCopy(text: string): void {
  const area = document.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  try {
    document.execCommand('copy')
  } catch {
    // Clipboard unavailable; the user can still select the text manually.
  }
  area.remove()
}
