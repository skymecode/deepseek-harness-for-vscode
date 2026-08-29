import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const responsiveCssPath = new URL('../media/chat-responsive.css', import.meta.url)
const providerPath = new URL('../src/ui/workbench-view-provider.ts', import.meta.url)

describe('responsive workbench layout', () => {
  it('loads the responsive stylesheet after the component stylesheet', async () => {
    const provider = await readFile(providerPath, 'utf8')
    const componentLink = provider.indexOf('<link rel="stylesheet" href="${style}">')
    const responsiveLink = provider.indexOf('<link rel="stylesheet" href="${responsiveStyle}">')

    expect(componentLink).toBeGreaterThan(-1)
    expect(responsiveLink).toBeGreaterThan(componentLink)
  })

  it('allows the root grid and primary workbench boundaries to shrink', async () => {
    const css = await readFile(responsiveCssPath, 'utf8')

    expect(css).toMatch(/body\s*{\s*grid-template-columns:\s*minmax\(0, 1fr\)/)
    expect(css).toContain('.workbench,')
    expect(css).toContain('.composer-bar,')
    expect(css).toMatch(/min-width:\s*0;\s*max-width:\s*100%/)
  })

  it('keeps the composer controls on one row in a narrow VS Code side bar', async () => {
    const css = await readFile(responsiveCssPath, 'utf8')

    expect(css).toContain('@media (max-width: 680px)')
    expect(css).toContain('@media (max-width: 360px)')
    expect(css).toMatch(/grid-template-areas:\s*'tools meta actions'/)
    expect(css).toMatch(/\.permission-toggle\s*{[^}]*min-width:\s*88px/s)
  })
})
