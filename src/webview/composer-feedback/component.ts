/** Transient input errors only: no permanent shortcut/footer text or reserved space. */
export class ComposerFeedback {
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly element: HTMLElement) {}

  show(message: string): void {
    clearTimeout(this.timer)
    this.element.textContent = message
    this.element.classList.remove('hidden')
    this.timer = setTimeout(() => this.clear(), 2_600)
  }

  clear(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.element.classList.add('hidden')
    this.element.textContent = ''
  }

  dispose(): void { this.clear() }
}
