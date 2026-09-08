// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActiveSessionView, HarnessWorkbenchState } from '../src/domain/workbench-state.js'
import { headerHtml } from '../src/ui/workbench/header-html.js'
import { WorkbenchHeader } from '../src/webview/workbench-header/component.js'
import { headerSummary } from '../src/webview/workbench-header/summary.js'
import { createWebviewTranslator } from '../src/webview/localization.js'

const translate = createWebviewTranslator(undefined)
const disposables: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposables.splice(0)) dispose()
  document.body.replaceChildren()
})

function state(id = 's1', phase: HarnessWorkbenchState['phase'] = 'connected'): HarnessWorkbenchState {
  return { phase, hasApiKey: true, sessions: [], archivedSessions: [], presets: [], active: {
    id, title: 'A long conversation title', running: true, blank: false,
    stats: { turns: 23, durationMs: 7_177_000, windowScoped: true },
    tokenUsage: { uncachedInputTokens: 2_000_000, cacheReadTokens: 58_400_000, cacheWriteTokens: 0, outputTokens: 193_500 },
  } as ActiveSessionView } as HarnessWorkbenchState
}

function fixture() {
  document.body.innerHTML = headerHtml('logo.png', translate)
  const element = (id: string) => document.getElementById(id)!
  const button = (id: string) => element(id) as HTMLButtonElement
  const elements = {
    connection: element('connection'), sessionTitle: button('session-title'), sessionStats: element('session-stats'), sessionUsage: element('session-usage'),
    headerMenu: element('header-menu'), headerMenuToggle: button('header-menu-toggle'), headerStats: element('header-stats'),
  }
  const component = new WorkbenchHeader(document, elements, translate)
  disposables.push(() => component.dispose())
  component.update(state())
  return { ...elements, component, button }
}

describe('single-row workbench header', () => {
  it('removes the Harness wordmark and moves secondary actions/stats outside the single row', () => {
    const f = fixture()
    const row = document.querySelector('.header-row')!
    expect(document.querySelector('.brand-row, .session-heading')).toBeNull()
    expect(row.textContent).not.toContain('Harness')
    for (const id of ['fork', 'import-session', 'export-session', 'open-settings', 'session-stats', 'session-usage']) {
      expect(f.headerMenu.contains(document.getElementById(id))).toBe(true)
      expect(row.contains(document.getElementById(id))).toBe(false)
    }
    for (const id of ['history-toggle', 'new-session', 'plugins-toggle', 'session-title', 'connection']) expect(row.contains(document.getElementById(id))).toBe(true)
  })

  it('preserves the full title, connection state and stats as accessible text/hover detail', () => {
    const f = fixture()
    expect(f.sessionTitle.title).toContain('A long conversation title')
    expect(f.sessionTitle.title).toContain('23 turns')
    expect(f.headerMenuToggle.title).toContain('60.4M')
    expect(f.headerStats.classList.contains('hidden')).toBe(false)
    expect(f.connection.textContent).toBe('Connected')
    expect(f.connection.getAttribute('role')).toBe('status')
    const label = f.connection.firstElementChild
    f.component.update(state('s1', 'reconnecting'))
    expect(f.connection.firstElementChild).toBe(label)
    expect(f.connection.title).toContain('Reconnecting')
    expect(f.connection.classList.contains('reconnecting')).toBe(true)
  })

  it('opens with keyboard focus, skips disabled actions, and closes with Escape without cancelling the turn', () => {
    const f = fixture()
    f.button('fork').disabled = true
    f.headerMenuToggle.click()
    expect(f.headerMenuToggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(f.button('import-session'))
    f.button('import-session').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(f.button('export-session'))
    const cancel = vi.fn()
    document.addEventListener('keydown', cancel)
    f.button('export-session').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(f.headerMenu.classList.contains('hidden')).toBe(true)
    expect(document.activeElement).toBe(f.headerMenuToggle)
    expect(cancel).not.toHaveBeenCalled()
    document.removeEventListener('keydown', cancel)
  })

  it('keeps live updates from closing the menu or stealing focus, but closes when switching sessions', () => {
    const f = fixture()
    f.headerMenuToggle.click()
    f.button('export-session').focus()
    f.component.update(state())
    expect(f.headerMenu.classList.contains('hidden')).toBe(false)
    expect(document.activeElement).toBe(f.button('export-session'))
    f.component.update(state('s2'))
    expect(f.headerMenu.classList.contains('hidden')).toBe(true)
  })

  it('retains action events and closes on selection, outside click or focus leaving', () => {
    const f = fixture()
    const action = vi.fn()
    f.button('import-session').addEventListener('click', action)
    f.headerMenuToggle.click()
    f.button('import-session').click()
    expect(action).toHaveBeenCalledOnce()
    expect(f.headerMenuToggle.getAttribute('aria-expanded')).toBe('false')
    f.headerMenuToggle.click()
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(f.headerMenu.classList.contains('hidden')).toBe(true)
    f.headerMenuToggle.click()
    f.button('plugins-toggle').focus()
    expect(f.headerMenu.classList.contains('hidden')).toBe(true)
  })

  it('removes stale stats when a blank session has no usage', () => {
    const f = fixture()
    f.component.update({ ...state(), active: { id: 'blank', title: '', blank: true } as ActiveSessionView })
    expect(f.headerStats.classList.contains('hidden')).toBe(true)
    expect(f.sessionTitle.textContent).toBe('New conversation')
    expect(f.headerMenuToggle.title).not.toContain('23')
    expect(headerSummary(undefined, translate)).toEqual({ stats: '', usage: '' })
  })
})
