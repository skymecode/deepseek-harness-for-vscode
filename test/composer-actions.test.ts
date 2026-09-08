// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActiveSessionView } from '../src/domain/workbench-state.js'
import { ComposerActionsMenu } from '../src/webview/composer-actions/component.js'
import { composerActionItems } from '../src/webview/composer-actions/model.js'
import { createFileMentionComponent } from '../src/webview/file-mention/component.js'
import { createWebviewTranslator } from '../src/webview/localization.js'

const translate = createWebviewTranslator(undefined)
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); document.body.replaceChildren(); vi.useRealTimers() })
const active = { id: 'a', running: false, plan: { active: false, pending: false } } as ActiveSessionView

function fixture() {
  document.body.innerHTML = '<button id="add" aria-expanded="false"></button><div id="menu" class="hidden"></div><textarea id="prompt"></textarea>'
  const trigger = document.getElementById('add') as HTMLButtonElement
  const menu = document.getElementById('menu')!
  const onChoose = vi.fn()
  const component = new ComposerActionsMenu({ document, trigger, menu, translate, onOpen: vi.fn(), onChoose })
  cleanups.push(() => component.dispose())
  component.update('a', composerActionItems(active, true))
  const button = (id: string) => menu.querySelector<HTMLButtonElement>(`[data-action="${id}"]`)!
  return { trigger, menu, component, onChoose, button }
}

describe('composer plus menu', () => {
  it('exposes only supported shortcuts and honors the session capabilities', () => {
    const idle = composerActionItems(undefined, false)
    expect(idle.find((item) => item.id === 'plan')?.disabled).toBe(true)
    expect(idle.find((item) => item.id === 'plugins')?.disabled).not.toBe(true)
    expect(composerActionItems(active, true).find((item) => item.id === 'plan')?.disabled).toBe(false)
    expect(composerActionItems({ ...active, running: true }, true).find((item) => item.id === 'plan')?.disabled).toBe(true)
    expect(composerActionItems({ ...active, subagentMode: 'one-shot' }, true).find((item) => item.id === 'files')?.disabled).toBe(true)
    expect(idle.map((item) => item.id)).toEqual(['files', 'selection', 'goal', 'plan', 'skills', 'plugins', 'context'])
  })

  it('opens, navigates by keyboard, and dispatches a selected action exactly once', () => {
    const f = fixture()
    f.trigger.click()
    expect(f.trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(f.button('files'))
    f.button('files').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(f.button('selection'))
    f.button('selection').click()
    expect(f.onChoose).toHaveBeenCalledExactlyOnceWith('selection')
    expect(f.menu.classList.contains('hidden')).toBe(true)
  })

  it('Escape closes only the menu and never reaches the global turn-cancel handler', () => {
    const f = fixture()
    const cancel = vi.fn()
    document.addEventListener('keydown', cancel)
    cleanups.push(() => document.removeEventListener('keydown', cancel))
    f.trigger.click()
    f.button('files').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(cancel).not.toHaveBeenCalled()
    expect(f.menu.classList.contains('hidden')).toBe(true)
    expect(document.activeElement).toBe(f.trigger)
  })

  it('keeps focus and nodes during streaming but closes on a session switch', () => {
    const f = fixture()
    f.trigger.click()
    f.button('plugins').focus()
    const button = f.button('plugins')
    f.component.update('a', composerActionItems({ ...active, running: true }, true))
    expect(f.button('plugins')).toBe(button)
    expect(document.activeElement).toBe(button)
    expect(f.menu.classList.contains('hidden')).toBe(false)
    f.component.update('b', composerActionItems(active, true))
    expect(f.menu.classList.contains('hidden')).toBe(true)
  })

  it('closes on outside pointer/focus and handles a checked Plan mode', () => {
    const f = fixture()
    f.component.update('a', composerActionItems({ ...active, plan: { active: true, pending: false } }, true))
    expect(f.button('plan').getAttribute('aria-checked')).toBe('true')
    f.trigger.click()
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(f.menu.classList.contains('hidden')).toBe(true)
    f.trigger.click()
    document.querySelector('textarea')!.focus()
    expect(f.menu.classList.contains('hidden')).toBe(true)
  })
})

describe('file shortcut uses real @ attachments', () => {
  it('preserves selected draft text and requests host suggestions', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<textarea></textarea><div id="file-mention-menu" class="hidden"></div>'
    const prompt = document.querySelector('textarea')!
    const search = vi.fn()
    const choose = vi.fn()
    const component = createFileMentionComponent({ document, prompt, translate, onSearch: search, onChoose: choose, onOpen: vi.fn() })
    prompt.value = 'keep my draft'
    prompt.setSelectionRange(0, 4)
    component.open()
    expect(prompt.value).toBe('keep @ my draft')
    await vi.advanceTimersByTimeAsync(80)
    expect(search).toHaveBeenCalledWith('', 1)
    component.acceptSuggestions(1, '', [{ id: 'host-file-id', path: 'src/main.ts', label: 'main.ts' }])
    document.querySelector<HTMLButtonElement>('.file-mention-item')!.click()
    expect(choose).toHaveBeenCalledWith(expect.objectContaining({ id: 'host-file-id' }))
    expect(prompt.value).toBe('keep  my draft')
    expect(document.getElementById('file-mention-menu')!.classList.contains('hidden')).toBe(true)
  })
})
