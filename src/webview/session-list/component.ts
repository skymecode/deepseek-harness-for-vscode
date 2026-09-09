import type { SessionListItem } from '../../domain/workbench-state.js'
import { applyIcon, icon } from '../icons.js'
import type { MessageArguments, WebviewMessageKey } from '../localization.js'

type SessionAction = 'selectSession' | 'toggleSessionPin' | 'editSessionTags' | 'archiveSession' | 'restoreSession' | 'worktreeAction'

interface SessionRow {
  readonly element: HTMLElement
  update(session: SessionListItem, active: boolean, archived: boolean, snippet: string): void
}

interface SessionListState {
  readonly activeId: string | undefined
  readonly archived: boolean
  readonly snippets: ReadonlyMap<string, string>
  readonly emptyMessage: string
}

/** Keep buttons mounted between pointerdown and click while replies stream. */
export class SessionListComponent {
  private readonly rows = new Map<string, SessionRow>()
  private readonly empty: HTMLElement

  constructor(private readonly options: {
    readonly element: HTMLElement
    readonly translate: (key: WebviewMessageKey, args?: MessageArguments) => string
    readonly formatTime: (time: number) => string
    readonly onAction: (action: SessionAction, sessionId: string) => void
  }) {
    this.empty = this.node('p', 'muted-empty')
  }

  update(sessions: readonly SessionListItem[], state: SessionListState): void {
    const ids = new Set(sessions.map(session => session.id))
    for (const [id, row] of this.rows) {
      if (ids.has(id)) continue
      row.element.remove()
      this.rows.delete(id)
    }
    if (sessions.length === 0) {
      setText(this.empty, state.emptyMessage)
      if (this.empty.parentElement !== this.options.element) this.options.element.append(this.empty)
      return
    }
    this.empty.remove()
    let cursor = this.options.element.firstElementChild
    for (const session of sessions) {
      let row = this.rows.get(session.id)
      if (!row) {
        row = this.createRow(session.id)
        this.rows.set(session.id, row)
      }
      row.update(session, session.id === state.activeId, state.archived, state.snippets.get(session.id) ?? '')
      // Even moving an existing node into a fragment detaches the pressed
      // target. Leave rows in place unless the actual list order changed.
      if (row.element !== cursor) this.options.element.insertBefore(row.element, cursor)
      cursor = row.element.nextElementSibling
    }
  }

  private createRow(sessionId: string): SessionRow {
    const { translate: t, onAction, formatTime } = this.options
    const wrap = this.node('div', 'session-row-wrap')
    wrap.dataset.sessionId = sessionId
    const button = this.node('button', 'session-row has-archive-action')
    button.type = 'button'
    const top = this.node('span', 'session-row-top')
    const name = this.node('span', 'session-name')
    const running = this.node('span', 'running-dot')
    const mark = this.node('span', 'session-mark')
    applyIcon(mark, icon('pin', 10))
    top.append(name, running, mark)
    const meta = this.node('span', 'session-meta')
    const shared = this.node('span', 'session-tag shared', t('sharedWorkspaceTag'))
    shared.title = t('sharedWorkspaceHint')
    shared.setAttribute('aria-label', shared.title)
    const tags = this.node('span', 'session-tags')
    const snippet = this.node('span', 'session-snippet')
    button.append(top, meta, shared, tags, snippet)
    button.addEventListener('click', () => onAction('selectSession', sessionId))
    const actions = this.node('div', 'session-row-actions')
    const pin = this.action(() => onAction('toggleSessionPin', sessionId))
    const editTags = this.action(() => onAction('editSessionTags', sessionId))
    this.labelAction(editTags, t('editSessionTags'), '#')
    let archived: boolean | undefined
    let pinned: boolean | undefined
    let tagsSignature = ''
    const archive = this.action(() => onAction(archived ? 'restoreSession' : 'archiveSession', sessionId))
    actions.append(pin, editTags, archive)
    const worktree = this.action(() => onAction('worktreeAction', sessionId), 'session-worktree-action')
    this.labelAction(worktree, t('worktreeActions'), icon('fork', 12))
    wrap.append(button, actions, worktree)
    return {
      element: wrap,
      update: (session, active, nextArchived, nextSnippet) => {
        setText(name, session.title)
        setText(meta, `${formatTime(session.updatedAt)}${session.agentPreset ? ` · ${session.agentPreset}` : ''}`)
        running.classList.toggle('active', session.running)
        button.classList.toggle('active', active)
        button.classList.toggle('has-worktree-action', session.isolated === true)
        worktree.classList.toggle('hidden', session.isolated !== true)
        shared.classList.toggle('hidden', session.shared !== true)
        const nextPinned = session.meta?.pinned === true
        if (pinned !== nextPinned) {
          pinned = nextPinned
          mark.classList.toggle('hidden', !pinned)
          pin.classList.toggle('active', pinned)
          this.labelAction(pin, pinned ? t('unpinSession') : t('pinSession'), icon(pinned ? 'pin' : 'unpin', 12))
        }
        if (archived !== nextArchived) {
          archived = nextArchived
          this.labelAction(archive, archived ? t('restoreSession') : t('archiveSession'), icon(archived ? 'restore' : 'archive', 12))
        }
        const values = session.meta?.tags ?? []
        const signature = JSON.stringify(values)
        if (tagsSignature !== signature) {
          tagsSignature = signature
          tags.replaceChildren(...values.map(value => this.node('span', 'session-tag', value)))
          tags.classList.toggle('hidden', values.length === 0)
        }
        setText(snippet, nextSnippet)
        snippet.classList.toggle('hidden', nextSnippet === '')
      },
    }
  }

  private action(onClick: () => void, className = 'session-archive-action'): HTMLButtonElement {
    const action = this.node('button', `icon-button compact ${className}`)
    action.type = 'button'
    action.addEventListener('click', event => { event.stopPropagation(); onClick() })
    return action
  }

  private labelAction(action: HTMLButtonElement, label: string, glyph: string): void {
    action.title = label
    action.setAttribute('aria-label', label)
    applyIcon(action, glyph)
  }

  private node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
    const element = this.options.element.ownerDocument.createElement(tag)
    element.className = className
    element.textContent = text
    return element
  }
}

function setText(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value
}
