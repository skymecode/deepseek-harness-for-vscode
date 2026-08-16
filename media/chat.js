import { renderMarkdown } from '../src/webview/markdown.js'
import { createWebviewTranslator } from '../src/webview/localization.js'
import { composerConfigurationInput } from '../src/webview/composer-configuration/adapter.js'
import { createComposerConfigurationComponent } from '../src/webview/composer-configuration/component.js'
import { composerStatusText } from '../src/webview/composer-status.js'
import { createConnectionSettingsComponent } from '../src/webview/connection-settings/component.js'
import { createContextMeterComponent } from '../src/webview/context-meter/component.js'
import { createEditorContextComponent } from '../src/webview/editor-context/component.js'
import { createFileMentionComponent } from '../src/webview/file-mention/component.js'
import { permissionSelectOptions } from '../src/webview/permission/adapter.js'
import { createPluginCenterComponent } from '../src/webview/plugin-center/component.js'
import { StreamingMessageComponent } from '../src/webview/streaming-message/component.js'
import { createWorkDurationComponent } from '../src/webview/work-duration/component.js'

const vscode = acquireVsCodeApi()
const t = createWebviewTranslator()

const byId = (id) => document.getElementById(id)
const elements = {
  connection: byId('connection'),
  historyToggle: byId('history-toggle'),
  historyPanel: byId('history-panel'),
  historyClose: byId('history-close'),
  historySearch: byId('history-search'),
  sessionList: byId('session-list'),
  newSession: byId('new-session'),
  sessionTitle: byId('session-title'),
  backParent: byId('back-parent'),
  fork: byId('fork'),
  permission: byId('permission'),
  keyBanner: byId('key-banner'),
  setApiKey: byId('set-api-key'),
  openSettings: byId('open-settings'),
  loading: byId('loading'),
  error: byId('error'),
  errorMessage: byId('error-message'),
  retry: byId('retry'),
  showLogs: byId('show-logs'),
  chat: byId('chat'),
  conversation: byId('conversation'),
  loadOlder: byId('load-older'),
  empty: byId('empty'),
  messages: byId('messages'),
  details: byId('details'),
  detailsToggle: byId('details-toggle'),
  detailContent: byId('detail-content'),
  todoCount: byId('todo-count'),
  skillCount: byId('skill-count'),
  jobCount: byId('job-count'),
  agentCount: byId('agent-count'),
  interactions: byId('interactions'),
  prompt: byId('prompt'),
  commandMenu: byId('command-menu'),
  attachSelection: byId('attach-selection'),
  send: byId('send'),
  composerStatus: byId('composer-status'),
}

let payload
let currentDetail = 'todos'
let renderedSessionId = ''
const messageSignatures = new WeakMap()
let searchResults = []
let searchTimer
let menuState = null
let menuLoadedSession = null
let selectorSignature = ''
let interactionSignature = ''
let detailSignature = ''
const markdownActions = {
  openExternal: (url) => post('openExternal', { url }),
  openFile: (reference) => post('openFile', reference),
  copyCode: (code) => copyText(code),
  defaultCodeLanguage: t('code'),
  copyLabel: t('copy'),
  copyCodeLabel: (language) => t('copyCode', { language }),
}
const composerConfiguration = createComposerConfigurationComponent({
  document,
  translate: t,
  onChange: () => renderComposer(payload?.state.active),
  onOpen: () => {
    closeCommandMenu()
    connectionSettings.close()
  },
})
const connectionSettings = createConnectionSettingsComponent({
  document,
  translate: t,
  post,
  onOpen: () => {
    composerConfiguration.close()
    closeCommandMenu()
  },
})
const contextMeter = createContextMeterComponent({ document, translate: t })
const editorContext = createEditorContextComponent({
  document,
  translate: t,
  onRequestSelection: () => post('attachSelection'),
  onOpenFile: (reference) => post('openFile', reference),
})
const fileMention = createFileMentionComponent({
  document,
  prompt: elements.prompt,
  translate: t,
  onSearch: (query, requestId) => post('searchWorkspaceFiles', { query, requestId }),
  onChoose: (file) => editorContext.addFile(file),
  onOpen: closeCommandMenu,
})
const workDuration = createWorkDurationComponent({ document, translate: t })
const streamingMessage = new StreamingMessageComponent({
  document,
  reasoningLabel: () => t('reasoningProcess'),
  thinkingLabel: () => t('thinking'),
  renderMarkdown: (target, source) => renderMarkdown(target, source, markdownActions),
  onStreamFrame: () => {
    if (isNearBottom(elements.conversation)) elements.conversation.scrollTop = elements.conversation.scrollHeight
  },
})
const pluginCenter = createPluginCenterComponent({
  document,
  translate: t,
  onOpen: () => toggleHistory(false),
  onLoad: (force) => post('loadPlugins', { force }),
  onInstall: ({ spec, name, repositoryUrl }) => post('installPlugin', {
    spec,
    ...(name === undefined ? {} : { name }),
    ...(repositoryUrl === undefined ? {} : { repositoryUrl }),
  }),
  onRemove: (name) => post('removePlugin', { name }),
  onOpenExternal: (url) => post('openExternal', { url }),
})

