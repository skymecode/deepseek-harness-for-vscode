import type { SessionListItem } from '../../domain/workbench-state.js'
import { applyIcon, icon } from '../icons.js'
import type { MessageArguments, WebviewMessageKey } from '../localization.js'

type SessionAction = 'selectSession' | 'toggleSessionPin' | 'editSessionTags' | 'archiveSession' | 'restoreSession' | 'worktreeAction'

interface SessionRow {
  readonly element: HTMLElement
  update(session: SessionListItem, active: boolean, archived: boolean, snippet: string): void
}

interface SessionListState {
  readonly groupByProject?: boolean
  readonly activeId: string | undefined
  readonly archived: boolean
  readonly archivedIds?: ReadonlySet<string>
  readonly snippets: ReadonlyMap<string, string>
  readonly emptyMessage: string
}

/** Keep buttons mounted between pointerdown and click while replies stream. */
export class SessionListComponent {
  private readonly groups = new Map<string, HTMLElement>()
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
      this.empty.textContent = state.emptyMessage
      this.options.element.replaceChildren(this.empty)
      this.groups.clear()
      return
    }
    this.empty.remove()
    const buckets = new Map<string, SessionListItem[]>()
    for (const session of sessions) {
      const key = state.groupByProject ? (session.meta?.pinned ? 'pinned' : session.projectPath ?? 'unknown') : ''
      const group = buckets.get(key) ?? []
      group.push(session)
      buckets.set(key, group)
    }
    const used = new Set<string>()
    let cursor: ChildNode | null = this.options.element.firstChild
    const place = (element: HTMLElement): void => {
      if (element !== cursor) this.options.element.insertBefore(element, cursor)
      cursor = element.nextSibling
    }
    for (const [key, group] of buckets) {
      if (key) {
        used.add(key)
        let header = this.groups.get(key)
        if (!header) { header = this.node('h3', 'session-project-heading'); this.groups.set(key, header) }
        header.textContent = key === 'pinned' ? this.options.translate('sessionPinned')
          : key === 'unknown' ? this.options.translate('sessionUnknownProject') : group[0]?.projectLabel ?? key
        header.title = key === 'pinned' || key === 'unknown' ? '' : key
        place(header)
      }
      for (const session of group) {
        let row = this.rows.get(session.id)
        if (!row) { row = this.createRow(session.id); this.rows.set(session.id, row) }
        row.update(session, session.id === state.activeId, state.archivedIds?.has(session.id) ?? state.archived, state.snippets.get(session.id) ?? '')
        place(row.element)
      }
    }
    for (const [key, header] of this.groups) { if (!used.has(key)) { header.remove(); this.groups.delete(key) } }
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
    const shared = this.node('span', 'session-tag shared')
    const execution = this.node('span', 'session-tag session-execution')
    const badges = this.node('span', 'session-badges')
    badges.append(shared, execution)
    const tags = this.node('span', 'session-tags')
    const snippet = this.node('span', 'session-snippet')
    button.append(top, meta, badges, tags, snippet)
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
        const project = session.projectLabel !== undefined && session.projectCurrent === false
          ? ` · ${session.projectLabel}`
          : ''
        setText(meta, `${formatTime(session.updatedAt)}${session.agentPreset ? ` · ${session.agentPreset}` : ''}${project}`)
        meta.title = session.projectPath ?? ''
        running.classList.toggle('active', session.running)
        button.classList.toggle('active', active)
        const management = session.management
        const managed = management ? management.managedWorktree && management.location?.kind === 'worktree' : session.isolated === true
        button.classList.toggle('has-worktree-action', managed)
        worktree.classList.toggle('hidden', !managed)
        const kind = management?.location?.kind
        setText(shared, t(kind === 'worktree' || session.isolated ? 'sessionWorktree' : kind === 'directory' || session.shared ? 'sessionDirectory' : kind === 'missing' ? 'sessionMissingState' : 'sessionLocationUnknown'))
        shared.title = management?.location?.cwd ?? session.cwd ?? ''
        const status = nextArchived ? 'sessionArchivedState' : session.running ? 'sessionRunning'
          : management?.status === 'occupied' ? 'sessionOccupiedState' : management?.status === 'resuming' ? 'sessionResumingState'
            : management?.status === 'unavailable' ? 'sessionUnavailableState' : management?.status === 'ready' ? 'sessionReadyState' : 'sessionPreviewState'
        setText(execution, t(status))
        execution.title = management?.error ?? ''
        const nextPinned = session.meta?.pinned === true
        pin.disabled = nextArchived && !nextPinned
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
