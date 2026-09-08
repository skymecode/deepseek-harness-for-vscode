import type { ActiveSessionView } from '../../domain/workbench-state.js'
import type { IconName } from '../icons.js'
import type { WebviewMessageKey } from '../localization.js'

export type ComposerAction = 'files' | 'selection' | 'goal' | 'plan' | 'skills' | 'plugins' | 'context'
export interface ComposerActionItem {
  readonly id: ComposerAction
  readonly group: 'add' | 'tools'
  readonly icon: IconName
  readonly label: WebviewMessageKey
  readonly description: WebviewMessageKey
  readonly disabled?: boolean
  readonly checked?: boolean
}

/** Menu capabilities come from Harness state, not assumed features of a reference UI. */
export function composerActionItems(active: ActiveSessionView | undefined, ready: boolean): readonly ComposerActionItem[] {
  const readOnly = active?.subagentMode === 'one-shot'
  const editable = ready && !readOnly
  const idle = editable && active !== undefined && !active.running
  return [
    { id: 'files', group: 'add', icon: 'attach', label: 'addWorkspaceFiles', description: 'addWorkspaceFilesHint', disabled: !editable },
    { id: 'selection', group: 'add', icon: 'doc', label: 'addSelectedCode', description: 'attachSelection', disabled: !editable },
    { id: 'goal', group: 'add', icon: 'checkSquare', label: 'viewGoal', description: 'composerGoalHint', disabled: !active?.goal && !idle },
    { id: 'plan', group: 'add', icon: 'bulb', label: 'composerPlan', description: active?.plan?.pending ? 'planChanging' : active?.plan?.active ? 'planEnabled' : 'composerPlanHint', disabled: !idle || active?.plan === undefined || active.plan.pending, checked: active?.plan?.active === true },
    { id: 'skills', group: 'tools', icon: 'skillDoc', label: 'skills', description: 'composerSkillsHint', disabled: !active },
    { id: 'plugins', group: 'tools', icon: 'plugins', label: 'composerPlugins', description: 'composerPluginsHint' },
    { id: 'context', group: 'tools', icon: 'details', label: 'viewContext', description: 'contextDescription' },
  ]
}