window.addEventListener('message', (event) => {
  if (event.data?.type === 'pluginState') {
    pluginCenter.update(event.data.snapshot)
    return
  }
  if (event.data?.type === 'searchResults') {
    if (event.data.query === elements.historySearch.value.trim()) {
      searchResults = event.data.results
      renderSessions()
    }
    return
  }
  if (event.data?.type === 'editorSelection') {
    editorContext.updateSelection(event.data.selection)
    return
  }
  if (event.data?.type === 'workspaceFileSuggestions') {
    fileMention.acceptSuggestions(event.data.requestId, event.data.query, event.data.files || [])
    return
  }
  if (event.data?.type === 'connectionTestResult') {
    connectionSettings.renderTestResult(event.data)
    return
  }
  if (event.data?.type !== 'state') return
  payload = event.data
  render()
})

elements.historyToggle.addEventListener('click', () => toggleHistory(true))
elements.historyClose.addEventListener('click', () => toggleHistory(false))
elements.historySearch.addEventListener('input', () => {
  clearTimeout(searchTimer)
  const query = elements.historySearch.value.trim()
  if (query === '') {
    searchResults = []
    renderSessions()
  } else {
    searchResults = []
    renderSessions()
    searchTimer = setTimeout(() => post('searchSessions', { query }), 180)
  }
})
elements.newSession.addEventListener('click', () => {
  composerConfiguration.reset()
  fileMention.close()
  editorContext.markSubmitted()
  post('newSession')
})
elements.sessionTitle.addEventListener('click', () => post('rename'))
elements.backParent.addEventListener('click', () => {
  composerConfiguration.reset()
  post('selectParent')
})
elements.fork.addEventListener('click', () => {
  composerConfiguration.reset()
  post('fork')
})
elements.setApiKey.addEventListener('click', () => post('setApiKey'))
elements.openSettings.addEventListener('click', () => connectionSettings.open())
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
      menuState.index = (menuState.index + 1) % menuState.items.length
      renderCommandMenu()
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      menuState.index = (menuState.index - 1 + menuState.items.length) % menuState.items.length
      renderCommandMenu()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      chooseCommand(menuState.items[menuState.index])
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      if (menuState.items[menuState.index]) {
        const name = menuState.items[menuState.index].name
        closeCommandMenu()
        insertCommand(name)
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
elements.permission.addEventListener('change', () => post('setPermission', { value: elements.permission.value }))
for (const tab of document.querySelectorAll('[data-detail]')) {
  tab.addEventListener('click', () => {
    currentDetail = tab.dataset.detail
    renderDetails()
  })
}

function render() {
  if (!payload) return
  const { state } = payload
  const active = state.active
  editorContext.setAutoAttach(payload.configuration?.autoAttachSelection === true)
  renderPhase(state)
  if (!elements.historyPanel.classList.contains('hidden')) renderSessions()
  renderSelectors(active)
  elements.keyBanner.classList.toggle('hidden', state.hasApiKey)
  elements.sessionTitle.textContent = active?.title || t('newConversation')
  elements.sessionTitle.disabled = !active || !!active.parentSessionId
  elements.backParent.classList.toggle('hidden', !active?.parentSessionId)
  elements.fork.disabled = !active || active.blank
  elements.loadOlder.classList.toggle('hidden', !active?.hasMore)
  renderMessages(active)
  renderInteractions(active)
  if (!elements.details.classList.contains('hidden')) renderDetails()
  renderComposer(active)
  updateCommandMenu()
  connectionSettings.update(
    payload.connectionSettings ?? { writable: false, providers: [] },
    payload.configuration?.provider ?? 'deepseek-official',
    active?.model?.provider,
  )
}

function renderPhase(state) {
  const phase = state.phase
  elements.connection.className = `connection ${phase}`
  elements.connection.textContent = phase === 'connected' ? t('connected') : phase === 'reconnecting' ? t('reconnecting') : phase === 'error' ? t('connectionError') : t('starting')
  const failed = phase === 'error'
  const loading = phase === 'idle' || phase === 'starting'
  elements.loading.classList.toggle('hidden', !loading)
  elements.error.classList.toggle('hidden', !failed)
  elements.chat.classList.toggle('hidden', loading || failed)
  if (failed) elements.errorMessage.textContent = state.error || t('unknownError')
}

function renderSessions() {
  if (!payload) return
  const query = elements.historySearch.value.trim()
  const snippets = new Map(searchResults.map((result) => [result.sessionId, result.snippet]))
  const resultIds = new Set(searchResults.map((result) => result.sessionId))
  const sessions = query === '' ? payload.state.sessions : payload.state.sessions.filter((session) => resultIds.has(session.id))
  const fragment = document.createDocumentFragment()
  for (const session of sessions) {
    const button = node('button', 'session-row')
    if (session.id === payload.state.active?.id) button.classList.add('active')
    const top = node('span', 'session-row-top')
    top.append(node('span', 'session-name', session.title), node('span', `running-dot${session.running ? ' active' : ''}`))
    const meta = node('span', 'session-meta', formatRelativeTime(session.updatedAt))
    if (session.agentPreset) meta.append(` · ${session.agentPreset}`)
    button.append(top, meta)
    const snippet = snippets.get(session.id)
    if (snippet) button.append(node('span', 'session-snippet', snippet))
    button.addEventListener('click', () => {
      composerConfiguration.reset()
      post('selectSession', { sessionId: session.id })
      toggleHistory(false)
    })
    fragment.append(button)
  }
  if (sessions.length === 0) fragment.append(node('p', 'muted-empty', t('noMatchingConversations')))
  elements.sessionList.replaceChildren(fragment)
}

function renderSelectors(active) {
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
  })
  if (nextSignature === selectorSignature) return
  selectorSignature = nextSignature
  composerConfiguration.update(composerConfigurationInput(payload))
  const permissions = active?.permissions
  if (permissions) {
    replaceOptions(elements.permission, permissionSelectOptions(permissions), permissions.currentValue)
    elements.permission.classList.remove('hidden')
    elements.permission.disabled = active.running || payload.state.phase !== 'connected'
  } else {
    elements.permission.classList.add('hidden')
  }
}

