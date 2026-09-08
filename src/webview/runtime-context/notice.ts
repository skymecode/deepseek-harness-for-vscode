import type { ContextNoticeView } from '../../domain/transcript-context.js'
import { applyIcon, icon } from '../icons.js'
import type { createWebviewTranslator } from '../localization.js'

/** A quiet, localized event row; never render the model-facing prompt here. */
export function createContextNotice(document: Document, notice: ContextNoticeView, t: ReturnType<typeof createWebviewTranslator>): HTMLElement {
  const row = document.createElement('div')
  row.className = 'context-notice'
  const glyph = document.createElement('span')
  applyIcon(glyph, icon(notice.kind === 'model-change' ? 'refresh' : 'details'))
  const text = document.createElement('span')
  text.textContent = notice.kind === 'summary' ? notice.text
    : notice.model === undefined ? t('modelChanged') : t('switchedToModel', { model: notice.model })
  row.append(glyph, text)
  return row
}
