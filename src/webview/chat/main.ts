import { render, sendPrompt } from './app.js'
import {
  chooseCommand,
  closeCommandMenu,
  insertCommand,
  renderCommandMenu,
  updateCommandMenu,
} from './command-menu.js'
import './components.js'
import { resizePrompt } from './composer-core.js'
import {
  components,
  elements,
  followStream,
  interactionArmed,
  menuState,
  optimisticBubbles,
  payload,
  post,
  searchTimer,
  setCurrentDetail,
  setFollowStream,
  setInteractionArmed,
  setMenuState,
  setOptimisticBubbles,
  setPayload,
  setSearchResults,
  setSearchTimer,
  setWorkspaceFolderOpen,
  vscode,
} from './context.js'
import { renderDetails } from './details.js'
import { addPastedImages, clearPastedImages, closeImagePreview } from './images.js'
import { cancelStickToBottom } from './messages.js'
import { applyReferenceValidation, setReferenceValidator } from '../markdown.js'
import { closePermissionConfirm, closePermissionPopup, renderSessions, toggleArchivedHistory, toggleHistory, togglePermissionPopup } from './sessions.js'
import { isAtBottom, isNearBottom } from './utils.js'
import { FULL_ACCESS_PERMISSION_ID } from '../../domain/permissions.js'
import { closeTimeline, openTimeline } from './timeline.js'
import { clipboardImageFiles } from './clipboard-images.js'

// Streaming auto-follow yields to any reach for the scrollbar. A mouse-down
// arms the interaction (drag intent before the first scroll event), wheel-up
// and touch-drag-up pause following immediately, and the pin only re-latches
// on wheel-down at the bottom or touching the very bottom.
elements.transcript.addEventListener('pointerdown', () => setInteractionArmed(true), { passive: true })
elements.transcript.addEventListener('wheel', (event) => {
  if (event.deltaY < 0) {
    setFollowStream(false)
  } else if (event.deltaY > 0 && !followStream && isAtBottom(elements.transcript)) {
    setFollowStream(true)
  }
}, { passive: true })

let touchAnchorY: number | undefined
elements.transcript.addEventListener('touchstart', (event) => {
  touchAnchorY = event.touches[0]?.clientY
}, { passive: true })
elements.transcript.addEventListener('touchmove', (event) => {
  const y = event.touches[0]?.clientY
  if (touchAnchorY === undefined || y === undefined) return
  // A finger moving down reveals earlier content (scrolls up).
  if (y > touchAnchorY) setFollowStream(false)
  touchAnchorY = y
}, { passive: true })
elements.transcript.addEventListener('scroll', () => {
  if (isAtBottom(elements.transcript)) {
    setFollowStream(true)
  } else if (followStream) {
    // A scroll that left the bottom while following can only be the reader
    // dragging the scrollbar up; our own position restore only runs when the
    // view is already not following.
    setFollowStream(false)
  }
  if (interactionArmed) setInteractionArmed(false)
}, { passive: true })
elements.transcript.addEventListener('pointerup', () => setInteractionArmed(false), { passive: true })
elements.transcript.addEventListener('pointercancel', () => setInteractionArmed(false), { passive: true })
elements.transcript.addEventListener('pointerleave', () => setInteractionArmed(false), { passive: true })

