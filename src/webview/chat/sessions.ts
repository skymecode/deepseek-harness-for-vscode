import type { ActiveSessionView, PermissionView } from '../../domain/workbench-state.js'
import { FULL_ACCESS_PERMISSION_ID, PERMISSION_PRESET_IDS } from '../../domain/permissions.js'
import { applyIcon, icon } from '../icons.js'
import { SessionListComponent } from '../session-list/component.js'
import { composerConfigurationInput } from '../composer-configuration/adapter.js'
import { permissionSelectOptions, type PermissionSelectOption } from '../permission/adapter.js'
import { clearPastedImages } from './images.js'
import { closeTimeline } from './timeline.js'
import {
  components,
  elements,
  payload,
  post,
  searchResults,
  selectorSignature,
  setSelectorSignature,
  t,
  workspaceFolderOpen,
} from './context.js'
import { formatRelativeTime } from './utils.js'

let showingArchived = false

const sessionList = new SessionListComponent({
  element: elements.sessionList,
  translate: t,
  formatTime: formatRelativeTime,
  onAction: (action, sessionId) => {
    if (action === 'selectSession') {
      components.composerConfiguration.reset()
      closeTimeline()
      clearPastedImages()
      post(action, { sessionId })
      toggleHistory(false)
      return
    }
    post(action, { sessionId })
    if (action === 'restoreSession') {
      // Follow a restored row back to the default list.
      showingArchived = false
      renderSessions()
    }
  },
})

export function renderSessions(): void {
  if (!payload) return
  const query = elements.historySearch.value.trim()
  const snippets = new Map(searchResults.map((result) => [result.sessionId, result.snippet]))
  const resultIds = new Set(searchResults.map((result) => result.sessionId))
  const pool = showingArchived ? payload.state.archivedSessions : payload.state.sessions
  const sessions = query === '' ? pool : pool.filter((session) => resultIds.has(session.id))
  let emptyMessage = ''
  if (sessions.length === 0) {
    const archivedHits = query === '' || showingArchived
      ? []
      : payload.state.archivedSessions.filter((session) => resultIds.has(session.id))
    if (archivedHits.length > 0) {
      emptyMessage = t('archivedSearchHint', { count: String(archivedHits.length) })
    } else if (showingArchived && query !== '') {
      emptyMessage = t('noMatchingArchivedConversations')
    } else if (showingArchived) {
      emptyMessage = t('noArchivedConversations')
    } else if (query === '') {
      emptyMessage = t(workspaceFolderOpen ? 'noProjectConversations' : 'historyNeedsProject')
    } else {
      emptyMessage = t('noMatchingConversations')
    }
  }
  sessionList.update(sessions, { activeId: payload.state.active?.id, archived: showingArchived, snippets, emptyMessage })
  renderHistoryFilter()
}

function renderHistoryFilter(): void {
  if (!payload) return
  const archivedCount = payload.state.archivedSessions.length
  elements.historyArchived.classList.toggle('active', showingArchived)
  elements.historyArchived.setAttribute('aria-pressed', String(showingArchived))
  elements.historyArchived.textContent = archivedCount === 0
    ? t('archivedConversations')
    : `${t('archivedConversations')} ${archivedCount}`
}

export function toggleArchivedHistory(): void {
  showingArchived = !showingArchived
  renderSessions()
}

export function renderSelectors(active: ActiveSessionView | undefined): void {
  if (!payload) return
  const nextSignature = JSON.stringify({
    sessionId: active?.id,
    phase: payload.state.phase,
    configuration: payload.configuration,
    fallbackOptions: payload.fallbackOptions,
    presets: payload.state.presets,
    models: active?.models,
    model: active?.model,
    agentPreset: active?.agentPreset,
    parentSessionId: active?.parentSessionId,
    permissions: active?.permissions,
    running: active?.running,
    effortIntent: active?.effortIntent,
  })
  if (nextSignature === selectorSignature) return
  setSelectorSignature(nextSignature)
  components.composerConfiguration.update(composerConfigurationInput(payload))
  const permissions = active?.permissions
  if (permissions) {
    renderPermissionOptions(permissions)
    elements.permission.classList.remove('hidden')
    elements.permissionToggle.disabled = active?.running === true || payload.state.phase !== 'connected'
    elements.permissionToggle.classList.toggle('danger', permissions.currentValue === FULL_ACCESS_PERMISSION_ID)
  } else {
    elements.permission.classList.add('hidden')
    closePermissionPopup()
  }
}

