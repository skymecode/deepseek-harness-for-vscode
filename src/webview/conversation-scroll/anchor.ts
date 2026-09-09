/** A reading anchor survives wrapping; a raw scrollTop cannot. */
export interface ReadingAnchor {
  readonly element: HTMLElement
  readonly top: number
  readonly height: number
  readonly textRange?: Range
  readonly textTop?: number
}

// Include reasoning/tool markdown as well as replies: an expanded historical
// card is a reading surface too. The content root never contains the composer.
const READING_BLOCKS = '.message-label, p, li, pre, summary, .work-duration, .turn-changes-card, .notice, .interaction-card, .detail-tabs'

export function captureReadingAnchor(viewport: HTMLElement, content: HTMLElement, preferred?: HTMLElement): ReadingAnchor | undefined {
  const viewportRect = viewport.getBoundingClientRect()
  // A disclosure is an explicit reading target. Anchor its header as a block,
  // not its changing preview text or an unrelated paragraph above the click.
  if (preferred && content.contains(preferred) && visibleReadingBounds(viewport, preferred)) {
    const rect = preferred.getBoundingClientRect()
    return { element: preferred, top: rect.top - viewportRect.top, height: rect.height }
  }
  for (const element of Array.from(content.querySelectorAll<HTMLElement>(READING_BLOCKS))) {
    const visible = visibleReadingBounds(viewport, element)
    if (!visible) continue
    const rect = element.getBoundingClientRect()
    // Keep a character at the top of the reading area when resizing a long
    // paragraph. Range geometry follows that character across line wrapping.
    const document = element.ownerDocument
    const range = document.caretRangeFromPoint?.(
      Math.max(viewportRect.left + 2, rect.left + 2),
      Math.min(visible.bottom - 1, visible.top + 2),
    )
    if (range && range.startContainer.nodeType === 3 && element.contains(range.startContainer)) {
      const text = range.startContainer as Text
      if (range.startOffset < text.length) {
        range.setEnd(text, range.startOffset + 1)
        return { element, top: rect.top - viewportRect.top, height: rect.height,
          textRange: range, textTop: range.getBoundingClientRect().top - viewportRect.top }
      }
    }
    return { element, top: rect.top - viewportRect.top, height: rect.height }
  }
  return undefined
}

/** Scroll delta that restores the same text/block at the same screen height. */
export function readingAnchorDelta(viewport: HTMLElement, anchor: ReadingAnchor): number {
  if (!viewport.contains(anchor.element)) return 0
  const top = viewport.getBoundingClientRect().top
  // Finishing a turn folds its process. If the reader was inside it, anchor
  // to the remaining disclosure header rather than invisible child geometry.
  const header = hiddenDisclosureHeader(anchor.element)
  if (header && header !== anchor.element) return header.getBoundingClientRect().top - top - Math.max(0, anchor.top)
  if (anchor.textRange && anchor.textTop !== undefined && anchor.element.contains(anchor.textRange.startContainer)) {
    const rect = anchor.textRange.getBoundingClientRect()
    if (rect.height > 0) return rect.top - top - anchor.textTop
  }
  const rect = anchor.element.getBoundingClientRect()
  // For non-text blocks, preserve the relative offset if the reader is in
  // the middle of a tall card, and the exact top offset otherwise.
  const offset = anchor.top < 0 && anchor.height > 0 ? anchor.top * rect.height / anchor.height : anchor.top
  return rect.top - top - offset
}

/** A nested summary is still hidden when an outer process/card is closed. */
function hiddenDisclosureHeader(element: HTMLElement): HTMLElement | undefined {
  let header: HTMLElement | undefined
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName !== 'DETAILS' || parent.hasAttribute('open')) continue
    const summary = parent.querySelector<HTMLElement>(':scope > summary')
    if (summary && !summary.contains(element)) header = summary
  }
  return header
}

/** Layout boxes can intersect the viewport while clipped out of an old card. */
function visibleReadingBounds(viewport: HTMLElement, element: HTMLElement): { top: number; bottom: number } | undefined {
  if (hiddenDisclosureHeader(element)) return undefined
  const rect = element.getBoundingClientRect()
  const viewportRect = viewport.getBoundingClientRect()
  let top = Math.max(rect.top, viewportRect.top)
  let bottom = Math.min(rect.bottom, viewportRect.bottom)
  if (bottom <= top + 1) return undefined
  for (let parent = element.parentElement; parent && parent !== viewport; parent = parent.parentElement) {
    if (!['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(parent).overflowY)) continue
    const clip = parent.getBoundingClientRect()
    top = Math.max(top, clip.top)
    bottom = Math.min(bottom, clip.bottom)
    if (bottom <= top + 1) return undefined
  }
  return { top, bottom }
}
