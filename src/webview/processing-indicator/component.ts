import type { ProcessingStatus } from '../../domain/processing-status.js'
import { createWhaleActivity } from '../activity-indicator/whale.js'

export const ACTIVITY_PHRASE_INTERVAL_MS = 4_000

interface ProcessingIndicatorOptions {
  readonly document: Document
  readonly accessibleLabel: string
  readonly phrases: readonly string[]
  readonly retryLabel: (retry: Extract<ProcessingStatus, { kind: 'retry' }>['retry']) => string
}

/**
 * One reusable transcript-tail node. CSS animates the whale; a single timer
 * changes only the visual text node, never the message tree or scroll position.
 * Decorative phrase changes are hidden from assistive technology. Actual retry
 * changes remain a live status, rather than being masked by ambient copy.
 */
export class ProcessingIndicator {
  readonly element: HTMLElement
  private readonly label: HTMLElement
  private readonly visualText: Text
  private readonly accessibleText: Text
  private readonly motion: MediaQueryList | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private kind: ProcessingStatus['kind'] = 'hidden'
  private sessionId: string | undefined
  private phraseIndex = 0
  private disposed = false

  constructor(private readonly options: ProcessingIndicatorOptions) {
    const { document } = options
    this.element = document.createElement('div')
    this.element.className = 'processing-indicator'
    this.element.setAttribute('role', 'status')
    this.element.setAttribute('aria-live', 'polite')
    this.element.setAttribute('aria-atomic', 'true')
    this.label = document.createElement('span')
    this.label.className = 'processing-indicator-label'
    this.label.setAttribute('aria-hidden', 'true')
    this.visualText = document.createTextNode('')
    this.label.append(this.visualText)
    const accessible = document.createElement('span')
    accessible.className = 'processing-indicator-accessible'
    this.accessibleText = document.createTextNode(options.accessibleLabel)
    accessible.append(this.accessibleText)
    this.element.append(createWhaleActivity(document), this.label, accessible)
    this.motion = document.defaultView?.matchMedia('(prefers-reduced-motion: reduce)')
    this.motion?.addEventListener('change', this.syncTimer)
    document.addEventListener('visibilitychange', this.syncTimer)
  }

  /** Call after messages/cards, but before the transcript's scroll measurement. */
  update(root: HTMLElement, sessionId: string, state: ProcessingStatus): void {
    if (this.disposed) return
    if (this.sessionId !== sessionId || this.kind !== state.kind) {
      this.stopTimer()
      this.phraseIndex = 0
    }
    this.sessionId = sessionId
    this.kind = state.kind
    if (state.kind === 'hidden') {
      this.element.remove()
      return
    }
    const label = state.kind === 'retry' ? this.options.retryLabel(state.retry) : this.phrase()
    this.setVisualLabel(label)
    const accessible = state.kind === 'retry' ? label : this.options.accessibleLabel
    if (this.accessibleText.data !== accessible) this.accessibleText.data = accessible
    if (this.element.classList.contains('retry') !== (state.kind === 'retry')) this.element.classList.toggle('retry', state.kind === 'retry')
    // Append only when the tail moved; unrelated pushes do not restart motion
    // or trigger another screen-reader announcement.
    if (root.lastElementChild !== this.element) root.append(this.element)
    this.syncTimer()
  }

  dispose(): void {
    this.disposed = true
    this.stopTimer()
    this.motion?.removeEventListener('change', this.syncTimer)
    this.options.document.removeEventListener('visibilitychange', this.syncTimer)
    this.element.remove()
  }

  private phrase(): string {
    return this.options.phrases[this.phraseIndex] ?? this.options.accessibleLabel
  }

  private setVisualLabel(value: string): void {
    if (this.visualText.data !== value) this.visualText.data = value
    if (this.label.title !== value) this.label.title = value
  }

  private canRotate(): boolean {
    return !this.disposed && this.kind === 'working' && this.element.isConnected
      && this.options.phrases.length > 1 && !this.motion?.matches
      && this.options.document.visibilityState !== 'hidden'
  }

  /** Pauses both hidden tabs and reduced-motion users without accumulating timers. */
  private readonly syncTimer = (): void => {
    if (!this.canRotate()) {
      this.stopTimer()
      return
    }
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.canRotate()) return
      this.phraseIndex = (this.phraseIndex + 1) % this.options.phrases.length
      this.setVisualLabel(this.phrase())
      this.syncTimer()
    }, ACTIVITY_PHRASE_INTERVAL_MS)
  }

  private stopTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}
