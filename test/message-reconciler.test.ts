// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '../src/domain/workbench-state.js'
import { MessageReconciler } from '../src/webview/chat/message-reconciler.js'
import { assistant, messageBody, streamingDom } from './helpers/streaming-dom.js'

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

function transcript(tail?: HTMLElement) {
  const stream = streamingDom()
  const root = messageBody()
  const reconciler = new MessageReconciler()
  const create = (item: ChatItem): HTMLElement => {
    const article = document.createElement('article')
    const body = document.createElement('div')
    article.append(body)
    stream.component.render(body, item)
    return article
  }
  const renderer = {
    ...(tail === undefined ? {} : { tail }),
    create: vi.fn(create),
    patch: vi.fn((element: HTMLElement, item: ChatItem) => stream.component.patch(element.firstElementChild as HTMLElement, item)),
    replace: vi.fn((_element: HTMLElement, item: ChatItem) => create(item)),
    release: vi.fn((element: HTMLElement) => stream.component.dispose(element)),
  }
  return { ...stream, root, renderer, render: (items: readonly ChatItem[], session = 's1') => reconciler.reconcile(root, session, items, renderer) }
}

describe('transcript node identity', () => {
  it('inserts new messages before a persistent activity tail without detaching it', () => {
    const tail = document.createElement('div')
    const { root, render } = transcript(tail)
    root.append(tail)
    const old = assistant('old', [{ kind: 'reasoning', text: 'Previous thought' }], false)
    render([old])
    const card = document.createElement('div')
    root.firstElementChild!.after(card)
    const observer = new MutationObserver(() => {})
    observer.observe(root, { childList: true })
    const items = [old]
    for (let step = 1; step < 10; step++) {
      items.push(assistant(`step-${step}`, [{ kind: 'text', text: 'Next output' }], false, `2:${step}`))
      render(items)
      expect(root.lastElementChild).toBe(tail)
    }
    expect(observer.takeRecords().every((record) => !Array.from(record.removedNodes).includes(tail))).toBe(true)
    observer.disconnect()
    expect(root.children[1]).toBe(card)
  })

  it('ignores interleaved file-change cards instead of detaching later reasoning cards', () => {
    const { root, render, flush } = transcript()
    const old = assistant('event-2', [{ kind: 'reasoning', text: 'Old thought' }], false)
    const next = assistant('partial-2:1', [{ kind: 'reasoning', text: 'New', streaming: true }], true, '2:1')
    render([old, next])
    flush()
    const card = document.createElement('div')
    card.className = 'turn-changes-card'
    root.insertBefore(card, root.lastElementChild)
    const details = root.querySelector('details')!
    details.open = true
    const observer = new MutationObserver(() => undefined)
    observer.observe(root, { childList: true })
    for (let count = 0; count < 30; count += 1) {
      render([old, { ...next, blocks: [{ kind: 'reasoning', text: `New ${count}`, streaming: true }] }])
      flush()
      expect(root.children[1]).toBe(card)
    }
    expect(observer.takeRecords()).toEqual([])
    observer.disconnect()
    expect(details.open).toBe(true)
  })

  it('reuses the partial node at final event handoff, preserving focus, scroll and open state', () => {
    const { root, render, renderer, frames } = transcript()
    render([assistant('partial-1:1', [{ kind: 'reasoning', text: 'Live', streaming: true }])])
    const article = root.firstElementChild!
    const details = root.querySelector('details')!
    const summary = details.querySelector('summary')!
    summary.click()
    summary.tabIndex = 0
    summary.focus()
    const content = details.querySelector<HTMLElement>('.reasoning-content')!
    content.scrollTop = 30
    render([assistant('event-10', [{ kind: 'reasoning', text: 'Final' }, { kind: 'text', text: 'Answer' }], false)])
    expect(root.firstElementChild).toBe(article)
    expect(root.querySelector('details')).toBe(details)
    expect(details.open).toBe(true)
    expect(document.activeElement).toBe(summary)
    expect(content.scrollTop).toBe(30)
    expect(frames.size).toBe(0)
    expect(renderer.create).toHaveBeenCalledTimes(1)
    expect(renderer.replace).not.toHaveBeenCalled()
    expect(renderer.release).not.toHaveBeenCalled()
  })

  it('isolates identical message/stream ids across sessions and releases live animations', () => {
    const { root, render, renderer, frames } = transcript()
    const item = assistant('partial-1:1', [{ kind: 'reasoning', text: 'Live', streaming: true }])
    render([item])
    const previous = root.querySelector('details')!
    previous.open = true
    render([item], 's2')
    expect(root.querySelector('details')).not.toBe(previous)
    expect(root.querySelector('details')?.open).toBe(false)
    expect(renderer.release).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(1)
    render([], 's2')
    expect(frames.size).toBe(0)
  })

  it('inserts older history in order without replacing retained messages', () => {
    const { root, render } = transcript()
    const a = assistant('event-a', [{ kind: 'text', text: 'a' }], false, '1:1')
    const b = assistant('event-b', [{ kind: 'text', text: 'b' }], false, '2:1')
    render([b])
    const retained = root.firstElementChild
    render([a, b])
    expect(root.lastElementChild).toBe(retained)
    expect(Array.from(root.children).map((child) => (child as HTMLElement).dataset.messageId)).toEqual(['event-a', 'event-b'])
  })
})
