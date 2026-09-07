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
  it('keeps conversation, details, and approvals in the scroll viewport, outside the composer', () => {
    const transcript = document.querySelector('#transcript-scroll')!
    const composer = document.querySelector('.composer-shell')!
    for (const selector of ['#conversation', '#details', '#interactions']) {
      expect(transcript.contains(document.querySelector(selector)!)).toBe(true)
    }
    expect(transcript.contains(composer)).toBe(false)
    expect(transcript.parentElement).toBe(composer.parentElement)
    expect(getComputedStyle(transcript).overflowY).toBe('auto')
    expect(getComputedStyle(document.querySelector('#chat')!).overflow).toBe('hidden')
    expect(getComputedStyle(composer).position).toBe('relative')
  })

  it('contains the compact activity row and long retry labels inside the input shell', () => {
    const activity = document.querySelector('#activity-status')!
    const retry = document.querySelector('#activity-retry')!
    expect(activity.closest('.composer-shell')).not.toBeNull()
    activity.classList.remove('hidden')
    retry.classList.remove('hidden')
    retry.textContent = 'Model request timed out, retrying. '.repeat(30)
    expect(getComputedStyle(activity).height).toBe('26px')
    expect(getComputedStyle(activity).overflow).toBe('hidden')
    expect(getComputedStyle(retry).textOverflow).toBe('ellipsis')
    expect(getComputedStyle(retry).whiteSpace).toBe('nowrap')
  })

  it('retains the composer as the positioning context for its menus', () => {
    for (const selector of ['#configuration-panel', '#command-menu', '#file-mention-menu', '#timeline-panel']) {
      expect(document.querySelector(selector)?.parentElement?.classList.contains('composer-shell')).toBe(true)
    }
  })

  it('routes scrolling, stream following, and timeline navigation to the transcript viewport', async () => {
    for (const name of ['messages.ts', 'utils.ts', 'main.ts', 'timeline.ts']) {
      const source = await readFile(resolve(import.meta.dirname, '../src/webview/chat', name), 'utf8')
      expect(source).toContain('elements.transcript')
      expect(source).not.toContain('elements.chat')
    }
    const context = await readFile(resolve(import.meta.dirname, '../src/webview/chat/context.ts'), 'utf8')
    expect(context).toContain("transcript: byId<HTMLElement>('transcript-scroll')")
  })
})
