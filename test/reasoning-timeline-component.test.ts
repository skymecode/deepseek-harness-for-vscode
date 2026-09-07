// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReasoningTimeline } from '../src/webview/reasoning-timeline/component.js'
import type { ReasoningTimelinePoint } from '../src/domain/reasoning-timeline.js'
import { streamingDom } from './helpers/streaming-dom.js'

let timeline: ReasoningTimeline
let root: HTMLElement
let clock: ReturnType<typeof streamingDom>
let resize: () => void
const disconnect = vi.fn()

beforeEach(() => {
  clock = streamingDom()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = disconnect
  })
  root = document.createElement('div')
  root.className = 'messages'
  document.body.append(root)
  vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, -100, 600, 1000))
  timeline = new ReasoningTimeline(document)
})
afterEach(() => {
  timeline.dispose()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function point(turn: number, step: number, running = false): ReasoningTimelinePoint {
  return { key: `${turn}:${step}#0`, groupId: `turn:${turn}`, messageId: `${turn}:${step}`, blockIndex: 0, running }
}

function anchor(point: ReasoningTimelinePoint, top: number) {
  const article = document.createElement('article')
  article.dataset.messageId = point.messageId
  article.innerHTML = '<details class="reasoning-block" data-disclosure-key="reasoning-0"><summary>Thinking</summary><p>Thought</p></details>'
  root.append(article)
  const summary = article.querySelector('summary')!
  const rect = vi.spyOn(summary, 'getBoundingClientRect').mockImplementation(() => new DOMRect(22, top, 578, 38))
  return { article, details: article.querySelector('details')!, rect }
}

function update(points: readonly ReasoningTimelinePoint[], session = 'session') {
  timeline.update(root, session, points)
  clock.flush()
}

const dots = () => root.querySelectorAll('.reasoning-timeline-dot')
const lines = () => root.querySelectorAll('line[visibility="visible"]')

describe('progressive reasoning timeline decorations', () => {
  it('starts empty and creates only a point, not a full-height rail, on the first thought', () => {
    update([])
    expect(root.querySelector('svg')).toBeNull()
    const first = point(1, 1, true)
    anchor(first, 20)
    update([first])
    expect(dots()).toHaveLength(1)
    expect(lines()).toHaveLength(0)
    expect(dots()[0]?.getAttribute('cy')).toBe('139')
    expect(root.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(root.querySelector('svg')?.hasAttribute('data-message-id')).toBe(false)
  })

  it('connects only existing same-turn headers and keeps completed turns visible', () => {
    const first = point(1, 1)
    const second = point(1, 2, true)
    anchor(first, 20)
    update([first])
    const old = dots()[0]
    anchor(second, 200)
    update([first, second])
    expect(dots()).toHaveLength(2)
    expect(dots()[0]).toBe(old)
    expect(lines()).toHaveLength(1)
    expect([lines()[0]?.getAttribute('y1'), lines()[0]?.getAttribute('y2')]).toEqual(['142.5', '315.5'])
    update([first, { ...second, running: false }])
    expect(dots()).toHaveLength(2)
    expect(lines()).toHaveLength(1)
    expect(root.querySelector('.running')).toBeNull()
    const nextTurn = point(2, 1, true)
    anchor(nextTurn, 450)
    update([first, second, nextTurn])
    expect(dots()).toHaveLength(3)
    expect(lines()).toHaveLength(1)
  })

  it('measures the actual reasoning header, including later blocks in a message', () => {
    const later = { ...point(1, 1), blockIndex: 2 }
    const { article, details } = anchor(later, 160)
    details.dataset.disclosureKey = 'reasoning-2'
    article.prepend(document.createElement('p'))
    update([later])
    expect(dots()[0]?.getAttribute('cy')).toBe('279')
  })

  it('updates geometry after resize/toggle without replacing or closing cards', () => {
    const first = point(1, 1)
    const second = point(1, 2)
    const old = anchor(first, 20)
    const next = anchor(second, 200)
    update([first, second])
    const dot = dots()[1]
    old.details.open = true
    next.rect.mockImplementation(() => new DOMRect(22, 300, 578, 38))
    old.details.dispatchEvent(new Event('toggle'))
    resize()
    expect(clock.frames.size).toBe(1)
    clock.flush()
    expect(dots()[1]).toBe(dot)
    expect(dot?.getAttribute('cy')).toBe('419')
    expect(old.details.open).toBe(true)
  })

  it('does not mutate unchanged historical decorations on streaming state pushes', () => {
    const first = point(1, 1)
    anchor(first, 20)
    update([first])
    const observer = new MutationObserver(() => {})
    observer.observe(root, { subtree: true, childList: true, attributes: true })
    for (let frame = 0; frame < 30; frame++) update([first])
    expect(observer.takeRecords()).toEqual([])
    observer.disconnect()
  })

  it('retains the node through a partial/final message id handoff', () => {
    const first = point(1, 1, true)
    const { article } = anchor(first, 20)
    update([first])
    const dot = dots()[0]
    article.dataset.messageId = 'event-42'
    update([{ ...first, messageId: 'event-42', running: false }])
    expect(dots()[0]).toBe(dot)
    expect(dot?.classList.contains('running')).toBe(false)
  })

  it('joins prepended history only within its own turn and removes missing anchors', () => {
    const second = point(1, 2)
    const third = point(2, 1)
    anchor(second, 200)
    const removed = anchor(third, 400)
    update([second, third])
    const old = dots()[0]
    const first = point(1, 1)
    const prepended = anchor(first, 20)
    root.prepend(prepended.article)
    update([first, second, third])
    expect(lines()).toHaveLength(1)
    expect(root.querySelector('[data-timeline-key="1:2#0"] circle')).toBe(old)
    removed.article.remove()
    update([first, second, third])
    expect(dots()).toHaveLength(2)
  })

  it('cleans up decorations, observers and scheduled frames when switching sessions', () => {
    const first = point(1, 1)
    anchor(first, 20)
    update([first])
    timeline.update(root, 'other', [])
    expect(root.querySelector('svg')).toBeNull()
    timeline.dispose()
    expect(clock.frames.size).toBe(0)
    expect(disconnect).toHaveBeenCalled()
  })
})
