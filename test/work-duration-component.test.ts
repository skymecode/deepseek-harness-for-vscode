// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkDurationComponent } from '../src/webview/work-duration/component.js'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000) })
afterEach(() => {
  document.body.replaceChildren()
  vi.advanceTimersByTime(1_000)
  vi.useRealTimers()
})

function fixture() {
  const container = document.createElement('article')
  document.body.append(container)
  const component = createWorkDurationComponent({
    document, translate: (_key, args) => `Worked for ${String(args?.duration)}`,
  })
  return { container, component }
}

describe('duration footer without activity placeholders', () => {
  it('leaves no placeholder or timer when duration is unavailable', () => {
    const { component, container } = fixture()
    component.update(container, undefined)
    expect(container.children).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains live timing and settles without introducing any three-dot UI', () => {
    const { component, container } = fixture()
    component.update(container, { startedAt: 5_000 })
    const footer = container.firstElementChild!
    expect(footer.textContent).toContain('5s')
    vi.advanceTimersByTime(1_000)
    expect(footer.textContent).toContain('6s')
    component.update(container, { startedAt: 5_000, endedAt: 11_000 })
    expect(container.firstElementChild).toBe(footer)
    expect(vi.getTimerCount()).toBe(0)
    expect(container.querySelector('.streaming-indicator, .pending')).toBeNull()
  })

  it('removes old timing and stops its timer when an item no longer has a duration', () => {
    const { component, container } = fixture()
    component.update(container, { startedAt: 5_000 })
    expect(vi.getTimerCount()).toBe(1)
    component.update(container, undefined)
    expect(container.children).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
