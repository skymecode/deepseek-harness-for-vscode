import { applyIcon, icon } from '../icons.js'
import type { WebviewMessageKey } from '../localization.js'
import type { ComposerAction, ComposerActionItem } from './model.js'

interface Options {
  readonly document: Document
  readonly trigger: HTMLButtonElement
  readonly menu: HTMLElement
  readonly translate: (key: WebviewMessageKey) => string
  readonly onOpen: () => void
  readonly onChoose: (action: ComposerAction) => void
}

/** Compact, keyboard-accessible menu. No Gateway, prompt or plugin business logic here. */
export class ComposerActionsMenu {
  private readonly cleanups: (() => void)[] = []
  private readonly buttons = new Map<ComposerAction, HTMLButtonElement>()
  private items: readonly ComposerActionItem[] = []
  private sessionId: string | undefined
  private get opened(): boolean { return !this.options.menu.classList.contains('hidden') }

  constructor(private readonly options: Options) {
    this.listen(options.trigger, 'click', () => this.opened ? this.close() : this.open())
    this.listen(options.trigger, 'keydown', (event) => {
      const key = (event as KeyboardEvent).key
      if (key !== 'ArrowDown' && key !== 'ArrowUp') return
      event.preventDefault()
      this.open(key === 'ArrowUp')
    })
    this.listen(options.document, 'keydown', (event) => this.onKey(event as KeyboardEvent), true)
    this.listen(options.document, 'pointerdown', (event) => {
      if (!this.contains(event.target)) this.close()
    })
    this.listen(options.document, 'focusin', (event) => {
      if (!this.contains(event.target)) this.close()
    })
    const view = options.document.defaultView
    if (view !== null) {
      this.listen(view, 'resize', () => this.position())
      // Capture scrolling ancestors, but don't reposition while scrolling the menu itself.
      this.listen(options.document, 'scroll', (event) => {
        if (event.target !== options.menu) this.position()
      }, true)
    }
  }

  update(sessionId: string | undefined, items: readonly ComposerActionItem[]): void {
    if (sessionId !== this.sessionId) this.close()
    this.sessionId = sessionId
    this.items = items
    if (this.buttons.size === 0) this.build()
    // Update existing nodes: streaming must not steal focus or reset menu scrolling.
    for (const item of items) {
      const button = this.buttons.get(item.id)!
      button.disabled = item.disabled === true
      button.querySelector('.composer-action-label')!.textContent = this.options.translate(item.label)
      button.querySelector('.composer-action-description')!.textContent = this.options.translate(item.description)
      button.title = this.options.translate(item.description)
      if (item.checked !== undefined) {
        button.setAttribute('role', 'menuitemcheckbox')
        button.setAttribute('aria-checked', String(item.checked))
        button.querySelector('.composer-action-check')?.classList.toggle('hidden', !item.checked)
      }
    }
    this.position()
  }

  close(restoreFocus = false): void {
    this.options.menu.classList.add('hidden')
    this.options.trigger.setAttribute('aria-expanded', 'false')
    if (restoreFocus) this.options.trigger.focus()
  }

  dispose(): void { this.close(); for (const cleanup of this.cleanups) cleanup() }

  private build(): void {
    const { document, menu, translate } = this.options
    for (const group of ['add', 'tools'] as const) {
      const heading = document.createElement('div')
      heading.className = 'composer-action-heading'
      heading.setAttribute('role', 'presentation')
      heading.textContent = translate(group === 'add' ? 'composerAddHeading' : 'composerTools')
      menu.append(heading)
      for (const item of this.items.filter((item) => item.group === group)) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'composer-action'
        button.dataset.action = item.id
        button.setAttribute('role', 'menuitem')
        button.tabIndex = -1
        const glyph = document.createElement('span')
        applyIcon(glyph, icon(item.icon, 18))
        const copy = document.createElement('span')
        copy.className = 'composer-action-copy'
        for (const kind of ['label', 'description']) {
          const text = document.createElement('span')
          text.className = `composer-action-${kind}`
          copy.append(text)
        }
        const check = document.createElement('span')
        check.className = 'composer-action-check hidden'
        applyIcon(check, icon('check', 14))
        button.append(glyph, copy, check)
        button.addEventListener('click', () => {
          if (this.items.find((row) => row.id === item.id)?.disabled) return
          this.close(true)
          this.options.onChoose(item.id)
        })
        this.buttons.set(item.id, button)
        menu.append(button)
      }
    }
  }

  private open(last = false): void {
    this.options.onOpen()
    this.options.menu.classList.remove('hidden')
    this.options.trigger.setAttribute('aria-expanded', 'true')
    this.position()
    const choices = this.enabled()
    ;(last ? choices.at(-1) : choices[0])?.focus()
  }

  private onKey(event: KeyboardEvent): void {
    if (!this.opened) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation() // Escape closes the menu; it must not cancel a running turn.
      this.close(true)
      return
    }
    if (event.key === 'Tab') { this.close(true); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const choices = this.enabled()
    const current = choices.indexOf(this.options.document.activeElement as HTMLButtonElement)
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
      : (current + (event.key === 'ArrowUp' ? -1 : 1) + choices.length) % choices.length
    choices[index]?.focus()
  }

  private enabled(): HTMLButtonElement[] { return [...this.buttons.values()].filter((button) => !button.disabled) }
  private contains(target: EventTarget | null): boolean {
    return target instanceof Node && (this.options.menu.contains(target) || this.options.trigger.contains(target))
  }

  private position(): void {
    if (!this.opened) return
    const { menu, trigger, document } = this.options
    const view = document.defaultView
    if (view === null) return
    const anchor = trigger.getBoundingClientRect()
    const above = Math.max(0, anchor.top - 14)
    const below = Math.max(0, view.innerHeight - anchor.bottom - 14)
    const opensAbove = above >= Math.min(240, menu.scrollHeight) || above >= below
    menu.style.maxHeight = `${Math.max(0, opensAbove ? above : below)}px`
    const box = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(anchor.left, view.innerWidth - box.width - 8))}px`
    menu.style.top = `${opensAbove ? Math.max(8, anchor.top - box.height - 6) : anchor.bottom + 6}px`
  }

  private listen(target: EventTarget, type: string, listener: EventListener, capture = false): void {
    target.addEventListener(type, listener, capture)
    this.cleanups.push(() => target.removeEventListener(type, listener, capture))
  }
}