window.addEventListener('message', (event) => {
  if (event.data?.type === 'pluginState') {
    components.pluginCenter.update(event.data.snapshot)
    return
  }
  if (event.data?.type === 'searchResults') {
    if (event.data.query === elements.historySearch.value.trim()) {
      setSearchResults(event.data.results)
      renderSessions()
    }
    return
  }
  if (event.data?.type === 'referenceValidation') {
    applyReferenceValidation({ resolved: event.data.resolved ?? [], rejected: event.data.rejected ?? [] })
    return
  }
  if (event.data?.type === 'editorSelection') {
    components.editorContext.updateSelection(event.data.selection)
    return
  }
  if (event.data?.type === 'workspaceFileSuggestions') {
    components.fileMention.acceptSuggestions(event.data.requestId, event.data.query, event.data.files || [])
    return
  }
  if (event.data?.type === 'connectionTestResult') {
    components.connectionSettings.renderTestResult(event.data)
    return
  }
  if (event.data?.type === 'sendPromptFailed') {
    // The host rejected the prompt before it entered the queue (e.g. the model
    // does not support image input). Roll back the optimistic echo so the
    // failed message does not linger as if it had been sent.
    if (optimisticBubbles.length > 0) {
      setOptimisticBubbles([])
      render()
    }
    return
  }
  if (event.data?.type === 'newSessionSettled') {
    // The host finished (or failed) creating the new session: re-arm the ＋
    // button so the next click starts a fresh creation instead of being
    // silently swallowed.
    elements.newSession.disabled = false
    return
  }
  if (event.data?.type !== 'state') return
  setWorkspaceFolderOpen(event.data.workspaceFolderOpen === true)
  setPayload(event.data)
  render()
})

// Only references the Host confirmed as real workspace files become clickable.
setReferenceValidator((keys) => post('validateFileReferences', { keys }))

