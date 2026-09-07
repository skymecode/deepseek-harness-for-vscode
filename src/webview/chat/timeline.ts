import { closeCommandMenu } from './command-menu.js'
import { assistantConclusions, type ConclusionItem } from './conclusions.js'
import { components, elements, node, payload, t } from './context.js'
import { cssEscape, formatRelativeTime } from './utils.js'

export function openTimeline(): void {
  closeCommandMenu()
  components.fileMention.close()
  components.composerConfiguration.close()
  renderTimelinePanel()
  elements.timelinePanel.classList.remove('hidden')
  elements.timelineToggle.classList.add('active')
}

export function closeTimeline(): void {
  elements.timelinePanel.classList.add('hidden')
  elements.timelineToggle.classList.remove('active')
  elements.timelinePanel.replaceChildren()
}

export function renderTimelinePanel(): void {
  const conclusions = assistantConclusions(payload?.state.active)
  const fragment = document.createDocumentFragment()
  const header = node('div', 'timeline-panel-header')
  header.append(node('strong', '', t('timeline')), node('span', 'timeline-panel-count', String(conclusions.length)))
  fragment.append(header)
  if (conclusions.length === 0) {
    fragment.append(node('p', 'timeline-empty', t('noContent')))
  } else {
    for (const item of conclusions) {
      const button = node('button', 'timeline-entry') as HTMLButtonElement
      button.type = 'button'
      const index = node('span', 'timeline-entry-index', `#${conclusions.indexOf(item) + 1}`)
      const copy = node('span', 'timeline-entry-copy')
      copy.append(node('strong', '', formatRelativeTime(item.time)))
      copy.append(node('span', 'timeline-entry-snippet', item.text))
      button.append(index, copy)
      button.addEventListener('click', () => {
        closeTimeline()
        selectTimelineItem(item)
      })
      fragment.append(button)
    }
  }
  elements.timelinePanel.replaceChildren(fragment)
}

function selectTimelineItem(item: ConclusionItem): void {
  const target = elements.messages.querySelector(`[data-message-id="${cssEscape(item.id)}"]`)
  if (target === null) return
  smoothScrollConversationTo(target)
  target.classList.add('timeline-highlight')
  setTimeout(() => target.classList.remove('timeline-highlight'), 1_600)
}

function smoothScrollConversationTo(target: Element): void {
  const container = elements.transcript
  const start = container.scrollTop
  const targetScroll = start + target.getBoundingClientRect().top - container.getBoundingClientRect().top - 12
  const duration = 420
  const startedAt = Date.now()
  const step = (): void => {
    const progress = Math.min(1, (Date.now() - startedAt) / duration)
    const eased = 1 - Math.pow(1 - progress, 3)
    container.scrollTop = start + (targetScroll - start) * eased
    if (progress < 1) window.requestAnimationFrame(step)
  }
  window.requestAnimationFrame(step)
}
