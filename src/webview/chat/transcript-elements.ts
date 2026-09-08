/** Only owned, direct transcript nodes; never inspect arbitrary Markdown HTML. */
export function transcriptMessageElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.children).flatMap((element) => {
    if (!(element instanceof HTMLElement)) return []
    if (element.dataset.messageId !== undefined) return [element]
    if (!element.classList.contains('turn-process')) return []
    const content = Array.from(element.children).find((child) => child.classList.contains('turn-process-content'))
    return Array.from(content?.children ?? []).filter((child): child is HTMLElement => child instanceof HTMLElement && child.dataset.messageId !== undefined)
  })
}
