interface Options {
  readonly panel: HTMLElement
  readonly closeButton: HTMLButtonElement
  readonly returnFocus: HTMLButtonElement
  readonly onSelect: (tab: string) => void
}

/** Visibility and navigation only; detail contents and host actions stay in chat/details. */
export class DetailsPanel {
  private sessionId: string | undefined
  private readonly tabs: HTMLButtonElement[]

  constructor(private readonly options: Options) {
    this.tabs = Array.from(options.panel.querySelectorAll<HTMLButtonElement>('[data-detail]'))
    options.closeButton.addEventListener('click', this.onClose)
    for (const tab of this.tabs) tab.addEventListener('click', this.onTab)
  }

  get opened(): boolean { return !this.options.panel.classList.contains('hidden') }

  open(tab = this.currentTab()): void {
    this.options.onSelect(tab)
    this.options.panel.classList.remove('hidden')
    this.tabs.find((button) => button.dataset.detail === tab)?.focus({ preventScroll: true })
    this.options.panel.scrollIntoView({ block: 'nearest' })
  }

  toggle(tab?: string): void {
    if (this.opened && (tab === undefined || tab === this.currentTab())) this.close(true)
    else this.open(tab)
  }

  close(restoreFocus = false): boolean {
    if (!this.opened) return false
    const { panel, returnFocus } = this.options
    const focusInside = panel.contains(panel.ownerDocument.activeElement)
    panel.classList.add('hidden')
    if (restoreFocus || focusInside) returnFocus.focus({ preventScroll: true })
    return true
  }

  /** Called after higher-priority popovers, before the global Escape-to-cancel fallback. */
  handleEscape(event: KeyboardEvent): boolean {
    if (event.key !== 'Escape' || event.defaultPrevented || !this.opened) return false
    event.preventDefault()
    event.stopPropagation()
    this.close(true)
    return true
  }

  updateSession(sessionId: string | undefined): void {
    if (this.sessionId !== sessionId) this.close()
    this.sessionId = sessionId
  }

  dispose(): void {
    this.close()
    this.options.closeButton.removeEventListener('click', this.onClose)
    for (const tab of this.tabs) tab.removeEventListener('click', this.onTab)
  }

  private currentTab(): string { return this.tabs.find((tab) => tab.classList.contains('active'))?.dataset.detail ?? 'todos' }
  private readonly onClose = (): void => { this.close(true) }
  private readonly onTab = (event: Event): void => {
    this.options.onSelect((event.currentTarget as HTMLButtonElement).dataset.detail ?? 'todos')
  }
}
