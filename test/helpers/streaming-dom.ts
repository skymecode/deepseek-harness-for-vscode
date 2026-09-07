import { vi } from 'vitest'
import type { ChatBlock, ChatItem } from '../../src/domain/workbench-state.js'
import { StreamingMessageComponent } from '../../src/webview/streaming-message/component.js'

/** A deterministic animation clock: tests can interleave clicks with deltas. */
export function streamingDom() {
  let nextFrame = 0
  const frames = new Map<number, FrameRequestCallback>()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const renderMarkdown = vi.fn((target: HTMLElement, source: string) => {
    const paragraph = document.createElement('p')
    paragraph.textContent = source
    target.replaceChildren(paragraph)
  })
  const onStreamFrame = vi.fn()
  const component = new StreamingMessageComponent({
    document,
    reasoningLabel: () => 'Reasoning',
    thinkingLabel: (tokens) => `Thinking ${tokens ?? 0}`,
    reasoningDoneLabel: (elapsed, tokens) => `Thought ${elapsed}ms ${tokens ?? 0}`,
    renderMarkdown,
    onStreamFrame,
  })
  return {
    component, frames, renderMarkdown, onStreamFrame,
    flush: () => {
      let ticks = 0
      while (frames.size > 0) {
        if (++ticks > 200) throw new Error('Stream animation did not settle.')
        const batch = [...frames.values()]
        frames.clear()
        for (const callback of batch) callback(ticks * 16)
      }
    },
  }
}

export function assistant(id: string, blocks: readonly ChatBlock[], running = true, streamKey = '1:1'): ChatItem {
  return { id, seq: 1, time: 100, kind: 'message', role: 'assistant', streamKey, blocks, ...(running ? { status: 'running' as const } : {}) }
}

export function messageBody(): HTMLElement {
  const body = document.createElement('div')
  body.className = 'message-body'
  document.body.append(body)
  return body
}
