import type { JobDisplayView } from '../../domain/workbench-state.js'
import { applyIcon, icon } from '../icons.js'
import type { MessageArguments, WebviewMessageKey } from '../localization.js'

/** Keyed job rows retain focus, selection and output scroll through live frames. */
export class JobsComponent {
  readonly element: HTMLElement
  private sessionId = ''
  private expanded: string | undefined
  private jobs: readonly JobDisplayView[] = []
  private readonly rows = new Map<string, {
    root: HTMLElement; toggle: HTMLButtonElement; stop: HTMLButtonElement; status: HTMLElement;
    label: HTMLElement; detail: HTMLElement; output: HTMLElement; note: HTMLElement;
  }>()

  constructor(private readonly document: Document, private readonly t: (key: WebviewMessageKey, args?: MessageArguments) => string,
    private readonly post: (type: string, data: Record<string, unknown>) => void) {
    this.element = document.createElement('div')
  }

  update(sessionId: string, jobs: readonly JobDisplayView[]): void {
    if (sessionId !== this.sessionId) {
      this.collapse()
      this.rows.clear()
      this.element.replaceChildren()
      this.sessionId = sessionId
    }
    this.jobs = jobs
    const ids = new Set(jobs.map(job => String(job.id)))
    for (const [id, row] of this.rows) {
      if (ids.has(id)) continue
      if (id === this.expanded) this.collapse()
      row.root.remove()
      this.rows.delete(id)
    }
    if (jobs.length === 0) {
      this.element.textContent = this.t('noContent')
      return
    }
    if (this.rows.size === 0) this.element.replaceChildren()
    let cursor = this.element.firstElementChild
    for (const job of jobs) {
      const id = String(job.id)
      const row = this.rows.get(id) ?? this.createRow(id)
      row.status.className = `job-status ${job.status}`
      row.label.textContent = job.label
      row.detail.textContent = [job.progress, job.detail].filter(Boolean).join(' · ')
      row.stop.hidden = job.status !== 'running' && job.status !== 'stopping'
      row.stop.disabled = job.status === 'stopping'
      const expanded = this.expanded === id
      row.toggle.setAttribute('aria-expanded', String(expanded))
      row.output.hidden = !expanded
      row.note.hidden = !expanded
      const note = [job.outputLossy ? this.t('jobOutputTruncated') : '',
        job.outputState === 'reconnecting' ? this.t('reconnecting') : '',
        job.outputState === 'error' ? job.outputError ?? this.t('unknownError') : '',
        job.outputState === 'loading' ? this.t('processing') : ''].filter(Boolean).join(' · ')
      row.note.textContent = note
      if (row.output.textContent !== (job.outputText ?? '')) {
        const follow = row.output.scrollHeight - row.output.scrollTop - row.output.clientHeight < 4
        row.output.textContent = job.outputText ?? ''
        if (follow) row.output.scrollTop = row.output.scrollHeight
      }
      if (row.root !== cursor) this.element.insertBefore(row.root, cursor)
      cursor = row.root.nextElementSibling
    }
  }

  collapse(): void {
    if (this.expanded !== undefined) this.post('stopFollowingJob', { sessionId: this.sessionId, jobId: this.expanded })
    this.expanded = undefined
  }

  private createRow(id: string) {
    const node = (tag: string, className = ''): HTMLElement => {
      const el = this.document.createElement(tag)
      el.className = className
      return el
    }
    const root = node('section', 'job-row')
    const toggle = node('button', 'job-toggle') as HTMLButtonElement
    toggle.type = 'button'
    const status = node('span', 'job-status')
    const copy = node('span', 'job-copy')
    const label = node('span')
    const detail = node('small')
    copy.append(label, detail)
    toggle.append(status, copy)
    toggle.addEventListener('click', () => {
      if (this.expanded === id) this.collapse()
      else {
        this.expanded = id
        this.post('followJob', { sessionId: this.sessionId, jobId: id })
      }
      this.update(this.sessionId, this.jobs)
    })
    const stop = node('button', 'icon-button compact job-stop') as HTMLButtonElement
    stop.type = 'button'
    stop.title = this.t('stopBackgroundJob')
    stop.setAttribute('aria-label', this.t('stopBackgroundJob'))
    applyIcon(stop, icon('close', 12))
    stop.addEventListener('click', () => this.post('killJob', { sessionId: this.sessionId, jobId: id }))
    const note = node('small', 'job-output-note')
    const output = node('pre', 'job-output')
    output.setAttribute('aria-label', this.t('jobOutput'))
    root.append(toggle, stop, note, output)
    const row = { root, toggle, stop, status, label, detail, output, note }
    this.rows.set(id, row)
    return row
  }
}
