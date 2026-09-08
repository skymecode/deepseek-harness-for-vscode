// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProcessingIndicator, ACTIVITY_PHRASE_INTERVAL_MS } from '../src/webview/processing-indicator/component.js'
import { MessageReconciler } from '../src/webview/chat/message-reconciler.js'

const working = { kind: 'working' } as const
const hidden = { kind: 'hidden' } as const
const instances: ProcessingIndicator[] = []
let root: HTMLElement
let reducedMotion: boolean
let visibility: DocumentVisibilityState
const motionListeners = new Set<() => void>()

beforeEach(() => {
  vi.useFakeTimers()
  reducedMotion = false
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.spyOn(window, 'matchMedia').mockReturnValue({
    get matches() { return reducedMotion },
    addEventListener: (_event: string, listener: () => void) => motionListeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => motionListeners.delete(listener),
  } as unknown as MediaQueryList)
  root = document.createElement('div')
  document.body.append(root)
})

afterEach(() => {
  instances.splice(0).forEach((component) => component.dispose())
  motionListeners.clear()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function indicator(phrases: readonly string[] = ['Working…', 'Percolating…', 'Pondering…']) {
  const component = new ProcessingIndicator({
    document, phrases, accessibleLabel: 'Processing…',
    retryLabel: (retry) => `Retrying (${retry.attempt}/${retry.maxRetries})`,
  })
  instances.push(component)
  return component
}

const visibleLabel = (component: ProcessingIndicator) => component.element.querySelector('.processing-indicator-label')!
const accessibleLabel = (component: ProcessingIndicator) => component.element.querySelector('.processing-indicator-accessible')!

describe('transcript processing indicator', () => {
  it('renders a localized, accessible SVG status only when working', () => {
    const component = indicator(['正在工作…', '酝酿中…'])
    component.update(root, 'session', hidden)
    expect(root.children).toHaveLength(0)
    component.update(root, 'session', working)
    expect(visibleLabel(component).textContent).toBe('正在工作…')
    expect(visibleLabel(component).getAttribute('aria-hidden')).toBe('true')
    expect(component.element.querySelector('.activity-whale')).not.toBeNull()
    expect(component.element.querySelectorAll('.activity-whale-drop')).toHaveLength(3)
    expect(component.element.getAttribute('role')).toBe('status')
    expect(component.element.getAttribute('aria-live')).toBe('polite')
    expect(component.element.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(component.element.dataset.messageId).toBeUndefined()
    component.update(root, 'session', hidden)
    expect(root.children).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not mutate the DOM or restart the whale/timer on unchanged state pushes', () => {
    const component = indicator()
    component.update(root, 'session', working)
    const icon = component.element.querySelector('svg')
    const observer = new MutationObserver(() => {})
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true })
    vi.advanceTimersByTime(ACTIVITY_PHRASE_INTERVAL_MS / 2)
    for (let frame = 0; frame < 30; frame += 1) component.update(root, 'session', working)
    expect(observer.takeRecords()).toEqual([])
    expect(component.element.querySelector('svg')).toBe(icon)
    observer.disconnect()
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(ACTIVITY_PHRASE_INTERVAL_MS / 2)
    expect(visibleLabel(component).textContent).toBe('Percolating…')
  })

  it('stays after the message/card tail without rebuilding historical disclosures', () => {
    const reconciler = new MessageReconciler()
    const renderer = {
      create: () => document.createElement('article'), patch: () => true,
      replace: () => document.createElement('article'), release: () => {},
    }
    const item = { id: 'a', kind: 'message' as const, seq: 1, time: 1 }
    reconciler.reconcile(root, 'session-1', [item], renderer)
    const old = root.firstElementChild!
    const card = document.createElement('details')
    card.open = true
    root.append(card)
    const component = indicator()
    component.update(root, 'session-1', working)
    reconciler.reconcile(root, 'session-1', [item, { ...item, id: 'b', seq: 2 }], renderer)
    component.update(root, 'session-1', working)
    expect(Array.from(root.children)).toEqual([old, card, root.querySelector('[data-message-id="b"]'), component.element])
    expect(card.open).toBe(true)
    component.update(root, 'session-1', hidden)
    expect(root.firstElementChild).toBe(old)
    expect(card.open).toBe(true)
  })

  it('cycles only the visual text node, keeping a stable accessible status and icon', () => {
    const component = indicator()
    component.update(root, 'session', working)
    const text = visibleLabel(component).firstChild
    const whale = component.element.firstChild
    const speech = accessibleLabel(component).firstChild
    vi.advanceTimersByTime(ACTIVITY_PHRASE_INTERVAL_MS)
    expect(visibleLabel(component).textContent).toBe('Percolating…')
    expect(visibleLabel(component).firstChild).toBe(text)
    expect(component.element.firstChild).toBe(whale)
    expect(accessibleLabel(component).firstChild).toBe(speech)
    expect(accessibleLabel(component).textContent).toBe('Processing…')
    vi.advanceTimersByTime(ACTIVITY_PHRASE_INTERVAL_MS * 2)
    expect(visibleLabel(component).textContent).toBe('Working…')
  })

  it('shows actual retry detail, pauses decorative copy, and resumes working when retry ends', () => {
    const component = indicator()
    component.update(root, 'session', working)
    component.update(root, 'session', { kind: 'retry', retry: { provider: 'deepseek-official', attempt: 2, maxRetries: 5, mode: 'normal', started: false } })
    expect(visibleLabel(component).textContent).toBe('Retrying (2/5)')
    expect(accessibleLabel(component).textContent).toBe('Retrying (2/5)')
    expect(component.element.classList.contains('retry')).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(12_000)
    expect(visibleLabel(component).textContent).toBe('Retrying (2/5)')
    component.update(root, 'session', working)
    expect(visibleLabel(component).textContent).toBe('Working…')
    expect(component.element.classList.contains('retry')).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('stops on completion and resets copy on a new session without leaking timers', () => {
    const component = indicator()
    component.update(root, 'first', working)
    vi.advanceTimersByTime(ACTIVITY_PHRASE_INTERVAL_MS)
    component.update(root, 'second', working)
    expect(visibleLabel(component).textContent).toBe('Working…')
    expect(vi.getTimerCount()).toBe(1)
    component.update(root, 'second', hidden)
    expect(vi.getTimerCount()).toBe(0)
    component.update(root, 'second', working)
    component.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(motionListeners.size).toBe(0)
    document.dispatchEvent(new Event('visibilitychange'))
    component.update(root, 'second', working)
    expect(root.children).toHaveLength(0)
  })

  it('pauses hidden pages and reduced-motion users, and resumes only one timer', () => {
    const component = indicator()
    component.update(root, 'session', working)
    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(vi.getTimerCount()).toBe(0)
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(vi.getTimerCount()).toBe(1)
    reducedMotion = true
    for (const listener of motionListeners) listener()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(12_000)
    expect(visibleLabel(component).textContent).toBe('Working…')
    reducedMotion = false
    for (const listener of motionListeners) listener()
    expect(vi.getTimerCount()).toBe(1)
    root.remove()
    vi.advanceTimersByTime(ACTIVITY_PHRASE_INTERVAL_MS)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('falls back to accessible copy when no phrases are configured', () => {
    const component = indicator([])
    component.update(root, 'session', working)
    expect(visibleLabel(component).textContent).toBe('Processing…')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses theme tokens, relative sizing, CSS-only whale motion and reduced-motion fallback', async () => {
    const css = await readFile(resolve(import.meta.dirname, '../media/chat.css'), 'utf8')
    const style = css.slice(css.indexOf('.processing-indicator {'), css.indexOf('/* Each segment joins'))
    expect(style).toContain('var(--vscode-textLink-foreground')
    expect(style).toContain('max(12px, calc(var(--vscode-font-size) - 1px))')
    expect(style).toContain('activity-whale-spout')
    expect(style).toContain('@media (prefers-reduced-motion: reduce)')
    expect(style).toContain('animation: none')
    expect(style).toContain('white-space: nowrap')
    expect(style).not.toMatch(/#[a-f\d]{3,8}\b|position:\s*fixed/i)
  })

  it('keeps the decorative status compact without changing the conversation font', async () => {
    const component = indicator()
    expect(component.element.querySelector('.activity-whale > svg')?.getAttribute('width')).toBe('20')
    const css = await readFile(resolve(import.meta.dirname, '../media/chat.css'), 'utf8')
    const row = /\.processing-indicator \{([^}]+)\}/.exec(css)?.[1] ?? ''
    const whale = /\.activity-whale \{([^}]+)\}/.exec(css)?.[1] ?? ''
    const label = /\.processing-indicator-label \{([^}]+)\}/.exec(css)?.[1] ?? ''
    expect(row).toContain('min-height: 26px')
    expect(row).toContain('gap: 6px')
    expect(row).toContain('padding: 0')
    expect(whale).toContain('width: 20px')
    expect(whale).toContain('height: 20px')
    expect(label).toContain('font-weight: 400')
    expect(css).toMatch(/\.conversation:has\(> \.messages > \.processing-indicator\)\s*\{[^}]*padding-bottom: 6px/s)
  })
})
