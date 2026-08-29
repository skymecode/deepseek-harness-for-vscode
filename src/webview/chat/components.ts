import { createComposerConfigurationComponent } from '../composer-configuration/component.js'
import { createConnectionSettingsComponent } from '../connection-settings/component.js'
import { createContextMeterComponent } from '../context-meter/component.js'
import { createEditorContextComponent } from '../editor-context/component.js'
import { createFileMentionComponent } from '../file-mention/component.js'
import { renderMarkdown } from '../markdown.js'
import { createPluginCenterComponent } from '../plugin-center/component.js'
import { createSessionChangesComponent } from '../session-changes/component.js'
import { StreamingMessageComponent } from '../streaming-message/component.js'
import { createWorkDurationComponent } from '../work-duration/component.js'
import { formatWorkDuration } from '../work-duration/format.js'
import { renderComposer } from './composer-core.js'
import { closeCommandMenu } from './command-menu.js'
import { components, elements, followStream, interactionArmed, payload, post, t } from './context.js'
import { markdownActions } from './markdown-actions.js'
import { toggleHistory } from './sessions.js'
import { formatTokenCount, isNearBottom, pinConversationToBottom } from './utils.js'

const connectionTranslate = (key: string, values?: Record<string, string | number>): string =>
  t(key as Parameters<typeof t>[0], values)

components.composerConfiguration = createComposerConfigurationComponent({
  document,
  translate: t,
  onChange: () => renderComposer(payload?.state.active),
  onOpen: () => {
    closeCommandMenu()
    components.connectionSettings.close()
  },
})

components.connectionSettings = createConnectionSettingsComponent({
  document,
  translate: connectionTranslate,
  post,
  onOpen: () => {
    components.composerConfiguration.close()
    closeCommandMenu()
  },
})

components.contextMeter = createContextMeterComponent({ document, translate: t })

components.editorContext = createEditorContextComponent({
  document,
  translate: t,
  onRequestSelection: () => post('attachSelection'),
  onOpenFile: (reference) => post('openFile', reference),
})

components.fileMention = createFileMentionComponent({
  document,
  prompt: elements.prompt,
  translate: t,
  onSearch: (query, requestId) => post('searchWorkspaceFiles', { query, requestId }),
  onChoose: (file) => components.editorContext.addFile(file),
  onOpen: closeCommandMenu,
})

components.workDuration = createWorkDurationComponent({ document, translate: t })

components.sessionChanges = createSessionChangesComponent({
  document,
  translate: t,
  onOpenFile: (path) => post('openFile', { path }),
  onReview: () => post('sessionChangesReview'),
})

components.streamingMessage = new StreamingMessageComponent({
  document,
  reasoningLabel: () => t('reasoningProcess'),
  thinkingLabel: (tokens) => tokens === undefined
    ? t('thinking')
    : t('thinkingWithTokens', { tokens: formatTokenCount(tokens) }),
  reasoningDoneLabel: (elapsed, tokens) => tokens === undefined
    ? t('thoughtFor', { duration: formatWorkDuration(elapsed) })
    : t('thoughtForWithTokens', { duration: formatWorkDuration(elapsed), tokens: formatTokenCount(tokens) }),
  renderMarkdown: (target, source) => renderMarkdown(target, source, markdownActions),
  onStreamFrame: () => {
    // A pending pointer interaction (scrollbar grab, text selection) pauses
    // the pin so the reader's cursor never fights the auto-scroll.
    if (followStream && !interactionArmed && isNearBottom(elements.conversation)) {
      pinConversationToBottom()
    }
  },
})

components.pluginCenter = createPluginCenterComponent({
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
