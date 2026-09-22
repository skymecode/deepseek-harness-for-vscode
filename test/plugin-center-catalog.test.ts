import { afterEach, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import type { Uri, Webview } from 'vscode'
import { BuiltinDshPluginSource } from '../src/plugins/builtin-plugin-source.js'
import { mergePluginCatalog } from '../src/plugins/plugin-catalog.js'
import { workbenchHtml } from '../src/ui/workbench/view-html.js'
import { createWebviewTranslator } from '../src/webview/localization.js'
import { createPluginCenterComponent } from '../src/webview/plugin-center/component.js'

vi.mock('vscode', () => ({
  env: { language: 'en' },
  l10n: { t: (message: string) => message },
  Uri: { joinPath: (...parts: string[]) => parts.join('/') },
}))

const window = new Window()
const document = window.document as unknown as Document
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals() })

function fixture() {
  for (const type of ['HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLFormElement'] as const) vi.stubGlobal(type, window[type])
  const html = workbenchHtml({ asWebviewUri: (uri: string) => uri, cspSource: 'test' } as unknown as Webview, 'test' as unknown as Uri)
  document.body.innerHTML = new window.DOMParser().parseFromString(html, 'text/html').body.innerHTML
  const onLoad = vi.fn()
  const component = createPluginCenterComponent({
    document, translate: createWebviewTranslator(undefined), onLoad,
    onOpen: vi.fn(), onInstall: vi.fn(), onRemove: vi.fn(), onOpenExternal: vi.fn(),
  })
  return { component, onLoad }
}

it('shows an unavailable GitHub total and retries a degraded catalog when reopened', async () => {
  const f = fixture()
  const catalog = mergePluginCatalog([await new BuiltinDshPluginSource().load('en')])
  f.component.open()
  f.component.update({
    catalog: { ...catalog, sourceIssues: [{ source: 'github-topic', message: 'timeout', usingCache: false }] },
    installed: [], busy: false, error: 'Could not load GitHub Topic: timeout',
  })
  expect(document.getElementById('plugin-summary')?.textContent).toBe('Showing 3 of 3 loaded · GitHub Topic count unavailable')
  expect(document.getElementById('plugin-status')?.classList.contains('hidden')).toBe(false)
  f.component.close()
  f.component.open()
  expect(f.onLoad).toHaveBeenCalledTimes(2)

  f.component.update({ catalog: { ...catalog, topicRepositoryCount: 3200 }, installed: [], busy: false })
  expect(document.getElementById('plugin-summary')?.textContent).not.toContain('unavailable')
  expect(document.getElementById('plugin-summary')?.textContent).toContain('3200')
  expect(document.getElementById('plugin-status')?.classList.contains('hidden')).toBe(true)
  f.component.close()
  f.component.open()
  expect(f.onLoad).toHaveBeenCalledTimes(2)
  document.getElementById('plugin-refresh')?.click()
  expect(f.onLoad).toHaveBeenLastCalledWith(true)
})
