// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionListItem } from '../src/domain/workbench-state.js'
import { createWebviewTranslator } from '../src/webview/localization.js'
import { SessionListComponent } from '../src/webview/session-list/component.js'

afterEach(() => document.body.replaceChildren())

function session(id: string, values: Partial<SessionListItem> = {}): SessionListItem {
  return { id, title: `Session ${id}`, updatedAt: 1, running: false, blank: false, ...values }
}

function fixture() {
  const element = document.createElement('div')
  document.body.append(element)
  const onAction = vi.fn()
  const translate = createWebviewTranslator(undefined)
  const component = new SessionListComponent({ element, onAction, translate, formatTime: time => `${time}m` })
  const state = { activeId: 'running', archived: false, snippets: new Map<string, string>(), emptyMessage: 'No conversations' }
  const update = (sessions: readonly SessionListItem[]) => component.update(sessions, state)
  const row = (id: string) => element.querySelector<HTMLElement>(`[data-session-id="${id}"]`)!
  const button = (id: string) => row(id).querySelector<HTMLButtonElement>('.session-row')!
  return { element, component, onAction, translate, state, update, row, button }
}

describe('session history during live updates', () => {
  it('preserves the pressed row and its children throughout streaming state pushes', () => {
    const f = fixture()
    const sessions = [session('running', { running: true }), session('history')]
    f.update(sessions)
    const button = f.button('history')
    const title = button.querySelector<HTMLElement>('.session-name')!
    const meta = button.querySelector('.session-meta')
    const archiveSelector = `[aria-label="${f.translate('archiveSession')}"]`
    const archive = f.row('history').querySelector(archiveSelector)
    expect(archive).not.toBeNull()
    button.focus()
    title.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    for (let tick = 2; tick < 22; tick++) {
      f.update([session('running', { running: true, updatedAt: tick }), session('history', { title: 'Updated title', updatedAt: tick })])
    }
    expect(f.button('history')).toBe(button)
    expect(button.querySelector('.session-name')).toBe(title)
    expect(button.querySelector('.session-meta')).toBe(meta)
    expect(f.row('history').querySelector(archiveSelector)).toBe(archive)
    expect(document.activeElement).toBe(button)
    expect(button.disabled).toBe(false)
    expect(title.textContent).toBe('Updated title')
    title.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    title.click()
    expect(f.onAction).toHaveBeenCalledExactlyOnceWith('selectSession', 'history')
  })

  it('updates running/active state, labels and badges without remounting the controls', () => {
    const f = fixture()
    f.update([session('one')])
    const button = f.button('one')
    f.state.activeId = 'one'
    f.state.snippets.set('one', 'Found a match')
    f.update([session('one', { running: true, updatedAt: 12, agentPreset: 'code', shared: true, isolated: true, meta: { pinned: true, tags: ['fix', 'ui'] } })])
    expect(f.button('one')).toBe(button)
    expect(button.classList.contains('active')).toBe(true)
    expect(button.querySelector('.running-dot')?.classList.contains('active')).toBe(true)
    expect(button.querySelector('.session-meta')?.textContent).toBe('12m · code')
    expect(button.querySelector('.session-mark')?.classList.contains('hidden')).toBe(false)
    expect(button.querySelector('.shared')?.classList.contains('hidden')).toBe(false)
    expect(button.querySelector('.session-tags')?.textContent).toBe('fixui')
    expect(button.querySelector('.session-snippet')?.textContent).toBe('Found a match')
    expect(f.row('one').querySelector('.session-worktree-action')?.classList.contains('hidden')).toBe(false)
    f.state.snippets.clear()
    f.update([session('one')])
    for (const selector of ['.session-mark', '.shared', '.session-tags', '.session-snippet']) {
      expect(button.querySelector(selector)?.classList.contains('hidden')).toBe(true)
    }
    expect(button.querySelector('.running-dot')?.classList.contains('active')).toBe(false)
    expect(f.row('one').querySelector('.session-worktree-action')?.classList.contains('hidden')).toBe(true)
  })

  it('keeps action handlers current across pin and archive mode changes', () => {
    const f = fixture()
    const click = (key: Parameters<typeof f.translate>[0]) => f.row('one').querySelector<HTMLButtonElement>(`[aria-label="${f.translate(key)}"]`)!.click()
    f.update([session('one', { isolated: true })])
    click('pinSession')
    click('editSessionTags')
    click('worktreeActions')
    click('archiveSession')
    const button = f.button('one')
    f.state.archived = true
    f.update([session('one', { meta: { pinned: true } })])
    click('unpinSession')
    click('restoreSession')
    expect(f.button('one')).toBe(button)
    expect(f.onAction.mock.calls).toEqual([
      ['toggleSessionPin', 'one'], ['editSessionTags', 'one'], ['worktreeAction', 'one'],
      ['archiveSession', 'one'], ['toggleSessionPin', 'one'], ['restoreSession', 'one'],
    ])
  })

  it('reconciles search results and sorting, removes stale rows, and shows the current empty message', () => {
    const f = fixture()
    f.update([session('one'), session('two'), session('three')])
    const three = f.row('three')
    f.update([session('three'), session('one')])
    expect(Array.from(f.element.children).map(row => (row as HTMLElement).dataset.sessionId)).toEqual(['three', 'one'])
    expect(f.row('three')).toBe(three)
    expect(f.row('two')).toBeNull()
    f.update([])
    expect(f.element.textContent).toBe('No conversations')
    f.state.emptyMessage = 'No archived matches'
    f.update([])
    expect(f.element.children).toHaveLength(1)
    expect(f.element.textContent).toBe('No archived matches')
    f.update([session('two')])
    expect(f.element.querySelector('.muted-empty')).toBeNull()
    expect(f.button('two').textContent).toContain('Session two')
  })

  it('renders untrusted titles, tags and snippets as text', () => {
    const f = fixture()
    f.state.snippets.set('one', '<img src=x onerror=alert(1)>')
    f.update([session('one', { title: '<script>bad()</script>', meta: { tags: ['<b>tag</b>'] } })])
    expect(f.element.querySelector('img, script, b')).toBeNull()
    expect(f.button('one').textContent).toContain('<script>bad()</script>')
    expect(f.button('one').textContent).toContain('<b>tag</b>')
    expect(f.button('one').textContent).toContain('<img src=x onerror=alert(1)>')
  })
})
