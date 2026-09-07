import type { ChatItem } from '../../domain/workbench-state.js'

interface MessageRenderer {
  create(item: ChatItem): HTMLElement
  patch(element: HTMLElement, item: ChatItem): boolean
  replace(element: HTMLElement, item: ChatItem): HTMLElement
  release(element: HTMLElement): void
}

/**
 * Owns transcript node identity, independently of Markdown and scroll policy.
 * A final event reuses its partial's turn/step node. Auxiliary cards between
 * messages are skipped when checking order, so a state push never detaches
 * unchanged reasoning cards just to move edited-file cards back afterwards.
 */
export class MessageReconciler {
  private sessionId: string | undefined
  private readonly signatures = new WeakMap<HTMLElement, string>()

  reconcile(root: HTMLElement, sessionId: string, items: readonly ChatItem[], renderer: MessageRenderer): void {
    const previous = Array.from(root.children).filter(isMessageElement)
    if (this.sessionId !== sessionId) {
      for (const element of previous) {
        renderer.release(element)
        element.remove()
      }
    }
    this.sessionId = sessionId
    const existing = new Map(Array.from(root.children).filter(isMessageElement)
      .map((element) => [element.dataset.messageId!, element]))
    const incomingIds = new Set(items.map((item) => item.id))
    const partials = new Map<string, HTMLElement>()
    for (const [id, element] of existing) {
      if (!incomingIds.has(id) && element.dataset.streamKey !== undefined) {
        partials.set(element.dataset.streamKey, element)
      }
    }
    const retained = new Set<HTMLElement>()
    let cursor = nextMessageElement(root.firstElementChild)

    for (const item of items) {
      const signature = JSON.stringify(item)
      const streamKey = item.kind === 'message' && item.role === 'assistant' ? item.streamKey : undefined
      let element = existing.get(item.id) ?? (streamKey === undefined ? undefined : partials.get(streamKey))
      if (streamKey !== undefined) partials.delete(streamKey)
      if (element === undefined) {
        element = renderer.create(item)
      } else if (this.signatures.get(element) !== signature && !renderer.patch(element, item)) {
        const replacement = renderer.replace(element, item)
        if (element === cursor) cursor = replacement
        renderer.release(element)
        element.replaceWith(replacement)
        element = replacement
      }
      if (element.dataset.messageId !== item.id) element.dataset.messageId = item.id
      if (streamKey !== undefined && element.dataset.streamKey !== streamKey) element.dataset.streamKey = streamKey
      else if (streamKey === undefined && element.dataset.streamKey !== undefined) delete element.dataset.streamKey
      this.signatures.set(element, signature)
      retained.add(element)
      if (element !== cursor) root.insertBefore(element, cursor)
      cursor = nextMessageElement(element.nextElementSibling)
    }
    for (const element of existing.values()) {
      if (!retained.has(element) && element.parentElement === root) {
        renderer.release(element)
        element.remove()
      }
    }
  }
}

function isMessageElement(element: Element): element is HTMLElement {
  return element instanceof HTMLElement && element.dataset.messageId !== undefined
}

function nextMessageElement(element: Element | null): HTMLElement | null {
  while (element !== null && !isMessageElement(element)) element = element.nextElementSibling
  return element
}