function renderPermissionOptions(permissions: PermissionView): void {
  const runtimeOptions = permissionSelectOptions(permissions)
  const options = mergePermissionOptions(runtimeOptions, permissions.currentValue)
  const selected = options.find((option) => option.id === permissions.currentValue)
  elements.permissionToggleLabel.textContent = selected?.label ?? permissions.currentValue
  const fragment = document.createDocumentFragment()
  for (const item of options) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `permission-option${item.id === permissions.currentValue ? ' active' : ''}`
    button.setAttribute('role', 'option')
    button.setAttribute('aria-selected', String(item.id === permissions.currentValue))
    button.title = item.description || ''
    const label = document.createElement('span')
    label.className = 'permission-option-label'
    label.textContent = item.label || item.id
    button.append(label)
    const check = document.createElement('span')
    check.className = 'permission-option-check'
    applyIcon(check, item.id === permissions.currentValue ? icon('check', 12) : '')
    button.append(check)
    if (item.disabled) {
      button.disabled = true
    } else {
      button.addEventListener('click', () => {
        // Full access bypasses every prompt; require an explicit confirmation
        // first, like the official Web UI does.
        if (item.id === FULL_ACCESS_PERMISSION_ID && permissions.currentValue !== FULL_ACCESS_PERMISSION_ID) {
          closePermissionPopup()
          openPermissionConfirm()
          return
        }
        post('setPermission', { value: item.id })
        closePermissionPopup()
      })
    }
    fragment.append(button)
  }
  elements.permissionOptions.replaceChildren(fragment)
}

/**
 * The Harness runtime projection may arrive with only a `currentValue` and no
 * `options` list (older builds / some providers). The extension always offers
 * the three sandbox presets, so merge the runtime options with a static
 * fallback list to keep the selector usable.
 */
function mergePermissionOptions(
  runtimeOptions: readonly PermissionSelectOption[],
  currentValue: string,
): readonly PermissionSelectOption[] {
  const fallback: readonly PermissionSelectOption[] = PERMISSION_PRESET_IDS.map((id) => ({
    id,
    label: id,
    disabled: false,
  }))
  const map = new Map<string, PermissionSelectOption>()
  for (const option of runtimeOptions) map.set(option.id, option)
  for (const option of fallback) if (!map.has(option.id)) map.set(option.id, option)
  const options = [...map.values()]
  if (!options.some((option) => option.id === currentValue)) {
    options.push({ id: currentValue, label: currentValue, disabled: false })
  }
  return options
}

export function togglePermissionPopup(): void {
  if (elements.permissionPopup.classList.contains('hidden')) openPermissionPopup()
  else closePermissionPopup()
}

function openPermissionPopup(): void {
  if (elements.permissionToggle.disabled) return
  closePermissionConfirm()
  anchorPermissionOverlay(elements.permissionPopup, elements.permissionToggle)
  elements.permissionPopup.classList.remove('hidden')
  elements.permissionToggle.classList.add('active')
  elements.permissionToggle.setAttribute('aria-expanded', 'true')
}

export function closePermissionPopup(): void {
  elements.permissionPopup.classList.add('hidden')
  resetPermissionOverlayAnchor(elements.permissionPopup)
  elements.permissionToggle.classList.remove('active')
  elements.permissionToggle.setAttribute('aria-expanded', 'false')
}

export function openPermissionConfirm(): void {
  anchorPermissionOverlay(elements.permissionConfirm, elements.permissionToggle)
  elements.permissionConfirm.classList.remove('hidden')
  elements.permissionConfirmAccept.focus()
}

export function closePermissionConfirm(refocus = false): void {
  elements.permissionConfirm.classList.add('hidden')
  resetPermissionOverlayAnchor(elements.permissionConfirm)
  if (refocus) elements.permissionToggle.focus()
}

/**
 * The permission popups are DOM children of .composer-tools, which switches to
 * overflow: hidden below 680px (chat-responsive.css) so the toolbar cannot
 * push the shell apart on narrow sidebars. That clip also cut off these
 * upward-opening overlays, making the selector silently vanish on narrow
 * windows. position: fixed escapes every ancestor clip while staying glued to
 * the toggle's current viewport position.
 */
function anchorPermissionOverlay(overlay: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect()
  const width = Math.min(220, window.innerWidth - 16)
  const left = Math.max(4, Math.min(rect.left, window.innerWidth - width - 4))
  overlay.style.position = 'fixed'
  overlay.style.left = left + 'px'
  overlay.style.bottom = Math.max(4, window.innerHeight - rect.top + 6) + 'px'
}

function resetPermissionOverlayAnchor(overlay: HTMLElement): void {
  overlay.style.position = ''
  overlay.style.left = ''
  overlay.style.bottom = ''
}

export function toggleHistory(open: boolean): void {
  if (open) components.pluginCenter.close()
  elements.historyPanel.classList.toggle('hidden', !open)
  if (open) {
    post('refreshSessions')
    renderSessions()
    elements.historySearch.focus()
  }
}
