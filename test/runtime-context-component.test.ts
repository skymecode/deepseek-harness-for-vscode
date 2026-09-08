// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatItem } from '../src/domain/workbench-state.js'
import { RuntimeContextInspector } from '../src/webview/runtime-context/component.js'
import { createContextNotice } from '../src/webview/runtime-context/notice.js'
import { createWebviewTranslator, localizeWebviewMessages } from '../src/webview/localization.js'

const t = createWebviewTranslator(undefined)
const context = (seq: number, text = '<system-reminder><img src=x onerror=alert(1)>raw</system-reminder>'): ChatItem => ({
  id: `context-${seq}`, seq, time: seq + 1, kind: 'context', contextSource: { kind: 'skill-catalog' }, blocks: [{ kind: 'text', text }],
})
afterEach(() => document.body.replaceChildren())

describe('runtime context inspector', () => {
  it('starts collapsed, shows exact originals as text and never injects markup', () => {
    const inspector = new RuntimeContextInspector(document, t)
    document.body.append(inspector.element)
    inspector.update('session', [context(0)])
    const row = inspector.element.querySelector('details')!
    expect(row.open).toBe(false)
    expect(row.querySelector('summary')?.textContent).toBe('Skill catalog')
    expect(row.querySelector('pre')?.textContent).toBe(context(0).blocks?.[0]?.text)
    expect(row.querySelector('img, system-reminder, script')).toBeNull()
  })

  it('preserves disclosures and keyboard focus while newer snapshots/assistant chunks arrive', () => {
    const inspector = new RuntimeContextInspector(document, t)
    document.body.append(inspector.element)
    inspector.update('session', [context(0)])
    const row = inspector.element.querySelector('details')!
    row.open = true
    const summary = row.querySelector('summary')!
    summary.focus()
    const assistant: ChatItem = { id: 'stream', seq: 2, time: 3, kind: 'message', role: 'assistant', status: 'running', blocks: [{ kind: 'text', text: 'Thinking' }] }
    inspector.update('session', [context(0), context(1), assistant])
    inspector.update('session', [context(0), context(1), { ...assistant, blocks: [{ kind: 'text', text: 'Thinking more' }] }])
    expect(inspector.element.querySelectorAll('details')).toHaveLength(2)
    expect(inspector.element.querySelector('[data-context-id="context-0"]')).toBe(row)
    expect(row.open).toBe(true)
    expect(document.activeElement).toBe(summary)
    expect(inspector.element.querySelector('details')?.dataset.contextId).toBe('context-1')
  })

  it('clears prior session content and expansion state, including when event ids are reused', () => {
    const inspector = new RuntimeContextInspector(document, t)
    inspector.update('a', [context(0, 'Old private context')])
    inspector.element.querySelector('details')!.open = true
    inspector.update('b', [context(0, 'New context')])
    expect(inspector.element.textContent).not.toContain('Old private context')
    expect(inspector.element.querySelector('details')!.open).toBe(false)
    inspector.update('blank', [])
    expect(inspector.element.querySelector('details')).toBeNull()
    expect(inspector.element.querySelector('.muted-empty')?.classList.contains('hidden')).toBe(false)
  })

  it('updates changed originals without closing them and removes unloaded records', () => {
    const inspector = new RuntimeContextInspector(document, t)
    inspector.update('a', [context(0), context(1)])
    inspector.element.querySelector('details')!.open = true
    inspector.update('a', [context(1, 'Updated context')])
    expect(inspector.element.querySelectorAll('details')).toHaveLength(1)
    expect(inspector.element.querySelector('details')!.open).toBe(true)
    expect(inspector.element.querySelector('pre')?.textContent).toBe('Updated context')
  })

  it('renders model changes in English/Chinese without exposing raw prompts or parsing HTML', () => {
    const bundle = JSON.parse(readFileSync('l10n/bundle.l10n.zh-cn.json', 'utf8')) as Record<string, string>
    const zh = createWebviewTranslator({ language: 'zh-cn', messages: localizeWebviewMessages((text) => bundle[text] ?? text) })
    expect(createContextNotice(document, { kind: 'model-change', model: 'glm-5.3-flash' }, t).textContent).toBe('Switched to glm-5.3-flash')
    expect(createContextNotice(document, { kind: 'model-change', model: 'glm-5.3-flash' }, zh).textContent).toBe('已切换至 glm-5.3-flash')
    expect(createContextNotice(document, { kind: 'model-change' }, zh).textContent).toBe('模型已切换')
    const notice = createContextNotice(document, { kind: 'summary', text: '<img src=x>notice' }, t)
    expect(notice.querySelector('img')).toBeNull()
    expect(notice.textContent).toBe('<img src=x>notice')
  })
})
