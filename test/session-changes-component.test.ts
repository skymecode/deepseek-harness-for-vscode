// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { createSessionChangesCard } from '../src/webview/session-changes/component.js'
import { createWebviewTranslator } from '../src/webview/localization.js'
import { officialChangesView } from '../src/gateway/workspace-changes.js'

describe('native changes card', () => {
  it('renders native totals and labels, and reviews the original file index with keyboard or mouse', () => {
    const onReview = vi.fn()
    const card = createSessionChangesCard({ document, translate: createWebviewTranslator(), onReview })
    const changes = officialChangesView('session', 42, { turn: 1, total: 501, added: 900, deleted: 4, files: [
      { path: 'C:\\Users\\test\\binary.png', display: '~/binary.png', added: 0, deleted: 0, binary: true },
      { path: 'large.txt', display: 'large.txt', added: 0, deleted: 0, oversized: true },
      { path: 'src/a.ts', display: 'src/a.ts', added: 3, deleted: 1 },
      { path: 'src/b.ts', display: 'src/b.ts', added: 1, deleted: 2 },
    ] })
    card.update(changes)
    expect(card.element.textContent).toContain('501 files edited')
    expect(card.element.textContent).toContain('4 of 501 files listed (limit reached)')
    const rows = card.element.querySelectorAll<HTMLElement>('.changes-file')
    expect(rows[0]?.textContent).toContain('~/binary.png')
    expect(rows[0]?.textContent).toContain('Binary')
    expect(rows[1]?.textContent).toContain('Too large')
    expect(rows[0]?.querySelector('.changes-added')).toBeNull()
    rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onReview).toHaveBeenLastCalledWith(changes, 0)
    card.element.querySelector<HTMLButtonElement>('.changes-more')!.click()
    card.element.querySelectorAll<HTMLElement>('.changes-file')[3]!.click()
    expect(onReview).toHaveBeenLastCalledWith(changes, 3)
    card.element.querySelector<HTMLButtonElement>('.changes-review')!.click()
    expect(onReview).toHaveBeenLastCalledWith(changes)
    card.update(undefined)
    expect(card.element.classList.contains('hidden')).toBe(true)
  })
})
