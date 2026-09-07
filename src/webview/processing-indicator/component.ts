import { applyIcon, icon } from '../icons.js'

/** One reusable transcript-tail node. CSS owns motion; streaming never rebuilds it. */
export class ProcessingIndicator {
  readonly element: HTMLElement

  constructor(document: Document, label: string) {
    this.element = document.createElement('div')
    this.element.className = 'processing-indicator'
    this.element.setAttribute('role', 'status')
    this.element.setAttribute('aria-live', 'polite')
    this.element.setAttribute('aria-atomic', 'true')
    const spinner = document.createElement('span')
    spinner.className = 'processing-indicator-spinner'
    spinner.setAttribute('aria-hidden', 'true')
    applyIcon(spinner, icon('processing', 20))
    const text = document.createElement('span')
    text.className = 'processing-indicator-label'
    text.textContent = label
    this.element.append(spinner, text)
  }

  /** Call after messages/cards, but before the transcript's scroll measurement. */
  update(root: HTMLElement, visible: boolean): void {
    if (!visible) {
      this.element.remove()
      return
    }
    // Append only when the tail moved; unrelated pushes do not restart motion
    // or trigger another screen-reader announcement.
    if (root.lastElementChild !== this.element) root.append(this.element)
  }
}
