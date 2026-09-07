// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createToolCardHeader } from '../src/webview/tool-card/header.js'

describe('tool card header', () => {
  it.each(['running', 'success', 'error'] as const)('separates %s status from the tool glyph and keeps an explicit disclosure control', (status) => {
    const header = createToolCardHeader(document, { title: 'Bash', glyph: 'terminal', status, preview: 'npm test' })
    expect(header.tagName).toBe('SUMMARY')
    expect(Array.from(header.children).map((child) => child.className)).toEqual([
      'tool-status', 'tool-glyph', 'tool-title', 'tool-preview', 'tool-chevron',
    ])
    expect(header.querySelectorAll('svg')).toHaveLength(3)
    for (const svg of Array.from(header.querySelectorAll('svg'))) {
      expect(svg.getAttribute('aria-hidden')).toBe('true')
      expect(svg.getAttribute('stroke')).toBe('currentColor')
    }
    expect(header.querySelector<HTMLElement>('.tool-preview')?.title).toBe('npm test')
  })

  it('treats tool names and arguments as text, retaining full labels for narrow cards', () => {
    const title = '<img src=x onerror=alert(1)>'
    const preview = '<script>unsafe()</script>'
    const header = createToolCardHeader(document, { title, preview, glyph: 'tool', status: 'success' })
    expect(header.querySelector('img,script')).toBeNull()
    expect(header.querySelector<HTMLElement>('.tool-title')?.title).toBe(title)
    expect(header.querySelector<HTMLElement>('.tool-preview')?.title).toBe(preview)
  })
})
