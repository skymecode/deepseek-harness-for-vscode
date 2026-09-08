import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Window } from 'happy-dom'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { workbenchHtml } from '../src/ui/workbench/view-html.js'

const browser = new Window()
const document = browser.document
const getComputedStyle = browser.getComputedStyle.bind(browser)

vi.mock('vscode', () => ({
  env: { language: 'en' },
  l10n: { t: (text: string) => text },
  Uri: { joinPath: (_base: unknown, ...parts: string[]) => parts.join('/') },
}))

beforeAll(async () => {
  const html = workbenchHtml({ asWebviewUri: () => '', cspSource: '' } as unknown as Parameters<typeof workbenchHtml>[0], {} as Parameters<typeof workbenchHtml>[1])
  // Parse the actual template without executing scripts or requesting assets.
  const parsed = new browser.DOMParser().parseFromString(html, 'text/html')
  document.body.innerHTML = parsed.body.innerHTML
  const styles = document.createElement('style')
  styles.textContent = (await Promise.all(['chat.css', 'composer-actions.css', 'chat-responsive.css'].map((name) =>
    readFile(resolve(import.meta.dirname, '../media', name), 'utf8')))).join('\n')
  document.head.append(styles)
})

afterAll(() => {
  document.head.replaceChildren()
  document.body.replaceChildren()
})

describe('composer and transcript layout boundaries', () => {
  it('extends the scroll viewport through a sticky composer that reserves its flow height', () => {
    const transcript = document.querySelector('#transcript-scroll')!
    const composer = document.querySelector('.composer-shell')!
    for (const selector of ['#conversation', '#details', '#interactions']) {
      expect(transcript.contains(document.querySelector(selector)!)).toBe(true)
    }
    const dock = document.querySelector('#composer-dock')!
    expect(transcript.contains(composer)).toBe(true)
    expect(dock.contains(composer)).toBe(true)
    expect(document.querySelector('#composer-hint')).toBeNull()
    expect(getComputedStyle(dock).position).toBe('sticky')
    expect(getComputedStyle(dock).bottom).toBe('0px')
    expect(getComputedStyle(dock).flexShrink).toBe('0')
    expect(getComputedStyle(transcript).overflowY).toBe('auto')
    expect(getComputedStyle(document.querySelector('#chat')!).overflow).toBe('hidden')
    expect(getComputedStyle(composer).position).toBe('relative')
    expect(getComputedStyle(transcript).scrollBehavior).toBe('auto')
    expect(getComputedStyle(transcript).overflowAnchor).toBe('none')
  })

  it('does not crush context and approval panels into border-only separators', () => {
    for (const selector of ['#details', '#interactions']) {
      const panel = document.querySelector(selector)!
      expect(getComputedStyle(panel).flexShrink).toBe('0')
      expect(document.querySelector('#transcript-content')!.contains(panel)).toBe(true)
      expect(document.querySelector('#composer-dock')!.contains(panel)).toBe(false)
    }
    expect(getComputedStyle(document.querySelector('#composer-dock')!).borderTopStyle).not.toBe('solid')
  })

  it('keeps a named context close button outside the horizontally scrollable tabs', () => {
    const close = document.querySelector('#details-close')!
    expect(close.closest('.detail-header')?.closest('#details')).not.toBeNull()
    expect(close.closest('.detail-tabs')).toBeNull()
    expect(close.querySelector('svg')).not.toBeNull()
    expect(close.getAttribute('aria-label')).toBe('Close context panel')
    expect(getComputedStyle(document.querySelector('.detail-header')!).gridTemplateColumns).toBe('minmax(0, 1fr) auto')
    expect(getComputedStyle(close).width).toBe('28px')
  })

  it('removes the redundant running row entirely while retaining the send/stop control', async () => {
    expect(document.querySelector('#activity-status, #activity-retry, .activity-star')).toBeNull()
    expect(document.querySelector('#send')?.closest('.composer-shell')).not.toBeNull()
    const context = await readFile(resolve(import.meta.dirname, '../src/webview/chat/context.ts'), 'utf8')
    expect(context).not.toContain("byId<HTMLElement>('activity-status')")
    expect(context).not.toContain("byId<HTMLElement>('activity-retry')")
  })

  it('retains the composer as the positioning context for its menus', () => {
    for (const selector of ['#configuration-panel', '#command-menu', '#file-mention-menu', '#timeline-panel', '#composer-add-menu']) {
      expect(document.querySelector(selector)?.parentElement?.classList.contains('composer-shell')).toBe(true)
    }
  })

  it('replaces the context text with a named SVG plus control and an unclipped menu', () => {
    expect(document.querySelector('#details-toggle')).toBeNull()
    const trigger = document.querySelector('#composer-add-toggle')!
    expect(trigger.querySelector('svg')).not.toBeNull()
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-label')).toBe('Add context and tools')
    expect(getComputedStyle(document.querySelector('#composer-add-menu')!).position).toBe('fixed')
  })

  it('keeps permission and model selectors borderless, including danger and pending states', () => {
    const permission = document.querySelector('#permission-toggle')!
    const model = document.querySelector('#configuration-toggle')!
    for (const control of [permission, model]) {
      for (const classes of ['', 'danger', 'pending']) {
        control.classList.add(...classes.split(' ').filter(Boolean))
        const style = getComputedStyle(control)
        expect(style.borderTopWidth).toBe('0px')
        expect(style.backgroundColor).toBe('transparent')
        expect(style.borderRadius).not.toBe('999px')
        control.classList.remove(...classes.split(' ').filter(Boolean))
      }
    }
    expect(permission.querySelector('.permission-toggle-icon svg')).not.toBeNull()
    expect(permission.querySelector('.permission-toggle-chevron')).toBeNull()
    expect(model.querySelector('.configuration-toggle-chevron')).not.toBeNull()
  })

  it('has no permanent keyboard-hint footer while retaining a hidden input-error outlet', () => {
    expect(document.querySelector('#composer-dock')!.textContent).not.toContain('Enter to send')
    const feedback = document.querySelector('#composer-feedback')!
    expect(feedback.closest('.composer-shell')).not.toBeNull()
    expect(feedback.textContent).toBe('')
    expect(feedback.getAttribute('role')).toBe('alert')
    expect(getComputedStyle(feedback).display).toBe('none')
  })

  it('routes scrolling, stream following, and timeline navigation to the transcript viewport', async () => {
    for (const name of ['messages.ts', 'utils.ts', 'app.ts', 'timeline.ts']) {
      const source = await readFile(resolve(import.meta.dirname, '../src/webview/chat', name), 'utf8')
      expect(source).toContain('conversationScroll.')
      expect(source).not.toContain('.scrollTop =')
    }
    const context = await readFile(resolve(import.meta.dirname, '../src/webview/chat/context.ts'), 'utf8')
    expect(context).toContain("transcript: byId<HTMLElement>('transcript-scroll')")
    expect(context).toContain("transcriptContent: byId<HTMLElement>('transcript-content')")
    expect(context).toContain("composerDock: byId<HTMLElement>('composer-dock')")
  })
})
