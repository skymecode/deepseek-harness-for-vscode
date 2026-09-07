// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assistant, messageBody, streamingDom } from './helpers/streaming-dom.js'

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('reasoning disclosure during streaming', () => {
  it('lets native summary clicks expand/collapse between deltas and appended blocks', () => {
    const { component, flush } = streamingDom()
    const body = messageBody()
    component.render(body, assistant('partial-1:1', [{ kind: 'reasoning', text: 'First', streaming: true }]))
    const details = body.querySelector('details')!
    const summary = details.querySelector('summary')!
    summary.click()
    expect(details.open).toBe(true)
    for (let count = 1; count <= 20; count += 1) {
      component.patch(body, assistant('partial-1:1', [{ kind: 'reasoning', text: 'First'.repeat(count), streaming: true }]))
      flush()
      expect(body.querySelector('details')).toBe(details)
      expect(details.open).toBe(true)
    }
    summary.click()
    component.patch(body, assistant('partial-1:1', [
      { kind: 'reasoning', text: 'Done' },
      { kind: 'text', text: 'Answer', streaming: true },
    ]))
    flush()
    expect(details.open).toBe(false)
    summary.click()
    expect(details.open).toBe(true)
  })

  it('does not touch finished reasoning DOM when a later block streams', () => {
    const { component, flush, renderMarkdown } = streamingDom()
    const body = messageBody()
    const completed = { kind: 'reasoning' as const, text: 'Finished reasoning', duration: { startedAt: 1, endedAt: 100 } }
    component.render(body, assistant('partial-1:1', [completed]))
    const details = body.querySelector('details')!
    details.open = true
    const content = details.querySelector<HTMLElement>('.reasoning-content')!
    content.scrollTop = 42
    const paragraph = content.firstChild
    const observer = new MutationObserver(() => undefined)
    observer.observe(details, { childList: true, subtree: true, attributes: true, characterData: true })
    renderMarkdown.mockClear()
    for (let count = 1; count <= 20; count += 1) {
      component.patch(body, assistant('partial-1:1', [completed, { kind: 'reasoning', text: 'New'.repeat(count), streaming: true }]))
      flush()
    }
    expect(observer.takeRecords()).toEqual([])
    observer.disconnect()
    expect(details.open).toBe(true)
    expect(content.firstChild).toBe(paragraph)
    expect(content.scrollTop).toBe(42)
    expect(renderMarkdown.mock.calls.every(([target]) => target !== content)).toBe(true)
  })

  it('does not schedule redundant frames and cancels pending work at settlement/disposal', () => {
    const { component, flush, frames, onStreamFrame } = streamingDom()
    const body = messageBody()
    const item = assistant('partial-1:1', [{ kind: 'reasoning', text: 'Streaming', streaming: true }])
    component.render(body, item)
    flush()
    onStreamFrame.mockClear()
    component.patch(body, { ...item, blocks: [{ ...item.blocks![0]!, reasoningTokens: 20 }] })
    expect(frames.size).toBe(0)
    expect(onStreamFrame).not.toHaveBeenCalled()
    component.patch(body, assistant('partial-1:1', [{ kind: 'reasoning', text: 'Streaming more', streaming: true }]))
    expect(frames.size).toBe(1)
    component.patch(body, assistant('event-7', [{ kind: 'reasoning', text: 'Final' }], false))
    expect(frames.size).toBe(0)
    expect(body.querySelector('.reasoning-content')?.textContent).toBe('Final')
    component.patch(body, item)
    component.dispose(body)
    expect(frames.size).toBe(0)
  })

  it('keeps earlier disclosures when a trailing block is removed or changes type', () => {
    const { component } = streamingDom()
    const body = messageBody()
    const first = { kind: 'reasoning' as const, text: 'Kept' }
    component.render(body, assistant('a', [first, { kind: 'text', text: 'placeholder' }]))
    const details = body.querySelector('details')!
    details.open = true
    component.patch(body, assistant('a', [first, { kind: 'reasoning', text: 'Different kind' }]))
    component.patch(body, assistant('a', [first], false))
    expect(body.querySelector('details')).toBe(details)
    expect(details.open).toBe(true)
    expect(body.children).toHaveLength(1)
  })
})
