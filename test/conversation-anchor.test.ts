// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { captureReadingAnchor, readingAnchorDelta } from '../src/webview/conversation-scroll/anchor.js'

afterEach(() => document.body.replaceChildren())

function box(element: HTMLElement, top: number, height: number): void {
  element.getBoundingClientRect = () => ({ x: 0, y: top, left: 0, top, right: 500, bottom: top + height, width: 500, height, toJSON() {} })
}

function fixture() {
  const viewport = document.createElement('div')
  const content = document.createElement('div')
  viewport.append(content)
  document.body.append(viewport)
  box(viewport, 0, 600)
  return { viewport, content }
}

describe('visible conversation reading anchors', () => {
  it('skips a nested summary hidden by an outer folded process', () => {
    const { viewport, content } = fixture()
    content.innerHTML = '<details class="turn-process"><summary>Old process</summary><details><summary>Hidden thought</summary></details></details><p>Visible answer</p>'
    const [outer, inner] = Array.from(content.querySelectorAll<HTMLElement>('summary'))
    const answer = content.querySelector('p')!
    box(outer!, -120, 40)
    // Cached/skipped descendant layout must not count as visible content.
    box(inner!, 20, 40)
    box(answer, 40, 100)
    expect(captureReadingAnchor(viewport, content)?.element).toBe(answer)
  })

  it.each(['auto', 'scroll', 'hidden', 'clip'])('skips old paragraphs clipped by overflow: %s', (overflow) => {
    const { viewport, content } = fixture()
    content.innerHTML = '<div class="reasoning-content"><p>Long old thought</p></div><summary>Current thought</summary>'
    const oldCard = content.firstElementChild as HTMLElement
    const paragraph = oldCard.firstElementChild as HTMLElement
    const summary = content.lastElementChild as HTMLElement
    oldCard.style.overflowY = overflow
    box(oldCard, -250, 200)
    box(paragraph, -230, 900)
    box(summary, 80, 40)
    expect(captureReadingAnchor(viewport, content)?.element).toBe(summary)
  })

  it('still captures text visible inside a scrolling card', () => {
    const { viewport, content } = fixture()
    content.innerHTML = '<div style="overflow-y:auto"><p>Visible thought</p></div>'
    box(content.firstElementChild as HTMLElement, 100, 200)
    const paragraph = content.querySelector('p')!
    box(paragraph, -100, 900)
    expect(captureReadingAnchor(viewport, content)?.element).toBe(paragraph)
  })

  it('uses the surviving header when an anchored reasoning block is closed', () => {
    const { viewport, content } = fixture()
    content.innerHTML = '<details open class="reasoning-block"><summary>Thought</summary><p>Reasoning text</p></details>'
    const details = content.querySelector('details')!
    const summary = content.querySelector('summary')!
    const paragraph = content.querySelector('p')!
    box(summary, -40, 40)
    box(paragraph, 0, 300)
    const anchor = captureReadingAnchor(viewport, content)!
    expect(anchor.element).toBe(paragraph)
    details.open = false
    box(paragraph, 0, 0)
    box(summary, -200, 40)
    expect(readingAnchorDelta(viewport, anchor)).toBe(-200)
  })
})
