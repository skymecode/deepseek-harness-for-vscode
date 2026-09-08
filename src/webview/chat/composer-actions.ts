import { ComposerActionsMenu } from '../composer-actions/component.js'
import { composerActionItems, type ComposerAction } from '../composer-actions/model.js'
import { closeCommandMenu } from './command-menu.js'
import { components, elements, payload, post, t } from './context.js'
import { closePermissionPopup } from './sessions.js'
import { closeTimeline } from './timeline.js'

/** Composer shortcuts reuse the existing host protocols and context components. */
export const composerActions = new ComposerActionsMenu({
  document,
  trigger: elements.composerAdd,
  menu: elements.composerAddMenu,
  translate: t,
  onOpen: () => {
    closeCommandMenu()
    closeTimeline()
    closePermissionPopup()
    components.fileMention.close()
    components.composerConfiguration.close()
  },
  onChoose: chooseAction,
})

export function renderComposerActions(): void {
  composerActions.update(payload?.state.active?.id, composerActionItems(payload?.state.active, payload?.state.phase === 'connected'))
}

function chooseAction(action: ComposerAction): void {
  const active = payload?.state.active
  switch (action) {
    case 'files': components.fileMention.open(); break
    case 'selection': elements.attachSelection.click(); break
    case 'goal':
      if (active?.goal) components.detailsPanel.toggle('goal')
      else post('createGoal')
      break
    case 'plan': post('setPlan', { active: !active?.plan?.active }); break
    case 'skills': components.detailsPanel.toggle('skills'); break
    case 'plugins': components.pluginCenter.open(); break
    case 'context': components.detailsPanel.toggle(); break
  }
}

window.addEventListener('pagehide', () => composerActions.dispose(), { once: true })
