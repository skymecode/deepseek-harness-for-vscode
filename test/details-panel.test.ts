// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DetailsPanel } from '../src/webview/details-panel/component.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); document.body.replaceChildren() })

function fixture() {
  document.body.innerHTML = `
    <button id="add">+</button><textarea>keep my draft</textarea>
    <section id="details" class="hidden">
      <div class="detail-header"><div class="detail-tabs">
        <button data-detail="todos" class="active">Plan</button>
        <button data-detail="skills">Skills</button><button data-detail="runtime">Runtime</button>
      </div><button id="close">Close</button></div>
      <div id="content"><button id="skill">A skill</button></div>
    </section>`
  const panel = document.getElementById('details')!
  const close = document.getElementById('close') as HTMLButtonElement
  const trigger = document.getElementById('add') as HTMLButtonElement
  const onSelect = vi.fn((name: string) => {
    for (const tab of Array.from(panel.querySelectorAll<HTMLButtonElement>('[data-detail]'))) {
      tab.classList.toggle('active', tab.dataset.detail === name)
    }
  })
  panel.scrollIntoView = vi.fn()
  const component = new DetailsPanel({ panel, closeButton: close, returnFocus: trigger, onSelect })
  component.updateSession('a')
  cleanups.push(() => component.dispose())
  return { component, panel, close, trigger, onSelect }
}

describe('Skills and context panel dismissal', () => {
  it('closes via the explicit button and restores focus without clearing the draft or detail DOM', () => {
    const f = fixture()
    const skill = document.getElementById('skill')
    f.component.open('skills')
    expect(f.component.opened).toBe(true)
    expect(document.activeElement?.getAttribute('data-detail')).toBe('skills')
    f.close.click()
    expect(f.component.opened).toBe(false)
    expect(document.activeElement).toBe(f.trigger)
    expect(document.querySelector('textarea')!.value).toBe('keep my draft')
    f.component.open('skills')
    expect(document.getElementById('skill')).toBe(skill)
  })

  it('toggles the same shortcut closed but switches to a different tab without hiding', () => {
    const f = fixture()
    f.component.toggle('skills')
    f.component.toggle('runtime')
    expect(f.component.opened).toBe(true)
    expect(document.activeElement?.getAttribute('data-detail')).toBe('runtime')
    f.component.toggle('runtime')
    expect(f.component.opened).toBe(false)
    f.component.toggle('skills')
    f.component.toggle() // View context also dismisses any open tab.
    expect(f.component.opened).toBe(false)
  })

  it('routes tab clicks without rebuilding the surrounding panel', () => {
    const f = fixture()
    f.component.open('skills')
    f.panel.querySelector<HTMLButtonElement>('[data-detail="todos"]')!.click()
    expect(f.onSelect).toHaveBeenLastCalledWith('todos')
    expect(f.component.opened).toBe(true)
  })

  it('consumes Escape before turn cancellation and leaves other keys alone', () => {
    const f = fixture()
    const cancel = vi.fn()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (f.component.handleEscape(event)) return
      cancel()
    }
    document.addEventListener('keydown', handleKey)
    cleanups.push(() => document.removeEventListener('keydown', handleKey))
    f.component.open('skills')
    f.panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(f.component.opened).toBe(true)
    f.panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(f.component.opened).toBe(false)
    expect(cancel).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(f.trigger)
    f.trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('does not dismiss the panel when a higher-priority popover already consumed Escape', () => {
    const f = fixture()
    f.component.open('skills')
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    event.preventDefault()
    expect(f.component.handleEscape(event)).toBe(false)
    expect(f.component.opened).toBe(true)
  })

  it('keeps streamed updates open but closes on session changes without retaining hidden focus', () => {
    const f = fixture()
    f.component.open('skills')
    f.component.updateSession('a')
    expect(f.component.opened).toBe(true)
    f.component.updateSession('b')
    expect(f.component.opened).toBe(false)
    expect(document.activeElement).toBe(f.trigger)
    f.component.open('skills')
    f.component.updateSession(undefined)
    expect(f.component.opened).toBe(false)
  })

  it('disposes button and tab listeners', () => {
    const f = fixture()
    f.component.open('skills')
    f.component.dispose()
    f.onSelect.mockClear()
    f.panel.querySelector<HTMLButtonElement>('[data-detail="todos"]')!.click()
    expect(f.onSelect).not.toHaveBeenCalled()
  })
})
