// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '../src/domain/workbench-state.js'
import type { TurnChangesView } from '../src/domain/turn-changes.js'
import { MessageReconciler } from '../src/webview/chat/message-reconciler.js'
import { TurnChangesController } from '../src/webview/chat/turn-changes-controller.js'
import { createSessionChangesCard } from '../src/webview/session-changes/component.js'

afterEach(() => document.body.replaceChildren())

function message(id: string, role: 'assistant' | 'user' = 'assistant', kind: ChatItem['kind'] = 'message'): ChatItem {
  return { id, seq: 1, time: 1, kind, role, blocks: [{ kind: 'text', text: id }] }
}

function card(turn: number, conclusionId: string): TurnChangesView {
  return { turn, seq: turn * 10, conclusionId, changes: {
    added: 4, removed: 0,
    files: [1, 2, 3, 4].map((file) => ({ path: `${turn}/${file}.ts`, added: 1, removed: 0 })),
  } }
}

function transcript() {
  const root = document.createElement('div')
  document.body.append(root)
  const messages = new MessageReconciler()
  const factory = vi.fn(() => createSessionChangesCard({
    document, translate: (key) => key, onOpenFile: vi.fn(), onReview: vi.fn(), onUndo: vi.fn(),
  }))
  const cards = new TurnChangesController(factory)
  const create = (item: ChatItem) => {
    const element = document.createElement('article')
    element.className = item.kind === 'tool' ? 'tool-item' : `message ${item.role}`
    element.textContent = item.id
    return element
  }
  return {
    root, factory,
    order: () => Array.from(root.children).map((element) => {
      const item = element as HTMLElement
      return item.dataset.messageId ?? `card-${item.dataset.turn}`
    }),
    render: (items: readonly ChatItem[], views: readonly TurnChangesView[] | undefined, session = 's1') => {
      messages.reconcile(root, session, items, { create, patch: () => true, replace: (_, item) => create(item), release: () => undefined })
      cards.reconcile(root, session, views)
    },
  }
}

describe('turn card placement during resumed conversations', () => {
  it('keeps each old card before the new user, reasoning, and tool messages', () => {
    const view = transcript()
    const history = [message('event-15'), message('event-35')]
    const cards = [card(1, 'event-15'), card(2, 'event-35')]
    view.render(history, cards)
    const nodes = Array.from(view.root.children)
    const continued = [...history, message('optimistic-user', 'user'), message('partial-3:1')]
    view.render(continued, cards)
    view.render([...continued, message('tool-new', 'assistant', 'tool')], cards)
    expect(view.order()).toEqual(['event-15', 'card-1', 'event-35', 'card-2', 'optimistic-user', 'partial-3:1', 'tool-new'])
    expect(Array.from(view.root.children).slice(0, 4)).toEqual(nodes)
  })

  it('never falls back to a live answer when an old anchor is absent', () => {
    const view = transcript()
    view.render([message('partial-3:1'), message('tool-new', 'assistant', 'tool')], [card(1, 'event-999')])
    expect(view.order()).toEqual(['partial-3:1', 'tool-new'])
    expect(view.factory).not.toHaveBeenCalled()
  })

  it('restores cards at their original positions when older messages load', () => {
    const view = transcript()
    const cards = [card(1, 'event-15'), card(2, 'event-35')]
    view.render([message('event-35')], cards)
    const retained = view.root.lastElementChild
    view.render([message('event-15'), message('event-35')], cards)
    expect(view.order()).toEqual(['event-15', 'card-1', 'event-35', 'card-2'])
    expect(view.root.lastElementChild).toBe(retained)
  })

  it('does not move or rebuild expanded old cards on repeated stream updates', () => {
    const view = transcript()
    const cards = [card(1, 'event-15')]
    const items = [message('event-15'), message('partial-2:1')]
    view.render(items, cards)
    view.root.querySelector<HTMLButtonElement>('.changes-more')!.click()
    const observer = new MutationObserver(() => undefined)
    observer.observe(view.root, { childList: true, subtree: true })
    for (let index = 0; index < 30; index++) view.render(items, cards)
    expect(observer.takeRecords()).toEqual([])
    expect(view.root.querySelectorAll('.changes-file')).toHaveLength(4)
    observer.disconnect()
  })

  it('clears authoritative empty cards and isolates identical turn ids across sessions', () => {
    const view = transcript()
    const items = [message('event-15')]
    const cards = [card(1, 'event-15')]
    view.render(items, cards)
    const old = view.root.lastElementChild
    view.render(items, undefined)
    expect(view.root.lastElementChild).toBe(old)
    view.render(items, cards, 's2')
    expect(view.root.lastElementChild).not.toBe(old)
    view.render(items, [], 's2')
    expect(view.order()).toEqual(['event-15'])
  })

  it('can attach a card to the final tool or interrupted-turn notice', () => {
    const view = transcript()
    view.render([message('tool-last', 'assistant', 'tool')], [card(1, 'tool-last')])
    expect(view.order()).toEqual(['tool-last', 'card-1'])
  })
})
