import type { GoalView } from '../../domain/workbench-state.js'
import { resizePrompt } from './composer-core.js'
import { assistantConclusions, timelineSignature } from './conclusions.js'
import {
  components,
  currentDetail,
  detailSignature,
  elements,
  node,
  payload,
  post,
  setDetailSignature,
  t,
} from './context.js'
import { clearPastedImages } from './images.js'
import { closeTimeline } from './timeline.js'
import { appendTodoRows } from './todo-list.js'
import { cssEscape, formatRelativeTime } from './utils.js'
import { RuntimeContextInspector } from '../runtime-context/component.js'

const runtimeContext = new RuntimeContextInspector(document, t)

export function renderDetails(): void {
  if (!payload) return
  const active = payload.state.active
  elements.todoCount.textContent = String(active?.todos.length || 0)
  elements.skillCount.textContent = String(active?.skills.length || 0)
  elements.jobCount.textContent = String(active?.jobs.length || 0)
  elements.agentCount.textContent = String(active?.subagents.length || 0)
  for (const tab of Array.from(document.querySelectorAll<HTMLElement>('[data-detail]'))) tab.classList.toggle('active', tab.dataset.detail === currentDetail)
  if (currentDetail === 'runtime') {
    // Keep open records/focus intact when unrelated assistant chunks arrive.
    // Reset the other tabs' cache so switching back cannot leave this view mounted.
    setDetailSignature('runtime')
    runtimeContext.update(active?.id ?? '', active?.messages ?? [])
    if (runtimeContext.element.parentElement !== elements.detailContent) elements.detailContent.replaceChildren(runtimeContext.element)
    return
  }
  const nextSignature = JSON.stringify({
    sessionId: active?.id,
    currentDetail,
    todos: active?.todos,
    plan: active?.plan,
    goal: active?.goal,
    skills: active?.skills,
    subagents: active?.subagents,
    jobs: active?.jobs,
    timeline: timelineSignature(active),
    running: active?.running,
  })
  if (nextSignature === detailSignature) return
  setDetailSignature(nextSignature)
  const fragment = document.createDocumentFragment()
  if (currentDetail === 'todos') {
    const plan = active?.plan
    if (plan) {
      const mode = node('div', 'plan-mode-row')
      const text = plan.pending ? t('planChanging') : plan.active ? t('planEnabled') : t('planDisabled')
      mode.append(node('span', '', text))
      const toggle = node('button', 'secondary-button', plan.active ? t('disable') : t('enable')) as HTMLButtonElement
      toggle.disabled = plan.pending || active.running
      toggle.addEventListener('click', () => post('setPlan', { active: !plan.active }))
      mode.append(toggle)
      fragment.append(mode)
    }
    // Rendered through the shared helper so the Plan tab and the stream's
    // live todo cards stay visually identical.
    appendTodoRows(fragment, active?.todos || [])
  } else if (currentDetail === 'goal') {
    const goal = active?.goal
    if (!goal) {
      const create = node('button', 'primary-button', t('createGoal')) as HTMLButtonElement
      create.addEventListener('click', () => post('createGoal'))
      fragment.append(create)
    } else {
      const card = node('section', 'goal-card')
      card.append(node('strong', '', goal.objective))
      card.append(node('span', 'goal-meta', t('goalRounds', {
        phase: goalPhaseLabel(goal.phase),
        current: goal.roundsStarted,
        max: goal.maxGoalRounds,
      })))
      if (goal.blockedReason) card.append(node('p', '', goal.blockedReason))
      const actions = node('div', 'goal-actions')
      if (goal.phase === 'active') actions.append(goalButton(t('pause'), 'pause'))
      if (goal.phase === 'paused' || goal.phase === 'blocked') actions.append(goalButton(t('resume'), 'resume'))
      if (goal.phase !== 'complete') actions.append(goalButton(t('markComplete'), 'complete'))
      actions.append(goalButton(t('clear'), 'clear', true))
      card.append(actions)
      fragment.append(card)
    }
  } else if (currentDetail === 'skills') {
    for (const skill of active?.skills || []) {
      const button = node('button', 'skill-row') as HTMLButtonElement
      button.append(node('strong', '', `/${skill.name}`), node('span', '', skill.description))
      button.addEventListener('click', () => {
        elements.prompt.value = `/${skill.name} `
        resizePrompt()
        components.detailsPanel.close()
        elements.prompt.focus()
      })
      fragment.append(button)
    }
  } else if (currentDetail === 'agents') {
    for (const agent of active?.subagents || []) {
      if (agent.kind === 'diagnostic') {
        fragment.append(node('div', 'subagent-row diagnostic', `${agent.id.slice(0, 8)} · ${agent.reason}`))
        continue
      }
      const button = node('button', 'subagent-row') as HTMLButtonElement
      button.append(node('span', `job-status ${agent.activity}`), node('strong', '', agent.label || `Agent ${agent.id.slice(0, 8)}`))
      button.append(node('small', '', `${agent.mode === 'continuable' ? t('continuableConversation') : t('oneShot')}${agent.hasChildren ? t('hasChildAgents') : ''}`))
      button.addEventListener('click', () => {
        components.composerConfiguration.reset()
        closeTimeline()
        clearPastedImages()
        post('selectSubagent', { sessionId: agent.id, mode: agent.mode })
      })
      fragment.append(button)
    }
  } else if (currentDetail === 'jobs') {
    for (const job of active?.jobs || []) {
      const row = node('div', 'job-row')
      row.append(node('span', `job-status ${job.status}`), node('div', '', job.label))
      if (job.detail) row.append(node('small', '', job.detail))
      fragment.append(row)
    }
  } else if (currentDetail === 'timeline') {
    const conclusions = assistantConclusions(active)
    conclusions.forEach((item, index) => {
      const button = node('button', 'timeline-row') as HTMLButtonElement
      button.type = 'button'
      button.title = t('timeline')
      const badge = node('span', 'timeline-index', `#${index + 1}`)
      const copy = node('span', 'timeline-copy')
      copy.append(node('strong', '', formatRelativeTime(item.time)))
      copy.append(node('span', 'timeline-snippet', item.text))
      button.append(badge, copy)
      button.addEventListener('click', () => {
        const target = elements.messages.querySelector(`[data-message-id="${cssEscape(item.id)}"]`)
        if (target !== null) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' })
          target.classList.add('timeline-highlight')
          setTimeout(() => target.classList.remove('timeline-highlight'), 1_600)
        }
      })
      fragment.append(button)
    })
  }
  if (!fragment.childNodes.length) fragment.append(node('p', 'muted-empty', t('noContent')))
  elements.detailContent.replaceChildren(fragment)
}

function goalButton(label: string, action: string, secondary = false): HTMLButtonElement {
  const button = node('button', secondary ? 'secondary-button' : 'primary-button', label) as HTMLButtonElement
  button.addEventListener('click', () => post('mutateGoal', { action }))
  return button
}

function goalPhaseLabel(phase: GoalView['phase']): string {
  if (phase === 'active') return t('goalPhaseActive')
  if (phase === 'paused') return t('goalPhasePaused')
  if (phase === 'blocked') return t('goalPhaseBlocked')
  return t('goalPhaseComplete')
}