function replaceOptions(select, options, selected) {
  const fragment = document.createDocumentFragment()
  for (const item of options) {
    const option = document.createElement('option')
    option.value = item.id
    option.textContent = item.label || item.name || item.id
    option.title = item.description || ''
    option.selected = item.id === selected
    option.disabled = item.disabled === true
    fragment.append(option)
  }
  select.replaceChildren(fragment)
}

function renderMessages(active) {
  const messages = active?.messages || []
  const sessionId = active?.id || ''
  const sessionChanged = sessionId !== renderedSessionId
  const shouldStick = sessionChanged || isNearBottom(elements.conversation)
  const previousTop = elements.conversation.scrollTop
  const previousHeight = elements.conversation.scrollHeight
  const previousFirstId = elements.messages.firstElementChild?.dataset.messageId
  const existing = new Map([...elements.messages.children].map((element) => [element.dataset.messageId, element]))
  const retained = new Set()
  let cursor = elements.messages.firstElementChild

  for (const item of messages) {
    const id = String(item.id)
    const signature = messageSignature(item)
    let element = existing.get(id)
    if (!element) {
      element = renderMessage(item)
      setMessageMetadata(element, id, signature)
    } else if (messageSignatures.get(element) !== signature) {
      if (patchStreamingMessage(element, item)) {
        messageSignatures.set(element, signature)
      } else {
        const wasCursor = element === cursor
        const disclosureState = captureDisclosures(element)
        const replacement = renderMessage(item)
        restoreDisclosures(replacement, disclosureState)
        setMessageMetadata(replacement, id, signature)
        element.replaceWith(replacement)
        element = replacement
        if (wasCursor) cursor = replacement
      }
    }
    retained.add(id)
    if (element !== cursor) elements.messages.insertBefore(element, cursor)
    cursor = element.nextElementSibling
  }

  for (const [id, element] of existing) {
    if (!retained.has(id)) element.remove()
  }
  elements.empty.classList.toggle('hidden', messages.length > 0)
  const prepended = !sessionChanged && previousFirstId !== undefined
    && messages.findIndex((item) => String(item.id) === previousFirstId) > 0
  if (shouldStick) {
    elements.conversation.scrollTop = elements.conversation.scrollHeight
  } else if (prepended) {
    elements.conversation.scrollTop = previousTop + elements.conversation.scrollHeight - previousHeight
  } else {
    // Streaming below the viewport must not steal the reader's position.
    elements.conversation.scrollTop = previousTop
  }
  renderedSessionId = sessionId
}

