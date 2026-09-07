import type { TurnChangesView } from '../../domain/turn-changes.js'
import type { SessionChangesCard } from '../session-changes/component.js'

/** Owns turn-card identity and placement; message rendering stays independent. */
export class TurnChangesController {
  private sessionId: string | undefined
  private views: readonly TurnChangesView[] = []
  private readonly cards = new Map<number, SessionChangesCard>()

  constructor(private readonly createCard: () => SessionChangesCard) {}

  reconcile(root: HTMLElement, sessionId: string, views: readonly TurnChangesView[] | undefined): void {
    if (this.sessionId !== sessionId) {
      for (const card of this.cards.values()) card.element.remove()
      this.cards.clear()
      this.views = []
      this.sessionId = sessionId
    }
    // Undefined is a transient payload; [] is an authoritative empty history.
    if (views !== undefined) this.views = views
    const retained = new Set(this.views.map((view) => view.turn))
    for (const [turn, card] of this.cards) {
      if (retained.has(turn)) continue
      card.element.remove()
      this.cards.delete(turn)
    }
    const anchors = new Map(Array.from(root.children).flatMap((element) =>
      element instanceof HTMLElement && element.dataset.messageId !== undefined
        ? [[element.dataset.messageId, element] as const] : []))
    for (const view of this.views) {
      const anchor = anchors.get(view.conclusionId)
      let card = this.cards.get(view.turn)
      if (anchor === undefined) {
        // Unloaded/removed history has no safe position. In particular, never
        // use the last assistant as a fallback: it may be a live reasoning step.
        card?.element.remove()
        continue
      }
      if (card === undefined) {
        card = this.createCard()
        card.element.dataset.turn = String(view.turn)
        this.cards.set(view.turn, card)
      }
      card.update(view.changes)
      if (anchor.nextElementSibling !== card.element) anchor.after(card.element)
    }
  }
}
