import type { ReasoningTimelinePoint } from '../../domain/reasoning-timeline.js'
import { transcriptMessageElements } from '../chat/transcript-elements.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
const CENTER_X = 8.5
const RADIUS = 3.5

interface TimelineEntry {
  readonly element: SVGGElement
  readonly connector: SVGLineElement
  readonly dot: SVGCircleElement
}

/**
 * Out-of-flow decorations in the transcript's permanently reserved gutter.
 * Only adjacent, already rendered reasoning nodes in the same turn connect.
 * Geometry is batched separately from message rendering so expanding a card,
 * streaming text or resizing never remounts a disclosure or shifts its content.
 */
export class ReasoningTimeline {
  private readonly layer: SVGSVGElement
  private readonly entries = new Map<string, TimelineEntry>()
  private anchors = new Map<string, HTMLElement>()
  private points: readonly ReasoningTimelinePoint[] = []
  private root: HTMLElement | undefined
  private sessionId: string | undefined
  private observer: ResizeObserver | undefined
  private frame: number | undefined

  constructor(private readonly document: Document) {
    this.layer = document.createElementNS(SVG_NS, 'svg')
    this.layer.setAttribute('class', 'reasoning-timeline')
    this.layer.setAttribute('aria-hidden', 'true')
    this.layer.setAttribute('focusable', 'false')
  }

  update(root: HTMLElement, sessionId: string, points: readonly ReasoningTimelinePoint[]): void {
    if (this.root !== root || this.sessionId !== sessionId) {
      this.dispose()
      this.root = root
      this.sessionId = sessionId
      this.observer = new ResizeObserver(this.schedule)
      this.observer.observe(root)
      // Native details toggles do not bubble, but capture covers every card.
      root.addEventListener('toggle', this.schedule, true)
    }
    this.points = points
    const messages = new Map(transcriptMessageElements(root)
      .map((child) => [child.dataset.messageId, child]))
    const nextAnchors = new Map<string, HTMLElement>()
    for (const point of points) {
      const anchor = messages.get(point.messageId)?.querySelector<HTMLElement>(
        `.reasoning-block[data-disclosure-key="reasoning-${point.blockIndex}"] > summary`,
      )
      if (anchor !== null && anchor !== undefined) nextAnchors.set(point.key, anchor)
    }
    for (const [key, anchor] of this.anchors) {
      if (nextAnchors.get(key) !== anchor) this.observer?.unobserve(anchor)
    }
    for (const [key, anchor] of nextAnchors) {
      if (this.anchors.get(key) !== anchor) this.observer?.observe(anchor)
    }
    this.anchors = nextAnchors
    if (nextAnchors.size > 0) {
      if (this.layer.parentElement !== root) root.prepend(this.layer)
    } else {
      this.layer.remove()
    }
    this.schedule()
  }

  dispose(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame)
    this.frame = undefined
    this.observer?.disconnect()
    this.observer = undefined
    this.root?.removeEventListener('toggle', this.schedule, true)
    this.layer.remove()
    this.layer.replaceChildren()
    this.entries.clear()
    this.anchors.clear()
    this.points = []
    this.root = undefined
    this.sessionId = undefined
  }

  private readonly schedule = (): void => {
    if (this.frame !== undefined) return
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined
      this.draw()
    })
  }

  private draw(): void {
    if (this.root === undefined) return
    const rootTop = this.root.getBoundingClientRect().top
    // Finish all layout reads before writing SVG attributes.
    const measured = this.points.flatMap((point) => {
      const anchor = this.anchors.get(point.key)
      if (anchor?.closest('.turn-process:not([open])')) return []
      const rect = anchor?.getBoundingClientRect()
      return rect === undefined || rect.height === 0 ? [] : [{ point, y: rect.top + rect.height / 2 - rootTop }]
    })
    const keys = new Set(measured.map(({ point }) => point.key))
    for (const [key, entry] of this.entries) {
      if (keys.has(key)) continue
      entry.element.remove()
      this.entries.delete(key)
    }
    let previous: (typeof measured)[number] | undefined
    for (const current of measured) {
      const { point, y } = current
      let entry = this.entries.get(point.key)
      if (entry === undefined) {
        entry = this.createEntry(point.key)
        this.entries.set(point.key, entry)
        this.layer.append(entry.element)
      }
      setAttribute(entry.element, 'data-timeline-turn', point.groupId)
      setAttribute(entry.dot, 'cy', String(y))
      setAttribute(entry.dot, 'class', `reasoning-timeline-dot${point.running ? ' running' : ''}`)
      const connected = previous !== undefined && previous.point.groupId === point.groupId && y - previous.y > RADIUS * 2
      setAttribute(entry.connector, 'visibility', connected ? 'visible' : 'hidden')
      if (connected && previous !== undefined) {
        setAttribute(entry.connector, 'y1', String(previous.y + RADIUS))
        setAttribute(entry.connector, 'y2', String(y - RADIUS))
      }
      previous = current
    }
  }

  private createEntry(key: string): TimelineEntry {
    const element = this.document.createElementNS(SVG_NS, 'g')
    element.setAttribute('data-timeline-key', key)
    const connector = this.document.createElementNS(SVG_NS, 'line')
    connector.setAttribute('class', 'reasoning-timeline-connector')
    connector.setAttribute('x1', String(CENTER_X))
    connector.setAttribute('x2', String(CENTER_X))
    const dot = this.document.createElementNS(SVG_NS, 'circle')
    dot.setAttribute('cx', String(CENTER_X))
    dot.setAttribute('r', String(RADIUS))
    element.append(connector, dot)
    return { element, connector, dot }
  }
}

/** Catalog pushes and text deltas must leave unchanged historical nodes alone. */
function setAttribute(element: SVGElement, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value)
}