function renderMessage(item) {
  if (item.kind === 'tool') return renderTool(item)
  if (item.kind === 'context') return renderContext(item)
  if (item.kind === 'notice') {
    const notice = node('div', `notice ${item.status || ''}`)
    notice.append(node('strong', '', item.title || t('status')))
    if (item.detail) notice.append(node('span', '', item.detail))
    workDuration.update(notice, item.workDuration)
    return notice
  }
  const article = node('article', `message ${item.role || ''}`)
  const label = node('div', 'message-label', item.role === 'user' ? t('you') : 'DeepSeek')
  article.append(label)
  const body = node('div', 'message-body')
  streamingMessage.render(body, item)
  article.append(body)
  workDuration.update(article, item.workDuration)
  return article
}

function renderTool(item) {
  const container = node('div', 'tool-item')
  const details = node('details', `tool-card ${item.status || ''}`)
  details.dataset.disclosureKey = 'tool'
  const summary = node('summary')
  summary.append(node('span', 'tool-status'), node('span', 'tool-title', item.title || t('tool')))
  details.append(summary)
  if (item.detail) details.append(node('pre', 'tool-detail', item.detail))
  container.append(details)
  workDuration.update(container, item.workDuration)
  return container
}

function renderContext(item) {
  const details = node('details', 'context-card')
  details.dataset.disclosureKey = 'context'
  details.append(node('summary', '', item.title || t('context')))
  const text = (item.blocks || []).map((block) => block.text).join('\n')
  details.append(node('pre', '', text))
  return details
}

function renderInteractions(active) {
  const nextSignature = JSON.stringify({
    sessionId: active?.id,
    approvals: active?.approvals || [],
    questions: active?.questions || [],
  })
  if (nextSignature === interactionSignature) return
  interactionSignature = nextSignature
  const fragment = document.createDocumentFragment()
  for (const approval of active?.approvals || []) {
    const card = node('section', 'interaction-card warning')
    card.append(node('strong', '', t('approvalRequired', { tool: approval.toolName })))
    if (approval.reason) card.append(node('p', '', approval.reason))
    const actions = node('div', 'interaction-actions')
    const reject = node('button', 'secondary-button', t('reject'))
    reject.addEventListener('click', () => post('answerApproval', { key: approval.key, outcome: 'rejected' }))
    const allow = node('button', 'primary-button', t('allowOnce'))
    allow.addEventListener('click', () => post('answerApproval', { key: approval.key, outcome: 'allowed-once' }))
    actions.append(reject, allow)
    card.append(actions)
    fragment.append(card)
  }
  for (const pending of active?.questions || []) fragment.append(renderQuestions(pending))
  elements.interactions.replaceChildren(fragment)
}

