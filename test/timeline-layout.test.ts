// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const styles = document.createElement('style')

beforeAll(async () => {
  // Use the production cascade, including narrow-sidebar overrides.
  const sources = await Promise.all(['chat.css', 'chat-responsive.css'].map((file) =>
    readFile(resolve(import.meta.dirname, '../media', file), 'utf8')))
  styles.textContent = sources.join('\n')
  document.head.append(styles)
})

beforeEach(() => {
  document.body.innerHTML = `
    <main class="chat"><section class="conversation"><div class="messages">
      <article class="message user"><div class="message-body">Hello</div></article>
    </div></section></main>`
})

afterEach(() => document.body.replaceChildren())
afterAll(() => styles.remove())

/** happy-dom checks the CSS contract; pixel geometry needs a real browser. */
function transcriptLayout(messages: HTMLElement) {
  const style = getComputedStyle(messages)
  return {
    position: style.position,
    paddingLeft: style.paddingLeft,
    paddingRight: style.paddingRight,
    marginLeft: style.marginLeft,
    width: style.width,
    boxSizing: style.boxSizing,
    gridTemplateColumns: style.gridTemplateColumns,
  }
}

describe('step timeline layout', () => {
  it.each([
    ['reasoning', '<article class="message assistant"><div class="message-body"><details class="reasoning-block running"><summary>Thinking</summary><p>Reasoning</p></details></div></article>'],
    ['tool', '<article class="tool-item"><details class="tool-card running"><summary>Read file</summary></details></article>'],
    ['notice', '<article class="notice">Context updated</article>'],
  ])('keeps the transcript gutter stable when a %s step appears and finishes', (_kind, markup) => {
    const messages = document.querySelector<HTMLElement>('.messages')!
    const idleLayout = transcriptLayout(messages)
    expect(idleLayout.paddingLeft).toBe('22px')
    expect(idleLayout.position).toBe('relative')

    // Sending the prompt and receiving the first step must not indent history.
    messages.insertAdjacentHTML('beforeend', markup)
    const layer = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    layer.setAttribute('class', 'reasoning-timeline')
    messages.prepend(layer)
    expect(transcriptLayout(messages)).toEqual(idleLayout)
    expect(getComputedStyle(layer).position).toBe('absolute')
    expect(getComputedStyle(layer).pointerEvents).toBe('none')

    // Reader interactions and subsequent turns must use the same geometry.
    const details = messages.querySelector('details')
    if (details !== null) details.open = true
    expect(transcriptLayout(messages)).toEqual(idleLayout)
    layer.remove()
    expect(transcriptLayout(messages)).toEqual(idleLayout)
  })

  it('has no global running-dependent spine and uses theme-colored, motion-aware segments', () => {
    expect(styles.textContent).not.toContain('.messages.timeline-live')
    const timeline = styles.textContent!.split('/* Each segment joins')[1]!.split('.message {')[0]!
    expect(timeline).toContain('--vscode-descriptionForeground')
    expect(timeline).toContain('--vscode-charts-blue')
    expect(timeline).toContain('prefers-reduced-motion')
    expect(timeline).not.toMatch(/#[a-f\d]{3,8}\b/i)
  })
})
