// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationScrollController } from '../src/webview/conversation-scroll/controller.js'

const disposables: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposables.splice(0)) dispose()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

function fixture() {
  const viewport = document.createElement('div')
  const content = document.createElement('div')
  const dock = document.createElement('div')
  const paragraph = document.createElement('p')
  paragraph.className = 'notice'
  paragraph.textContent = 'A readable historical paragraph.'
  content.append(paragraph)
  viewport.append(content, dock)
  document.body.append(viewport)
  const geometry = { width: 680, height: 700, contentHeight: 3000, dockHeight: 130, anchorTop: 1200, anchorHeight: 100 }
  const rect = (top: number, height: number) => ({ x: 0, y: top, left: 0, top, right: geometry.width, bottom: top + height, width: geometry.width, height, toJSON() {} })
  viewport.getBoundingClientRect = () => rect(0, geometry.height)
  paragraph.getBoundingClientRect = () => rect(geometry.anchorTop - viewport.scrollTop, geometry.anchorHeight)
  Object.defineProperties(viewport, {
    clientWidth: { get: () => geometry.width }, clientHeight: { get: () => geometry.height },
    scrollHeight: { get: () => geometry.contentHeight + geometry.dockHeight },
  })
  Object.defineProperty(content, 'offsetHeight', { get: () => geometry.contentHeight })
  Object.defineProperty(dock, 'offsetHeight', { get: () => geometry.dockHeight })
  let resized: () => void = () => {}
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback }
    observe() {}
    disconnect = disconnect
  })
  const follow = vi.fn()
  const interaction = vi.fn()
  const controller = new ConversationScrollController({ viewport, content, dock, onFollowChange: follow, onInteractionChange: interaction })
  disposables.push(() => controller.dispose())
  const scroll = () => viewport.dispatchEvent(new Event('scroll'))
  const wheel = (deltaY: number, target: HTMLElement = viewport) => target.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true }))
  const bottom = () => viewport.scrollHeight - viewport.clientHeight
  const readHistory = () => { wheel(-100); viewport.scrollTop = 1200; scroll() }
  return { viewport, content, dock, paragraph, geometry, rect, controller, resized: () => resized(), disconnect, follow, interaction, scroll, wheel, bottom, readHistory }
}