function renderQuestions(pending) {
  const form = node('form', 'interaction-card question-card')
  form.append(node('strong', '', t('questionRequired')))
  for (const question of pending.questions) {
    const fieldset = document.createElement('fieldset')
    const legend = node('legend', '', question.header || question.question)
    fieldset.append(legend)
    if (question.header) fieldset.append(node('p', 'question-text', question.question))
    if (question.detail) fieldset.append(node('pre', 'question-detail', question.detail))
    for (const option of question.options) {
      const label = node('label', 'question-option')
      const input = document.createElement('input')
      input.type = question.multiSelect ? 'checkbox' : 'radio'
      input.name = `question-${question.id}`
      input.value = option.label
      label.append(input, node('span', '', option.label))
      if (option.description) label.append(node('small', '', option.description))
      fieldset.append(label)
    }
    const custom = document.createElement('input')
    custom.className = 'custom-answer'
    custom.name = `custom-${question.id}`
    custom.placeholder = t('otherAnswer')
    fieldset.append(custom)
    form.append(fieldset)
  }
  const submit = node('button', 'primary-button', t('submitAnswer'))
  submit.type = 'submit'
  form.append(submit)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const answers = pending.questions.map((question) => ({
      id: question.id,
      selected: [...form.querySelectorAll(`[name="question-${cssEscape(question.id)}"]:checked`)].map((input) => input.value),
      custom: form.querySelector(`[name="custom-${cssEscape(question.id)}"]`)?.value || undefined,
    }))
    post('answerQuestions', { key: pending.key, answers })
  })
  return form
}

