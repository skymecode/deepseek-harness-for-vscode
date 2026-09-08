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
  styles.textContent = (await Promise.all(['chat.css', 'chat-responsive.css'].map((name) =>
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
    expect(dock.contains(document.querySelector('#composer-hint')!)).toBe(true)
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

  it('removes the redundant running row entirely while retaining the send/stop control', async () => {
    expect(document.querySelector('#activity-status, #activity-retry, .activity-star')).toBeNull()
    expect(document.querySelector('#send')?.closest('.composer-shell')).not.toBeNull()
    const context = await readFile(resolve(import.meta.dirname, '../src/webview/chat/context.ts'), 'utf8')
    expect(context).not.toContain("byId<HTMLElement>('activity-status')")
    expect(context).not.toContain("byId<HTMLElement>('activity-retry')")
  })

  it('retains the composer as the positioning context for its menus', () => {
    for (const selector of ['#configuration-panel', '#command-menu', '#file-mention-menu', '#timeline-panel']) {
      expect(document.querySelector(selector)?.parentElement?.classList.contains('composer-shell')).toBe(true)
    }
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
