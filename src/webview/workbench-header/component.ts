import type { HarnessWorkbenchState } from '../../domain/workbench-state.js'
import { headerSummary, type HeaderTranslator } from './summary.js'

interface HeaderElements {
  readonly connection: HTMLElement
  readonly sessionTitle: HTMLButtonElement
  readonly sessionStats: HTMLElement
  readonly sessionUsage: HTMLElement
  readonly headerMenu: HTMLElement
  readonly headerMenuToggle: HTMLButtonElement
  readonly headerStats: HTMLElement
}

/** Header rendering and overflow interaction are independent of chat/stream rendering. */
export class WorkbenchHeader {
  private sessionId: string | undefined
  private readonly connectionLabel: HTMLElement
  private readonly cleanup: Array<() => void> = []

  constructor(private readonly document: Document, private readonly elements: HeaderElements, private readonly t: HeaderTranslator) {
    this.connectionLabel = document.createElement('span')
    this.connectionLabel.className = 'connection-label'
    elements.connection.append(this.connectionLabel)
    this.listen(elements.headerMenuToggle, 'click', () => this.isOpen() ? this.close() : this.open())
    this.listen(elements.headerMenu, 'click', (event) => {
      if ((event.target as Element).closest('button:not(:disabled)')) this.close()
    })
    this.listen(document, 'pointerdown', (event) => {
      if (this.isOpen() && event.target instanceof Node && !elements.headerMenu.contains(event.target) && !elements.headerMenuToggle.contains(event.target)) this.close()
    })
    this.listen(document, 'focusin', (event) => {
      if (this.isOpen() && event.target instanceof Node && !elements.headerMenu.contains(event.target) && !elements.headerMenuToggle.contains(event.target)) this.close()
    })
    // Capture Escape before the transcript's handler can treat it as Cancel.
    const keydown = (event: KeyboardEvent) => this.onKeyDown(event)
    document.addEventListener('keydown', keydown, true)
    this.cleanup.push(() => document.removeEventListener('keydown', keydown, true))
  }

  update(state: HarnessWorkbenchState): void {
    const { active, phase } = state
    if (active?.id !== this.sessionId) this.close()
    this.sessionId = active?.id
    const title = active?.title || this.t('newConversation')
    const summary = headerSummary(active, this.t)
    const status = this.t(phase === 'connected' ? 'connected' : phase === 'reconnecting' ? 'reconnecting' : phase === 'error' ? 'connectionError' : 'starting')
    const { connection, sessionTitle, sessionStats, sessionUsage, headerStats, headerMenuToggle } = this.elements
    text(sessionTitle, title)
    sessionTitle.disabled = !active || !!active.parentSessionId
    sessionTitle.title = [title, this.t('renameConversation'), summary.stats, summary.usage].filter(Boolean).join('\n')
    sessionTitle.setAttribute('aria-label', `${title} — ${this.t('renameConversation')}`)
    connection.className = `connection ${phase}`
    connection.title = [status, summary.stats, summary.usage].filter(Boolean).join('\n')
    text(this.connectionLabel, status)
    text(sessionStats, summary.stats)
    text(sessionUsage, summary.usage)
    sessionStats.classList.toggle('hidden', summary.stats === '')
    sessionUsage.classList.toggle('hidden', summary.usage === '')
    headerStats.classList.toggle('hidden', summary.stats === '' && summary.usage === '')
    headerMenuToggle.title = [this.t('moreActions'), summary.stats, summary.usage].filter(Boolean).join('\n')
  }

  close(refocus = false): void {
    const { headerMenu, headerMenuToggle } = this.elements
    headerMenu.classList.add('hidden')
    headerMenuToggle.setAttribute('aria-expanded', 'false')
    headerMenu.closest('.shell-header')?.classList.remove('menu-open')
    if (refocus) headerMenuToggle.focus()
  }

  dispose(): void {
    this.close()
    for (const remove of this.cleanup) remove()
  }

  private open(): void {
    const { headerMenu, headerMenuToggle } = this.elements
    headerMenu.classList.remove('hidden')
    headerMenuToggle.setAttribute('aria-expanded', 'true')
    headerMenu.closest('.shell-header')?.classList.add('menu-open')
    this.actions()[0]?.focus()
  }

  private isOpen(): boolean { return !this.elements.headerMenu.classList.contains('hidden') }

  private actions(): HTMLButtonElement[] {
    return Array.from(this.elements.headerMenu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (!this.isOpen()) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      this.close(true)
      return
    }
    const actions = this.actions()
    if (actions.length === 0 || !this.elements.headerMenu.contains(this.document.activeElement)) return
    const index = actions.indexOf(this.document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? (index + 1) % actions.length
      : event.key === 'ArrowUp' ? (index - 1 + actions.length) % actions.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? actions.length - 1 : undefined
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    actions[next]?.focus()
  }

  private listen(target: EventTarget, type: string, listener: EventListener): void {
    target.addEventListener(type, listener)
    this.cleanup.push(() => target.removeEventListener(type, listener))
  }
}

function text(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value
}