function renderDetails() {
  if (!payload) return
  const active = payload.state.active
  const nextSignature = JSON.stringify({
    sessionId: active?.id,
    currentDetail,
    todos: active?.todos,
    plan: active?.plan,
    goal: active?.goal,
    skills: active?.skills,
    subagents: active?.subagents,
    jobs: active?.jobs,
    running: active?.running,
  })
  if (nextSignature === detailSignature) return
  detailSignature = nextSignature
  elements.todoCount.textContent = String(active?.todos.length || 0)
  elements.skillCount.textContent = String(active?.skills.length || 0)
  elements.jobCount.textContent = String(active?.jobs.length || 0)
  elements.agentCount.textContent = String(active?.subagents.length || 0)
  for (const tab of document.querySelectorAll('[data-detail]')) tab.classList.toggle('active', tab.dataset.detail === currentDetail)
  const fragment = document.createDocumentFragment()
  if (currentDetail === 'todos') {
    if (active?.plan) {
      const mode = node('div', 'plan-mode-row')
      const text = active.plan.pending ? t('planChanging') : active.plan.active ? t('planEnabled') : t('planDisabled')
      mode.append(node('span', '', text))
      const toggle = node('button', 'secondary-button', active.plan.active ? t('disable') : t('enable'))
      toggle.disabled = active.plan.pending || active.running
      toggle.addEventListener('click', () => post('setPlan', { active: !active.plan.active }))
      mode.append(toggle)
      fragment.append(mode)
    }
    for (const todo of active?.todos || []) {
      const row = node('div', `todo-row ${todo.status}`)
      row.append(node('span', 'todo-check', todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '●' : '○'), node('span', '', todo.content))
      fragment.append(row)
    }
  } else if (currentDetail === 'goal') {
    const goal = active?.goal
    if (!goal) {
      const create = node('button', 'primary-button', t('createGoal'))
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
      const button = node('button', 'skill-row')
      button.append(node('strong', '', `/${skill.name}`), node('span', '', skill.description))
      button.addEventListener('click', () => {
        elements.prompt.value = `/${skill.name} `
        resizePrompt()
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
      const button = node('button', 'subagent-row')
      button.append(node('span', `job-status ${agent.activity}`), node('strong', '', agent.label || `Agent ${agent.id.slice(0, 8)}`))
      button.append(node('small', '', `${agent.mode === 'continuable' ? t('continuableConversation') : t('oneShot')}${agent.hasChildren ? t('hasChildAgents') : ''}`))
      button.addEventListener('click', () => {
        composerConfiguration.reset()
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
  }
  if (!fragment.childNodes.length) fragment.append(node('p', 'muted-empty', t('noContent')))
  elements.detailContent.replaceChildren(fragment)
}

function goalButton(label, action, secondary = false) {
  const button = node('button', secondary ? 'secondary-button' : 'primary-button', label)
  button.addEventListener('click', () => post('mutateGoal', { action }))
  return button
}

function goalPhaseLabel(phase) {
  if (phase === 'active') return t('goalPhaseActive')
  if (phase === 'paused') return t('goalPhasePaused')
  if (phase === 'blocked') return t('goalPhaseBlocked')
  return t('goalPhaseComplete')
}

function renderComposer(active) {
  const ready = payload.state.phase === 'connected' || payload.state.phase === 'reconnecting'
  elements.prompt.disabled = !ready
  if (active?.subagentMode === 'one-shot') elements.prompt.disabled = true
  elements.send.disabled = !ready || (!active?.running && elements.prompt.value.trim() === '')
  elements.send.textContent = active?.running ? '■' : '↑'
  elements.send.title = active?.running ? t('stopGenerating') : t('sendTitle')
  contextMeter.update(active?.contextPressure)
  elements.composerStatus.textContent = composerStatusText(active, {
    oneShotReadOnly: t('oneShotReadOnly'),
    runningQueue: t('runningQueue'),
    continuableSubagent: t('continuableSubagent'),
  })
}

function updateCommandMenu() {
  const active = payload?.state?.active
  const token = currentCommandToken(elements.prompt)
  if (token === undefined || !active) {
    closeCommandMenu()
    return
  }
  if (!menuState || menuState.query !== token) menuState = { query: token, index: 0, items: [] }
  const commands = active.commands || []
  if (menuLoadedSession !== active.id && commands.every((command) => command.kind === 'extension')) {
    menuLoadedSession = active.id
    post('loadCommands')
  }
  const query = token.toLowerCase()
  const items = commands.filter((command) => {
    const name = command.name.toLowerCase()
    return query === '' || name.includes(query) || command.description.toLowerCase().includes(query)
  })
  items.sort((left, right) => rank(left.name, query) - rank(right.name, query))
  menuState.items = items
  if (menuState.index >= items.length) menuState.index = Math.max(0, items.length - 1)
  renderCommandMenu()
}

function currentCommandToken(textarea) {
  const before = textarea.value.slice(0, textarea.selectionStart)
  const match = /(?:^|\s)\/([a-zA-Z0-9_-]*)$/.exec(before)
  return match ? match[1] : undefined
}

function rank(name, query) {
  if (query === '') return 0
  return name.toLowerCase().startsWith(query) ? 0 : 1
}

function renderCommandMenu() {
  const menu = elements.commandMenu
  if (!menuState || menuState.items.length === 0) {
    menu.classList.add('hidden')
    menu.replaceChildren()
    return
  }
  const fragment = document.createDocumentFragment()
  menuState.items.forEach((command, index) => {
    const button = node('button', `command-menu-item${index === menuState.index ? ' active' : ''}`)
    button.type = 'button'
    button.setAttribute('role', 'option')
    button.setAttribute('aria-selected', String(index === menuState.index))
    const name = node('span', 'command-name', `/${command.name}`)
    const desc = node('span', 'command-desc', command.description)
    button.append(name, desc)
    if (command.input?.hint) button.append(node('span', 'command-hint', command.input.hint))
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', () => chooseCommand(command))
    fragment.append(button)
  })
  menu.replaceChildren(fragment)
  menu.classList.remove('hidden')
}

function chooseCommand(command) {
  closeCommandMenu()
  if (command.kind === 'extension') {
    if (command.name === 'model') composerConfiguration.open('model')
    else if (command.name === 'reasoning') composerConfiguration.open('reasoning')
    else if (command.name === 'preset') composerConfiguration.open('preset')
    return
  }
  insertCommand(command.name)
}

function insertCommand(name) {
  elements.prompt.value = `/${name} `
  resizePrompt()
  elements.prompt.focus()
  elements.prompt.setSelectionRange(elements.prompt.value.length, elements.prompt.value.length)
}

function closeCommandMenu() {
  menuState = null
  elements.commandMenu.classList.add('hidden')
  elements.commandMenu.replaceChildren()
}

function sendPrompt() {
  closeCommandMenu()
  fileMention.close()
  composerConfiguration.close()
  const text = elements.prompt.value.trim()
  if (!text) return
  const configuration = composerConfiguration.selection()
  composerConfiguration.markSubmitted()
  post('sendPrompt', {
    text,
    mode: 'queue',
    context: editorContext.input(),
    ...(configuration === undefined ? {} : { configuration }),
  })
  editorContext.markSubmitted()
  elements.prompt.value = ''
  resizePrompt()
}

function resizePrompt() {
  elements.prompt.style.height = 'auto'
  elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight, 180)}px`
  if (payload) renderComposer(payload.state.active)
}

function toggleHistory(open) {
  if (open) pluginCenter.close()
  elements.historyPanel.classList.toggle('hidden', !open)
  if (open) {
    renderSessions()
    elements.historySearch.focus()
  }
}

function post(type, data = {}) {
  vscode.postMessage({ type, ...data })
}

function node(tag, className = '', text = '') {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text) element.textContent = text
  return element
}

function messageSignature(item) {
  return JSON.stringify(item)
}

function setMessageMetadata(element, id, signature) {
  element.dataset.messageId = id
  messageSignatures.set(element, signature)
}

/** Mutates only text inside the active assistant card for smooth token flow. */
function patchStreamingMessage(element, item) {
  if (item.kind !== 'message' || element.tagName !== 'ARTICLE') return false
  const body = element.querySelector('.message-body')
  if (!body) return false
  if (!streamingMessage.patch(body, item)) return false
  workDuration.update(element, item.workDuration)
  return true
}

function captureDisclosures(root) {
  const state = new Map()
  for (const details of disclosureElements(root)) state.set(details.dataset.disclosureKey || '', details.open)
  return state
}

function restoreDisclosures(root, state) {
  for (const details of disclosureElements(root)) {
    if (details.dataset.autoOpen === 'true') details.open = true
    else if (details.dataset.autoOpen === 'false') details.open = false
    else details.open = state.get(details.dataset.disclosureKey || '') === true
  }
}

function disclosureElements(root) {
  const descendants = [...root.querySelectorAll('details')]
  return root.tagName === 'DETAILS' ? [root, ...descendants] : descendants
}

function isNearBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 100
}

function formatRelativeTime(time) {
  const delta = Date.now() - time
  if (delta < 60_000) return t('justNow')
  if (delta < 3_600_000) return t('minutesAgo', { count: Math.floor(delta / 60_000) })
  if (delta < 86_400_000) return t('hoursAgo', { count: Math.floor(delta / 3_600_000) })
  return new Date(time).toLocaleDateString()
}

function cssEscape(value) {
  return window.CSS?.escape ? window.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
}

function copyText(text) {
  if (navigator.clipboard?.writeText !== undefined) {
    navigator.clipboard.writeText(text).catch(() => legacyCopy(text))
  } else {
    legacyCopy(text)
  }
}

function legacyCopy(text) {
  const area = document.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  try {
    document.execCommand('copy')
  } catch {
    // Clipboard unavailable; the user can still select the text manually.
  }
  area.remove()
}

vscode.postMessage({ type: 'ready' })
