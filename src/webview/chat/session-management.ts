import type { ActiveSessionView } from '../../domain/workbench-state.js'
import { elements, post, t } from './context.js'

export function renderSessionManagement(active: ActiveSessionView | undefined): void {
  const view = active?.management
  elements.sessionAccess.classList.toggle('hidden', !view)
  if (!view) return
  const location = view.location
  const status = view.archived ? 'sessionArchivedState' : location?.kind === 'missing' ? 'sessionMissingState'
    : view.status === 'ready' ? 'sessionReadyState' : view.status === 'resuming' ? 'sessionResumingState'
      : view.status === 'occupied' ? 'sessionOccupiedState' : view.status === 'unavailable' ? 'sessionUnavailableState' : 'sessionPreviewState'
  elements.sessionAccessStatus.textContent = t(status)
  const kind = location?.kind === 'worktree' ? 'sessionWorktree' : location?.kind === 'directory' ? 'sessionDirectory' : 'sessionLocationUnknown'
  elements.sessionAccessLocation.textContent = `${t(kind)}${location?.branch ? ' · ' + location.branch : ''}${location ? ' · ' + location.cwd : ''}`
  elements.sessionAccessLocation.title = location?.cwd ?? ''
  elements.sessionAccessHint.textContent = view.error ?? (active?.subagentMode === 'one-shot' ? t('oneShotReadOnly') : active?.subagentMode === 'continuable' && view.status !== 'ready' ? t('sessionChildPreviewHint') : view.status === 'ready' ? t('sessionReadyHint')
    : view.archived ? t('sessionArchivedHint') : !view.projectCurrent ? t('sessionOtherProjectHint') : t('sessionPreviewHint'))
  elements.sessionResume.classList.toggle('hidden', view.status === 'ready' || view.archived || active?.subagentMode !== undefined)
  elements.sessionResume.disabled = !view.canResume
  elements.sessionResume.textContent = t(view.status === 'resuming' ? 'sessionResumingState' : view.status === 'occupied' || view.status === 'unavailable' ? 'sessionRetryResume' : 'sessionContinue')
  elements.sessionOpenProject.classList.toggle('hidden', view.projectCurrent || location?.exists !== true)
  elements.sessionRefresh.disabled = view.status === 'resuming'
}

elements.sessionResume.addEventListener('click', () => { elements.sessionResume.disabled = true; post('resumeSession') })
elements.sessionRefresh.addEventListener('click', () => post('refreshSessionPreview'))
elements.sessionOpenProject.addEventListener('click', () => post('openSessionProject'))