elements.historyToggle.addEventListener('click', () => toggleHistory(true))
elements.historyClose.addEventListener('click', () => toggleHistory(false))
elements.historyArchived.addEventListener('click', () => toggleArchivedHistory())
elements.historySearch.addEventListener('input', () => {
  clearTimeout(searchTimer)
  const query = elements.historySearch.value.trim()
  if (query === '') {
    setSearchResults([])
    renderSessions()
  } else {
    setSearchResults([])
    renderSessions()
    setSearchTimer(setTimeout(() => post('searchSessions', { query }), 180))
  }
})
elements.newSession.addEventListener('click', () => {
  // Creating a session runs git worktree creation plus RPCs that can take
  // seconds. Disable the button so repeated clicks cannot fan out into a
  // storm of concurrent createSession() calls (each of which would race the
  // git worktree lock and produce duplicate blank drafts); the host re-arms
  // it via 'newSessionSettled' once the flow settles.
  if (elements.newSession.disabled) return
  components.composerConfiguration.reset()
  components.fileMention.close()
  closeTimeline()
  components.editorContext.markSubmitted()
  clearPastedImages()
  elements.newSession.disabled = true
  post('newSession')
})
elements.sessionTitle.addEventListener('click', () => post('rename'))
elements.backParent.addEventListener('click', () => {
  components.composerConfiguration.reset()
  closeTimeline()
  clearPastedImages()
  post('selectParent')
})
elements.fork.addEventListener('click', () => {
  components.composerConfiguration.reset()
  closeTimeline()
  clearPastedImages()
  post('fork')
})
elements.importSession.addEventListener('click', () => post('importSession'))
elements.historyImport.addEventListener('click', () => post('importSession'))
elements.exportSession.addEventListener('click', () => post('exportSession'))
elements.setApiKey.addEventListener('click', () => post('setApiKey'))
elements.openSettings.addEventListener('click', () => components.connectionSettings.open())
elements.retry.addEventListener('click', () => post('retry'))
elements.showLogs.addEventListener('click', () => post('showLogs'))
elements.loadOlder.addEventListener('click', () => post('loadOlder'))
elements.detailsToggle.addEventListener('click', () => {
  elements.details.classList.toggle('hidden')
  if (!elements.details.classList.contains('hidden')) renderDetails()
})
elements.send.addEventListener('click', () => {
  if (payload?.state.active?.running) post('cancel')
  else sendPrompt()
})
elements.prompt.addEventListener('input', () => {
  resizePrompt()
  updateCommandMenu()
})
elements.prompt.addEventListener('keydown', (event) => {
  if (menuState && menuState.items.length > 0) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setMenuState({ ...menuState, index: (menuState.index + 1) % menuState.items.length })
      renderCommandMenu()
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setMenuState({ ...menuState, index: (menuState.index - 1 + menuState.items.length) % menuState.items.length })
      renderCommandMenu()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      const item = menuState.items[menuState.index]
      if (item) chooseCommand(item)
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      const item = menuState.items[menuState.index]
      if (item) {
        closeCommandMenu()
        insertCommand(item.name)
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeCommandMenu()
      return
    }
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    sendPrompt()
  }
})
elements.prompt.addEventListener('blur', () => {
  setTimeout(() => { if (!elements.commandMenu.matches(':hover')) closeCommandMenu() }, 120)
})
// A user scrolling away from the newest message (for example to re-read a
// file reference inside an earlier question) must release the load pin;
// otherwise the next catalog push would yank the conversation back down.
elements.transcript.addEventListener('scroll', () => {
  if (!isNearBottom(elements.transcript)) cancelStickToBottom()
}, { passive: true })
document.addEventListener('paste', (event) => {
  const target = event.target
  if (!(target instanceof Node) || !elements.prompt.parentElement?.contains(target)) return
  const clipboardData = event.clipboardData
  if (!clipboardData) return
  const files = clipboardImageFiles(clipboardData)
  if (files.length === 0) return
  event.preventDefault()
  void addPastedImages(files)
})
elements.imageLightboxClose.addEventListener('click', () => closeImagePreview())
elements.imageLightbox.querySelector('.image-lightbox-backdrop')?.addEventListener('click', () => closeImagePreview())
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  if (!elements.imageLightbox.classList.contains('hidden')) {
    event.preventDefault()
    closeImagePreview()
    return
  }
  if (!elements.permissionConfirm.classList.contains('hidden')) {
    event.preventDefault()
    closePermissionConfirm(true)
    return
  }
  if (!elements.permissionPopup.classList.contains('hidden')) {
    event.preventDefault()
    closePermissionPopup()
    elements.permissionToggle.focus()
    return
  }
  if (!elements.timelinePanel.classList.contains('hidden')) {
    event.preventDefault()
    closeTimeline()
    return
  }
  if (!document.getElementById('settings-panel')!.classList.contains('hidden') || !document.getElementById('plugin-panel')!.classList.contains('hidden')) return
  if (payload?.state.active?.running) {
    event.preventDefault()
    post('cancel')
  }
})
elements.permissionToggle.addEventListener('click', (event) => {
  event.stopPropagation()
  togglePermissionPopup()
})
elements.permissionConfirmAccept.addEventListener('click', () => {
  post('setPermission', { value: FULL_ACCESS_PERMISSION_ID })
  closePermissionConfirm()
})
elements.permissionConfirmCancel.addEventListener('click', () => {
  closePermissionConfirm(true)
})
elements.timelineToggle.addEventListener('click', (event) => {
  event.stopPropagation()
  if (elements.timelinePanel.classList.contains('hidden')) openTimeline()
  else closeTimeline()
})
document.addEventListener('pointerdown', (event) => {
  const target = event.target
  if (!(target instanceof Node)) return
  if (
    !elements.timelinePanel.classList.contains('hidden')
    && !elements.timelinePanel.contains(target)
    && !elements.timelineToggle.contains(target)
  ) {
    closeTimeline()
  }
  if (
    !elements.permissionPopup.classList.contains('hidden')
    && !elements.permission.contains(target)
  ) {
    closePermissionPopup()
  }
  if (
    !elements.permissionConfirm.classList.contains('hidden')
    && !elements.permission.contains(target)
  ) {
    closePermissionConfirm()
  }
})
for (const tab of Array.from(document.querySelectorAll<HTMLElement>('[data-detail]'))) {
  tab.addEventListener('click', () => {
    setCurrentDetail(tab.dataset.detail ?? 'todos')
    renderDetails()
  })
}

// The webview is fully initialized; ask the host for the first state snapshot.
vscode.postMessage({ type: 'ready' })
