// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '../src/domain/workbench-state.js'
import { projectTurnProcesses } from '../src/domain/turn-process.js'
import { MessageReconciler } from '../src/webview/chat/message-reconciler.js'
import { TurnProcessComponent } from '../src/webview/turn-process/component.js'
import { TurnChangesController } from '../src/webview/chat/turn-changes-controller.js'
import { createSessionChangesCard } from '../src/webview/session-changes/component.js'
import { transcriptMessageElements } from '../src/webview/chat/transcript-elements.js'

afterEach(() => document.body.replaceChildren())
const assistant = (id: string, turn = 1): ChatItem => ({ id, turn, seq: 1, time: 1, kind: 'message', role: 'assistant', blocks: [{ kind: 'text', text: id }] })
const tool: ChatItem = { id: 'tool', turn: 1, seq: 2, time: 2, kind: 'tool', status: 'success', title: 'bash' }
const ended = { ...assistant('answer'), workDuration: { startedAt: 0, endedAt: 64000 } }

function fixture() {
  const root = document.createElement('div')
  document.body.append(root)
  const groups = new TurnProcessComponent(document, (key, args) => args?.duration ? `Took ${args.duration}` : key)
  const reconciler = new MessageReconciler()
  const create = vi.fn((item: ChatItem) => {
    const article = document.createElement('article')
    article.textContent = item.id
    const details = document.createElement('details')
    const summary = document.createElement('summary')
    summary.textContent = 'tool details'
    details.append(summary)
    article.append(details)
    return article
  })
  const release = vi.fn()
  const render = (items: readonly ChatItem[], running = false, session = 's1') => {
    const view = projectTurnProcesses(items, running)
    reconciler.reconcile(root, session, view.messages, { create, patch: () => true, replace: (_, item) => create(item), release, groups: groups.prepare(session, view.groups) })
  }
  return { root, create, release, render }
}

describe('per-turn process disclosure and message ownership', () => {
  it('moves completed process nodes once, preserving their own expansion state', () => {
    const f = fixture()
    f.render([assistant('thinking'), tool, assistant('answer')], true)
    const first = f.root.firstElementChild!
    first.querySelector('details')!.open = true
    f.render([assistant('thinking'), tool, ended])
    const group = f.root.querySelector<HTMLDetailsElement>('.turn-process')!
    expect(group.open).toBe(false)
    expect(group.querySelector('article')).toBe(first)
    expect(first.querySelector('details')!.open).toBe(true)
    expect(group.querySelector('summary')?.textContent).toBe('Took 1m 4s')
    expect(f.root.lastElementChild?.getAttribute('data-message-id')).toBe('answer')
    expect(f.create).toHaveBeenCalledTimes(3)
  })

  it('does not mutate or re-collapse an expanded old group when a new turn streams', () => {
    const f = fixture()
    const old = [assistant('thinking'), tool, ended]
    f.render(old)
    const group = f.root.querySelector<HTMLDetailsElement>('.turn-process')!
    group.open = true
    const observer = new MutationObserver(() => {})
    observer.observe(group, { childList: true, subtree: true, attributes: true, characterData: true })
    for (let index = 0; index < 30; index++) {
      f.render([...old, { ...assistant('new', 2), status: 'running', blocks: [{ kind: 'text', text: `New ${index}` }] }], true)
    }
    expect(observer.takeRecords()).toEqual([])
    expect(group.open).toBe(true)
    expect(f.root.querySelector('.turn-process')).toBe(group)
    observer.disconnect()
  })

  it('keeps original conclusion ids discoverable while ignoring lookalikes in Markdown', () => {
    const f = fixture()
    f.render([assistant('thinking'), tool, ended])
    const fake = document.createElement('div')
    fake.dataset.messageId = 'fake'
    f.root.querySelector('article')!.append(fake)
    expect(transcriptMessageElements(f.root).map(element => element.dataset.messageId)).toEqual(['thinking', 'tool', 'answer'])
  })

  it('keeps edit cards outside both answer and tool-only process groups', () => {
    const f = fixture()
    const cards = new TurnChangesController(() => createSessionChangesCard({ document, translate: key => key, onOpenFile: vi.fn(), onReview: vi.fn(), onUndo: vi.fn() }))
    for (const finalId of ['answer', 'tool']) {
      f.render(finalId === 'answer' ? [tool, ended] : [tool])
      cards.reconcile(f.root, 's1', [{ seq: 3, turn: 1, conclusionId: finalId, changes: { added: 1, removed: 0, files: [{ path: 'a.ts', added: 1, removed: 0 }] } }])
      expect(f.root.lastElementChild?.classList.contains('turn-changes-card')).toBe(true)
      expect(f.root.querySelector('.turn-process')?.contains(f.root.lastElementChild)).toBe(false)
    }
  })

  it('preserves a group when prepending history and clears old nodes across sessions', () => {
    const f = fixture()
    const old = [{ ...tool, turn: 2 }, { ...ended, turn: 2 }]
    f.render(old)
    const group = f.root.querySelector<HTMLDetailsElement>('.turn-process')!
    group.open = true
    f.render([{ ...tool, id: 'earlier' }, { ...ended, id: 'earlier-answer' }, ...old])
    expect(f.root.querySelectorAll('.turn-process')[1]).toBe(group)
    expect(group.open).toBe(true)
    f.render(old, false, 's2')
    expect(group.isConnected).toBe(false)
    expect(f.root.querySelector<HTMLDetailsElement>('.turn-process')!.open).toBe(false)
    expect(f.root.querySelectorAll('[data-message-id]')).toHaveLength(2)
    expect(f.release).toHaveBeenCalled()
  })

  it('can restore an unfinished process to the live transcript without losing its messages', () => {
    const f = fixture()
    const items = [assistant('thinking'), tool, assistant('answer')]
    f.render(items)
    const nodes = transcriptMessageElements(f.root)
    f.render(items, true)
    expect(f.root.querySelector('.turn-process')).toBeNull()
    expect(Array.from(f.root.children)).toEqual(nodes)
    expect(f.create).toHaveBeenCalledTimes(3)
  })
})
