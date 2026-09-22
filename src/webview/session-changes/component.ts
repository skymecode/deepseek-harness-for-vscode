import type { SessionChangesView, SessionFileChangeView } from '../../domain/session-changes.js'
import type { MessageArguments, WebviewMessageKey } from '../localization.js'

type Translate = (key: WebviewMessageKey, args?: MessageArguments) => string

export interface SessionChangesComponent {
  readonly update: (changes: SessionChangesView | undefined) => void
}

interface ComponentOptions {
  readonly document: Document
  readonly translate: Translate
  readonly onOpenFile: (path: string) => void
  readonly onReview: (changes?: SessionChangesView, index?: number) => void
}

/** Files listed before the "show N more" fold. */
const VISIBLE_FILE_LIMIT = 3

/** One self-contained "edited files" card bound to a turn's changes view. */
export interface SessionChangesCard {
  readonly element: HTMLElement
  update: (changes: SessionChangesView | undefined) => void
}

/**
 * New-style "edited files" card for one finished turn: rendered inline in the
 * message stream below that turn's conclusion. Each turn owns one card via
 * {@link createSessionChangesCard}, so previous turns' cards stay in place
 * instead of being replaced by the newest turn. The signature cache keeps
 * streamed state updates from rebuilding the DOM when nothing changed.
 */
export function createSessionChangesCard(options: ComponentOptions): SessionChangesCard {
  const root = node(options.document, 'div', 'changes-bar turn-changes-card hidden')
  let current: SessionChangesView | undefined
  let signature = ''
  let showAll = false

  const stats = (added: number, removed: number): HTMLElement[] => [
    node(options.document, 'span', 'changes-added', `+${added}`),
    node(options.document, 'span', 'changes-removed', `−${removed}`),
  ]

  const render = (): void => {
    root.textContent = ''
    if (current === undefined) return
    const card = node(options.document, 'div', 'changes-top')
    const summary = node(options.document, 'button', 'changes-summary') as HTMLButtonElement
    summary.type = 'button'
    summary.setAttribute('aria-expanded', String(showAll))
    const fileIcon = node(options.document, 'span', 'changes-file-icon-badge')
    fileIcon.innerHTML = changesFileSvg()
    const title = node(options.document, 'span', 'changes-count',
      `${current.files.length} ${options.translate('changesEdited')}`)
    summary.append(
      fileIcon,
      title,
      ...stats(current.added, current.removed),
    )
    summary.addEventListener('click', () => {
      showAll = !showAll
      render()
    })
    card.append(summary)
    const actions = node(options.document, 'div', 'changes-actions')
    const review = node(options.document, 'button', 'changes-review', options.translate('changesReview')) as HTMLButtonElement
    review.type = 'button'
    review.addEventListener('click', () => options.onReview(current))
    actions.append(review)
    card.append(actions)
    root.append(card)
    if (!current.official) root.append(node(options.document, 'p', 'changes-detail-header', options.translate('historicalChangesLimited')))

    // File list: always inline, folded past the visible limit.
    const detail = node(options.document, 'div', 'changes-detail')
    detail.append(node(options.document, 'div', 'changes-detail-header',
      `${current.files.length} ${options.translate('changesFiles')}`))
    const visible = showAll ? current.files : current.files.slice(0, VISIBLE_FILE_LIMIT)
    for (const file of visible) detail.append(fileRow({ ...options, onOpenFile: (path) => current?.official ? options.onReview(current, file.index) : options.onOpenFile(path) }, file))
    if (!showAll && current.files.length > VISIBLE_FILE_LIMIT) {
      const more = node(options.document, 'button', 'changes-more', `${options.translate('changesShowMore')} ${current.files.length - VISIBLE_FILE_LIMIT} ${options.translate('changesFiles')}`) as HTMLButtonElement
      more.type = 'button'
      more.setAttribute('aria-expanded', 'false')
      more.addEventListener('click', () => {
        showAll = true
        render()
      })
      detail.append(more)
    }
    root.append(detail)
  }

  return {
    element: root,
    update: (changes) => {
      const nextSignature = JSON.stringify(changes ?? null)
      if (nextSignature === signature) return
      signature = nextSignature
      current = changes ?? undefined
      if (current === undefined) {
        showAll = false
        root.classList.add('hidden')
        return
      }
      root.classList.remove('hidden')
      render()
    },
  }
}

function changesFileSvg(): string {
  return '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true"><path d="M3 2.5h6l3 3v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 2.5v3h3" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 9.5V12.5M6.5 11h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
}

function fileRow(options: ComponentOptions, file: SessionFileChangeView): HTMLElement {
  const row = node(options.document, 'div', 'changes-file')
  row.setAttribute('role', 'link')
  row.tabIndex = 0
  row.title = file.path
  const basename = file.path.split(/[\\/]/u).pop() ?? file.path
  row.append(
    node(options.document, 'span', 'changes-file-icon', fileExtension(basename)),
    node(options.document, 'span', 'changes-file-path', file.path),
    node(options.document, 'span', 'changes-added', `+${file.added}`),
    node(options.document, 'span', 'changes-removed', `−${file.removed}`),
  )
  const open = (): void => options.onOpenFile(file.path)
  row.addEventListener('click', open)
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      open()
    }
  })
  return row
}

function fileExtension(basename: string): string {
  const dot = basename.lastIndexOf('.')
  return dot <= 0 ? '·' : basename.slice(dot + 1).slice(0, 4)
}

function node(document: Document, tag: string, className = '', text = ''): HTMLElement {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text) element.textContent = text
  return element
}
