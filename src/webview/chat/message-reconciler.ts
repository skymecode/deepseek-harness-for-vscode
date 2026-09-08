import type { ChatItem } from '../../domain/workbench-state.js'

export interface MessageGroup {
  readonly element: HTMLElement
  readonly content: HTMLElement
  readonly messageIds: readonly string[]
}

interface MessageRenderer {
  /** Optional stable trailing UI; new messages insert before it without moving it. */
  readonly tail?: HTMLElement
  readonly groups?: readonly MessageGroup[]
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
  private groups: readonly MessageGroup[] = []

  reconcile(root: HTMLElement, sessionId: string, items: readonly ChatItem[], renderer: MessageRenderer): void {
    const previous = [root, ...this.groups.map((group) => group.content)]
      .flatMap((parent) => Array.from(parent.children).filter(isMessageElement))
    if (this.sessionId !== sessionId) {
      for (const element of previous) {
        renderer.release(element)
        element.remove()
      }
      for (const group of this.groups) group.element.remove()
    }
    const existing = new Map((this.sessionId === sessionId ? previous : [])
      .map((element) => [element.dataset.messageId!, element]))
    this.sessionId = sessionId
    const groups = renderer.groups ?? []
    const membership = new Map(groups.flatMap((group) => group.messageIds.map((id) => [id, group] as const)))
    const rootOrder: HTMLElement[] = []
    const groupOrder = new Map<MessageGroup, HTMLElement[]>()
    const incomingIds = new Set(items.map((item) => item.id))
    const partials = new Map<string, HTMLElement>()
    for (const [id, element] of existing) {
      if (!incomingIds.has(id) && element.dataset.streamKey !== undefined) {
        partials.set(element.dataset.streamKey, element)
      }
    }
    const retained = new Set<HTMLElement>()

    for (const item of items) {
      const signature = JSON.stringify(item)
      const streamKey = item.kind === 'message' && item.role === 'assistant' ? item.streamKey : undefined
      let element = existing.get(item.id) ?? (streamKey === undefined ? undefined : partials.get(streamKey))
      if (streamKey !== undefined) partials.delete(streamKey)
      if (element === undefined) {
        element = renderer.create(item)
      } else if (this.signatures.get(element) !== signature && !renderer.patch(element, item)) {
        const replacement = renderer.replace(element, item)
        renderer.release(element)
        element.replaceWith(replacement)
        element = replacement
      }
      if (element.dataset.messageId !== item.id) element.dataset.messageId = item.id
      if (streamKey !== undefined && element.dataset.streamKey !== streamKey) element.dataset.streamKey = streamKey
      else if (streamKey === undefined && element.dataset.streamKey !== undefined) delete element.dataset.streamKey
      this.signatures.set(element, signature)
      retained.add(element)
      const group = membership.get(item.id)
      if (group === undefined) rootOrder.push(element)
      else {
        if (!groupOrder.has(group)) {
          rootOrder.push(group.element)
          groupOrder.set(group, [])
        }
        groupOrder.get(group)!.push(element)
      }
    }
    // Move live nodes into their finished process exactly once. Subsequent
    // stream frames reconcile directly in that container, never unwrap/rewrap.
    const ownedGroups = new Set([...this.groups, ...groups].map((group) => group.element))
    placeInOrder(root, rootOrder, ownedGroups, renderer.tail)
    for (const [group, order] of groupOrder) placeInOrder(group.content, order, ownedGroups)
    for (const element of existing.values()) {
      if (!retained.has(element)) {
        renderer.release(element)
        element.remove()
      }
    }
    const retainedGroups = new Set(groups.map((group) => group.element))
    for (const group of this.groups) if (!retainedGroups.has(group.element)) group.element.remove()
    this.groups = groups
  }
}

function isMessageElement(element: Element): element is HTMLElement {
  return element instanceof HTMLElement && element.dataset.messageId !== undefined
}

function placeInOrder(parent: HTMLElement, order: readonly HTMLElement[], groups: ReadonlySet<HTMLElement>, tail?: HTMLElement): void {
  const next = (element: Element | null): Element | null => {
    while (element !== null && !isMessageElement(element) && !groups.has(element as HTMLElement)) element = element.nextElementSibling
    return element
  }
  let cursor = next(parent.firstElementChild)
  for (const element of order) {
    if (element !== cursor) parent.insertBefore(element, cursor ?? (tail?.parentElement === parent ? tail : null))
    cursor = next(element.nextElementSibling)
  }
}