describe('conversation scroll intent and layout anchoring', () => {
  it('keeps the bottom through width/height changes, composer growth and late content', () => {
    const f = fixture()
    f.controller.toBottom()
    f.scroll()
    for (const change of [() => { f.geometry.width = 260; f.geometry.contentHeight = 6000 }, () => { f.geometry.height = 400 }, () => { f.geometry.dockHeight = 260 }, () => { f.geometry.contentHeight += 500 }]) {
      change()
      f.resized()
      f.scroll()
      expect(f.viewport.scrollTop).toBe(f.bottom())
      expect(f.follow).not.toHaveBeenCalledWith(false)
    }
  })

  it('does not mistake a resize-generated scroll event before RO for manual scrolling', () => {
    const f = fixture()
    f.controller.toBottom()
    f.scroll()
    f.geometry.width = 320
    f.geometry.contentHeight *= 2
    f.scroll()
    expect(f.viewport.scrollTop).toBe(f.bottom())
    expect(f.follow).not.toHaveBeenCalledWith(false)
  })

  it('keeps the visible historical block anchored when wrapping or prepending messages', () => {
    const f = fixture()
    f.controller.toBottom()
    f.readHistory()
    f.geometry.width = 320
    f.geometry.anchorTop = 2400
    f.geometry.contentHeight = 6000
    f.resized()
    expect(f.viewport.scrollTop).toBe(2400)
    f.controller.beforeLayout()
    f.geometry.anchorTop += 600
    f.geometry.contentHeight += 600
    f.controller.afterLayout()
    expect(f.viewport.scrollTop).toBe(3000)
    expect(f.follow).toHaveBeenLastCalledWith(false)
  })

  it('preserves a partial offset inside a tall non-text block', () => {
    const f = fixture()
    f.readHistory()
    f.viewport.scrollTop = 1225
    f.scroll()
    f.geometry.anchorTop = 2400
    f.geometry.anchorHeight = 200
    f.geometry.contentHeight = 6000
    f.resized()
    expect(f.viewport.scrollTop).toBe(2450)
  })

  it('does not steal the reading position for new streaming chunks below it', () => {
    const f = fixture()
    f.readHistory()
    f.geometry.contentHeight += 9000
    f.controller.afterLayout()
    expect(f.viewport.scrollTop).toBe(1200)
    f.controller.toBottom()
    expect(f.viewport.scrollTop).toBe(f.bottom())
    expect(f.follow).toHaveBeenLastCalledWith(true)
  })

  it('re-arms following only after the reader returns to the bottom', () => {
    const f = fixture()
    f.readHistory()
    f.viewport.scrollTop = f.bottom()
    f.scroll()
    f.geometry.contentHeight += 500
    f.resized()
    expect(f.viewport.scrollTop).toBe(f.bottom())
    expect(f.follow).toHaveBeenLastCalledWith(true)
  })

  it('pauses before wheel-up/keyboard history navigation and releases pointers outside the viewport', () => {
    const f = fixture()
    f.controller.toBottom()
    f.wheel(-50)
    expect(f.follow).toHaveBeenLastCalledWith(false)
    f.viewport.dispatchEvent(new PointerEvent('pointerdown'))
    expect(f.interaction).toHaveBeenLastCalledWith(true)
    document.dispatchEvent(new PointerEvent('pointerup'))
    expect(f.interaction).toHaveBeenLastCalledWith(false)
    f.controller.toBottom()
    f.viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp' }))
    expect(f.follow).toHaveBeenLastCalledWith(false)
  })

  it('does not mistake typing or scrolling inside a textarea for reading history', () => {
    const f = fixture()
    const prompt = document.createElement('textarea')
    prompt.style.overflowY = 'auto'
    Object.defineProperties(prompt, { scrollHeight: { value: 500 }, clientHeight: { value: 100 } })
    prompt.scrollTop = 40
    f.dock.append(prompt)
    f.controller.toBottom()
    prompt.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    f.wheel(-20, prompt)
    expect(f.follow).not.toHaveBeenCalledWith(false)
    expect(f.interaction).not.toHaveBeenCalledWith(true)
    prompt.scrollTop = 0
    f.wheel(-20, prompt)
    expect(f.follow).toHaveBeenLastCalledWith(false)
  })

  it('keeps an explicitly opened historical disclosure in view after its layout changes', () => {
    const f = fixture()
    const summary = document.createElement('summary')
    f.paragraph.append(summary)
    f.controller.toBottom()
    summary.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    document.dispatchEvent(new PointerEvent('pointerup'))
    expect(f.follow).toHaveBeenLastCalledWith(false)
    const previousTop = f.viewport.scrollTop
    f.geometry.contentHeight += 800
    f.resized()
    expect(f.viewport.scrollTop).toBe(previousTop)
    f.controller.toBottom()
    summary.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(f.follow).toHaveBeenLastCalledWith(false)
  })

  it('uses explicit navigation without a later unconditional bottom-pin callback', () => {
    const f = fixture()
    f.controller.toBottom()
    f.controller.navigateTo(1200)
    f.scroll()
    f.geometry.contentHeight += 200
    f.resized()
    expect(f.viewport.scrollTop).toBe(1200)
    expect(f.follow).toHaveBeenLastCalledWith(false)
  })

  it.each(['pointer', 'Enter', ' ', 'click'])('anchors the activated header before layout changes (%s)', (input) => {
    const f = fixture()
    const details = document.createElement('details')
    details.className = 'reasoning-block'
    const summary = document.createElement('summary')
    const label = document.createElement('span')
    label.textContent = 'Thought for 1s'
    summary.append(label)
    details.append(summary)
    f.content.append(details)
    let headerTop = 1400
    summary.getBoundingClientRect = () => f.rect(headerTop - f.viewport.scrollTop, 40)
    f.readHistory()
    if (input === 'pointer') {
      label.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      document.dispatchEvent(new PointerEvent('pointerup'))
    } else if (input !== 'click') {
      summary.dispatchEvent(new KeyboardEvent('keydown', { key: input, bubbles: true }))
    }
    // Like a markdown expansion handler, layout can change during the click,
    // before the event reaches the viewport's bubbling listeners.
    summary.addEventListener('click', () => {
      headerTop += 100
      f.geometry.contentHeight += 400
      f.controller.afterLayout()
    })
    label.click()
    f.resized()
    expect(summary.getBoundingClientRect().top).toBe(200)
    expect(f.viewport.scrollTop).toBe(1300)
    expect(f.follow).toHaveBeenLastCalledWith(false)
    f.geometry.contentHeight += 900
    f.resized()
    expect(f.viewport.scrollTop).toBe(1300)
  })

  it('handles an empty loading state and disconnects listeners/observers on dispose', () => {
    const f = fixture()
    f.content.replaceChildren()
    f.geometry.contentHeight = 0
    f.controller.toBottom()
    expect(f.viewport.scrollTop).toBe(0)
    f.content.append(f.paragraph)
    f.geometry.contentHeight = 3000
    f.resized()
    expect(f.viewport.scrollTop).toBe(f.bottom())
    f.controller.dispose()
    f.follow.mockClear()
    f.wheel(-40)
    expect(f.follow).not.toHaveBeenCalled()
    expect(f.disconnect).toHaveBeenCalled()
  })
})
