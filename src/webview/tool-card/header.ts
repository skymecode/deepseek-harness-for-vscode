import type { ChatItem } from '../../domain/workbench-state.js'
import { applyIcon, icon, type IconName } from '../icons.js'

/** Presentation only: tool payload parsing and actions stay in their renderer. */
export function createToolCardHeader(document: Document, options: {
  readonly title: string
  readonly glyph: IconName
  readonly status: ChatItem['status']
  readonly preview?: string
}): HTMLElement {
  const summary = document.createElement('summary')
  const status = document.createElement('span')
  status.className = 'tool-status'
  const stateIcon = options.status === 'running' ? 'spinner' : options.status === 'error' ? 'cancel' : 'check'
  applyIcon(status, icon(stateIcon, 13))
  const glyph = document.createElement('span')
  glyph.className = 'tool-glyph'
  applyIcon(glyph, icon(options.glyph, 14))
  const title = document.createElement('span')
  title.className = 'tool-title'
  title.textContent = options.title
  title.title = options.title
  summary.append(status, glyph, title)
  if (options.preview !== undefined && options.preview !== '') {
    const preview = document.createElement('span')
    preview.className = 'tool-preview'
    preview.textContent = options.preview
    preview.title = options.preview
    summary.append(preview)
  }
  const chevron = document.createElement('span')
  chevron.className = 'tool-chevron'
  applyIcon(chevron, icon('chevron', 14))
  summary.append(chevron)
  return summary
}
