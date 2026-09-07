// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProcessingIndicator } from '../src/webview/processing-indicator/component.js'
import { MessageReconciler } from '../src/webview/chat/message-reconciler.js'

afterEach(() => document.body.replaceChildren())

describe('transcript processing indicator', () => {
  it('renders a localized, accessible SVG status only when waiting', () => {
    const root = document.createElement('div')
    const component = new ProcessingIndicator(document, '处理中…')
    component.update(root, false)
    expect(root.children).toHaveLength(0)
    component.update(root, true)
    expect(component.element.textContent).toBe('处理中…')
    expect(component.element.getAttribute('role')).toBe('status')
    expect(component.element.getAttribute('aria-live')).toBe('polite')
    expect(component.element.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(component.element.dataset.messageId).toBeUndefined()
    component.update(root, false)
    expect(root.children).toHaveLength(0)
  })

  it('does not mutate the DOM or restart the spinner on unchanged state pushes', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const component = new ProcessingIndicator(document, 'Processing…')
    component.update(root, true)
    const icon = component.element.querySelector('svg')
    const observer = new MutationObserver(() => {})
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true })
    for (let frame = 0; frame < 30; frame += 1) component.update(root, true)
    expect(observer.takeRecords()).toEqual([])
    expect(component.element.querySelector('svg')).toBe(icon)
    observer.disconnect()
  })

  it('stays after the message/card tail without rebuilding historical disclosures', () => {
    const root = document.createElement('div')
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
    const component = new ProcessingIndicator(document, 'Processing…')
    component.update(root, true)
    reconciler.reconcile(root, 'session-1', [item, { ...item, id: 'b', seq: 2 }], renderer)
    component.update(root, true)
    expect(Array.from(root.children)).toEqual([old, card, root.querySelector('[data-message-id="b"]'), component.element])
    expect(card.open).toBe(true)
    component.update(root, false)
    expect(root.firstElementChild).toBe(old)
    expect(card.open).toBe(true)
  })

  it('uses theme tokens, relative sizing, CSS-only rotation and reduced-motion fallback', async () => {
    const css = await readFile(resolve(import.meta.dirname, '../media/chat.css'), 'utf8')
    const style = css.slice(css.indexOf('.processing-indicator {'), css.indexOf('/* Each segment joins'))
    expect(style).toContain('var(--vscode-textLink-foreground')
    expect(style).toContain('calc(var(--vscode-font-size) + 1px)')
    expect(style).toContain('rotate(360deg)')
    expect(style).toContain('@media (prefers-reduced-motion: reduce)')
    expect(style).toContain('animation: none')
    expect(style).not.toMatch(/#[a-f\d]{3,8}\b|position:\s*(fixed|absolute)/i)
  })
})
