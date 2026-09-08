import { captureReadingAnchor, readingAnchorDelta, type ReadingAnchor } from './anchor.js'

interface ConversationScrollOptions {
  readonly viewport: HTMLElement
  readonly content: HTMLElement
  readonly dock: HTMLElement
  readonly onFollowChange: (following: boolean) => void
  readonly onInteractionChange: (interacting: boolean) => void
}

const READING_DISCLOSURE = 'summary, .md-codeblock-expand, .changes-more'

/**
 * One owner for scroll intent, layout anchoring and stream following. Resize,
 * images and composer growth are layout changes, not evidence of user intent.
 * The dock participates in flow, so scrollHeight already reserves its space.
 */
export class ConversationScrollController {
  private following = true
  private interacting = false
  private anchor: ReadingAnchor | undefined
  private geometry = ''
  private expectedTop: number | undefined
  private touchY: number | undefined
  private readonly observer: ResizeObserver
  private readonly removeListeners: Array<() => void> = []

  constructor(private readonly options: ConversationScrollOptions) {
    const { viewport, content, dock } = options
    this.observer = new ResizeObserver(() => this.afterLayout())
    for (const element of [viewport, content, dock]) this.observer.observe(element)
    this.listen(viewport, 'scroll', this.onScroll)
    this.listen(viewport, 'wheel', this.onWheel)
    this.listen(viewport, 'pointerdown', this.onPointerDown)
    this.listen(viewport.ownerDocument, 'pointerup', this.releasePointer)
    this.listen(viewport.ownerDocument, 'pointercancel', this.releasePointer)
    this.listen(viewport, 'touchstart', this.onTouchStart)
    this.listen(viewport, 'touchmove', this.onTouchMove)
    this.listen(viewport, 'keydown', this.onKeyDown)
    // Font/viewport reflow can precede a ResizeObserver callback. Reading the
    // same geometry in onScroll also fences that ordering in Chromium.
    this.geometry = this.measure()
  }

  /** Call before a synchronous DOM update; the old reading anchor stays valid. */
  beforeLayout(): void {
    if (this.geometry !== this.measure()) this.afterLayout()
    if (!this.following && !this.anchor) this.remember()
  }

  /** Also called for streamed markdown and asynchronous content/font resizing. */
  afterLayout(): void {
    if (this.options.viewport.clientHeight === 0) return
    if (!this.interacting) {
      if (this.following) this.writeTop(this.options.viewport.scrollHeight)
      else if (this.anchor) this.writeTop(this.options.viewport.scrollTop + readingAnchorDelta(this.options.viewport, this.anchor))
    }
    this.geometry = this.measure()
  }

  /** Explicit send/session selection opts back into following newest output. */
  toBottom(): void {
    this.setFollowing(true)
    this.anchor = undefined
    this.afterLayout()
  }

  /** Explicit history navigation must not be undone by the next stream frame. */
  navigateTo(top: number): void {
    this.setFollowing(false)
    this.writeTop(top)
    this.remember()
    this.geometry = this.measure()
  }

  dispose(): void {
    this.observer.disconnect()
    for (const remove of this.removeListeners) remove()
  }

  private readonly onScroll = (): void => {
    // A resize may clamp scrollTop and queue a scroll event before RO runs.
    // Restore the pre-resize anchor/follow intent instead of treating it as a
    // scrollbar drag. Native anchoring is disabled to avoid double correction.
    if (this.geometry !== this.measure() && !this.interacting) {
      this.afterLayout()
      return
    }
    const { viewport } = this.options
    if (this.expectedTop !== undefined && Math.abs(viewport.scrollTop - this.expectedTop) <= 1) {
      this.expectedTop = undefined
      return
    }
    this.expectedTop = undefined
    this.setFollowing(this.atBottom())
    this.remember()
  }

  private readonly onWheel = (event: WheelEvent): void => {
    if (event.defaultPrevented || nestedScrollConsumes(event.target, this.options.viewport, event.deltaY)) return
    if (event.deltaY < 0) this.pause()
    else if (event.deltaY > 0 && this.atBottom()) this.toBottom()
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    // Typing or opening a model menu is not a reach for the transcript.
    if (event.target instanceof Node && this.options.dock.contains(event.target)) return
    // Opening an old card is reading intent. Its ensuing resize must not
    // immediately pin to the end and move the newly opened content away.
    if (event.target instanceof Element && event.target.closest(READING_DISCLOSURE)) this.pause()
    this.interacting = true
    this.options.onInteractionChange(true)
  }

  private readonly releasePointer = (): void => {
    if (!this.interacting) return
    this.interacting = false
    this.options.onInteractionChange(false)
    this.remember()
  }

  private readonly onTouchStart = (event: TouchEvent): void => { this.touchY = event.touches[0]?.clientY }
  private readonly onTouchMove = (event: TouchEvent): void => {
    const y = event.touches[0]?.clientY
    if (y !== undefined && this.touchY !== undefined && y > this.touchY
      && !nestedScrollConsumes(event.target, this.options.viewport, this.touchY - y)) this.pause()
    this.touchY = y
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null
    if (target?.closest('textarea, input, select, [contenteditable="true"]')) return
    if ((event.key === 'Enter' || event.key === ' ') && target?.closest(READING_DISCLOSURE)) this.pause()
    if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home' || (event.key === ' ' && event.shiftKey)) this.pause()
  }

  private pause(): void {
    this.expectedTop = undefined
    this.setFollowing(false)
    this.remember()
  }

  private setFollowing(value: boolean): void {
    this.following = value
    this.options.onFollowChange(value)
  }

  private atBottom(): boolean {
    const viewport = this.options.viewport
    return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 4
  }

  private remember(): void {
    this.anchor = this.following ? undefined : captureReadingAnchor(this.options.viewport, this.options.content)
  }

  private writeTop(top: number): void {
    const { viewport } = this.options
    const next = Math.max(0, Math.min(top, viewport.scrollHeight - viewport.clientHeight))
    if (Math.abs(next - viewport.scrollTop) < 0.5) return
    viewport.scrollTop = next
    this.expectedTop = viewport.scrollTop
  }

  private measure(): string {
    const { viewport, content, dock } = this.options
    return `${viewport.clientWidth}:${viewport.clientHeight}:${content.offsetHeight}:${dock.offsetHeight}:${viewport.scrollHeight}`
  }

  private listen<K extends keyof GlobalEventHandlersEventMap>(target: EventTarget, type: K, callback: (event: GlobalEventHandlersEventMap[K]) => void): void {
    target.addEventListener(type, callback as EventListener, { passive: true })
    this.removeListeners.push(() => target.removeEventListener(type, callback as EventListener))
  }
}

/** Let textarea/tool-card scrolling finish before changing transcript intent. */
function nestedScrollConsumes(target: EventTarget | null, viewport: HTMLElement, delta: number): boolean {
  for (let element = target instanceof Element ? target : null; element && element !== viewport; element = element.parentElement) {
    const overflow = getComputedStyle(element).overflowY
    if (overflow !== 'auto' && overflow !== 'scroll') continue
    const max = element.scrollHeight - element.clientHeight
    if ((delta < 0 && element.scrollTop > 0) || (delta > 0 && element.scrollTop < max - 1)) return true
  }
  return false
}
