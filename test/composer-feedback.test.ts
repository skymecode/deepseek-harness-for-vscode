// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComposerFeedback } from '../src/webview/composer-feedback/component.js'

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren() })

describe('transient composer feedback', () => {
  it('shows an error and returns to an empty, hidden outlet, never a shortcut hint', () => {
    vi.useFakeTimers()
    const element = document.createElement('div')
    element.className = 'hidden'
    const component = new ComposerFeedback(element)
    component.show('This model does not support images.')
    expect(element.classList.contains('hidden')).toBe(false)
    expect(element.textContent).toContain('does not support images')
    vi.advanceTimersByTime(2_600)
    expect(element.classList.contains('hidden')).toBe(true)
    expect(element.textContent).toBe('')
  })

  it('restarts the timeout on a second error and cancels timers on disposal', () => {
    vi.useFakeTimers()
    const element = document.createElement('div')
    const component = new ComposerFeedback(element)
    component.show('First')
    vi.advanceTimersByTime(2_000)
    component.show('Second')
    vi.advanceTimersByTime(600)
    expect(element.textContent).toBe('Second')
    component.dispose()
    expect(element.classList.contains('hidden')).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
