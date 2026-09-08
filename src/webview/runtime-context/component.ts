import type { ChatItem } from '../../domain/workbench-state.js'
import { runtimeContextItems } from '../../domain/transcript-context.js'
import { applyIcon, icon } from '../icons.js'
import type { createWebviewTranslator } from '../localization.js'

/** On-demand inspector with stable disclosures, independent of streaming chat DOM. */
export class RuntimeContextInspector {
  readonly element: HTMLElement
  private readonly list: HTMLElement
  private readonly empty: HTMLElement
  private sessionId: string | undefined
  private readonly rows = new Map<string, { element: HTMLDetailsElement; signature: string }>()

  constructor(private readonly document: Document, private readonly t: ReturnType<typeof createWebviewTranslator>) {
    this.element = document.createElement('section')
    this.element.className = 'runtime-context-inspector'
    this.element.setAttribute('aria-label', t('runtimeContext'))
    const hint = document.createElement('p')
    hint.className = 'runtime-context-hint'
    hint.textContent = t('runtimeContextHint')
    this.list = document.createElement('div')
    this.list.className = 'runtime-context-list'
    this.empty = document.createElement('p')
    this.empty.className = 'muted-empty'
    this.empty.textContent = t('noRuntimeContext')
    this.element.append(hint, this.list, this.empty)
  }

  update(sessionId: string, messages: readonly ChatItem[]): void {
    if (sessionId !== this.sessionId) {
      this.rows.clear()
      this.list.replaceChildren()
      this.sessionId = sessionId
    }
    const items = [...runtimeContextItems(messages)].sort((a, b) => b.seq - a.seq)
    const ids = new Set(items.map((item) => item.id))
    for (const [id, row] of this.rows) {
      if (!ids.has(id)) {
        row.element.remove()
        this.rows.delete(id)
      }
    }
    let cursor = this.list.firstElementChild
    for (const item of items) {
      const signature = JSON.stringify(item)
      let row = this.rows.get(item.id)
      if (row === undefined || signature !== row.signature) {
        const element = this.createRow(item)
        if (row !== undefined) {
          element.open = row.element.open
          if (cursor === row.element) cursor = element
          row.element.replaceWith(element)
        }
        row = { element, signature }
        this.rows.set(item.id, row)
      }
      if (row.element !== cursor) this.list.insertBefore(row.element, cursor)
      cursor = row.element.nextElementSibling
    }
    this.empty.classList.toggle('hidden', items.length > 0)
  }

  private createRow(item: ChatItem): HTMLDetailsElement {
    const row = this.document.createElement('details')
    row.className = 'runtime-context-entry'
    row.dataset.contextId = item.id
    const summary = this.document.createElement('summary')
    const glyph = this.document.createElement('span')
    applyIcon(glyph, icon('chevron'))
    const label = this.document.createElement('span')
    const source = item.contextSource
    label.textContent = source?.kind === 'skill-catalog' ? this.t('skillCatalog')
      : source?.plugin === 'model-selection' ? this.t('modelChanged')
        : source?.plugin === '@deepseek-ai/dsh-system-prompt' ? this.t('runtimeContext')
          : source?.plugin ?? item.title ?? this.t('context')
    summary.append(glyph, label)
    const body = this.document.createElement('div')
    body.className = 'runtime-context-body'
    const provenance = this.document.createElement('small')
    provenance.textContent = [source?.plugin ?? source?.kind ?? item.title, `#${item.seq}`].filter(Boolean).join(' · ')
    const pre = this.document.createElement('pre')
    // Raw context is untrusted content, not Markdown/HTML or executable instructions.
    pre.textContent = item.blocks?.map((block) => block.text).join('\n') ?? ''
    body.append(provenance, pre)
    row.append(summary, body)
    return row
  }
}
