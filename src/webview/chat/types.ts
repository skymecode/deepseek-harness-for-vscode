import type { HarnessConfiguration } from '../../config/configuration.js'
import type { ConnectionSettingsState } from '../../domain/connection-settings.js'
import type {
  ChatBlock,
  CommandEntry,
  HarnessWorkbenchState,
} from '../../domain/workbench-state.js'
import type { ComposerConfigurationComponent } from '../composer-configuration/component.js'
import type { ConnectionSettingsComponent } from '../connection-settings/component.js'
import type { ContextMeterComponent } from '../context-meter/component.js'
import type { EditorContextComponent } from '../editor-context/component.js'
import type { FileMentionComponent } from '../file-mention/component.js'
import type { PluginCenterComponent } from '../plugin-center/component.js'
import type { SessionChangesComponent } from '../session-changes/component.js'
import type { StreamingMessageComponent } from '../streaming-message/component.js'
import type { WorkDurationComponent } from '../work-duration/component.js'

/** Minimal VS Code webview API surface used by the chat UI. */
export interface VSCodeApi {
  postMessage(message: unknown): void
}

export interface FallbackOption {
  readonly id: string
  readonly label: string
  readonly description?: string
}

/** The `state` message the Extension Host publishes into the webview. */
export interface WebviewStatePayload {
  readonly type: 'state'
  readonly state: HarnessWorkbenchState
  readonly configuration: HarnessConfiguration
  readonly connectionSettings: ConnectionSettingsState
  readonly fallbackOptions: {
    readonly sources: readonly FallbackOption[]
    readonly models: readonly FallbackOption[]
    readonly reasoning: readonly FallbackOption[]
    readonly presets: readonly FallbackOption[]
  }
}

export interface ChatElements {
  readonly connection: HTMLElement
  readonly historyToggle: HTMLElement
  readonly historyPanel: HTMLElement
  readonly historyClose: HTMLElement
  readonly historySearch: HTMLInputElement
  readonly sessionList: HTMLElement
  readonly newSession: HTMLElement
  readonly sessionTitle: HTMLButtonElement
  readonly backParent: HTMLElement
  readonly fork: HTMLButtonElement
  readonly importSession: HTMLElement
  readonly historyImport: HTMLElement
  readonly historyArchived: HTMLButtonElement
  readonly exportSession: HTMLElement
  readonly permission: HTMLElement
  readonly permissionToggle: HTMLButtonElement
  readonly permissionToggleLabel: HTMLElement
  readonly permissionPopup: HTMLElement
  readonly permissionOptions: HTMLElement
  readonly permissionConfirm: HTMLElement
  readonly permissionConfirmAccept: HTMLButtonElement
  readonly permissionConfirmCancel: HTMLButtonElement
  readonly keyBanner: HTMLElement
  readonly setApiKey: HTMLElement
  readonly openSettings: HTMLElement
  readonly loading: HTMLElement
  readonly error: HTMLElement
  readonly errorMessage: HTMLElement
  readonly retry: HTMLElement
  readonly showLogs: HTMLElement
  readonly chat: HTMLElement
  readonly conversation: HTMLElement
  readonly loadOlder: HTMLElement
  readonly empty: HTMLElement
  readonly messages: HTMLElement
  readonly details: HTMLElement
  readonly detailsToggle: HTMLElement
  readonly detailContent: HTMLElement
  readonly todoCount: HTMLElement
  readonly skillCount: HTMLElement
  readonly jobCount: HTMLElement
  readonly agentCount: HTMLElement
  readonly interactions: HTMLElement
  readonly prompt: HTMLTextAreaElement
  readonly imagePreviewList: HTMLElement
  readonly timelineToggle: HTMLElement
  readonly timelinePanel: HTMLElement
  readonly imageLightbox: HTMLElement
  readonly imageLightboxImage: HTMLImageElement
  readonly imageLightboxName: HTMLElement
  readonly imageLightboxClose: HTMLElement
  readonly commandMenu: HTMLElement
  readonly attachSelection: HTMLElement
  readonly send: HTMLButtonElement
  readonly composerStatus: HTMLElement
  readonly activityStatus: HTMLElement
  readonly compact: HTMLElement
  readonly queuedPanel: HTMLElement
}

/** Component instances shared across the chat modules. */
export interface ChatComponents {
  composerConfiguration: ComposerConfigurationComponent
  connectionSettings: ConnectionSettingsComponent
  contextMeter: ContextMeterComponent
  editorContext: EditorContextComponent
  fileMention: FileMentionComponent
  sessionChanges: SessionChangesComponent
  workDuration: WorkDurationComponent
  streamingMessage: StreamingMessageComponent
  pluginCenter: PluginCenterComponent
}

export interface PastedImage {
  readonly id: string
  readonly mediaType: string
  readonly data: string
  readonly name?: string
  readonly previewUrl: string
}

/** A locally echoed user bubble waiting for the authoritative user/message. */
export interface OptimisticBubble {
  readonly id: string
  readonly seq: number
  readonly kind: 'message'
  readonly role: 'user'
  readonly time: number
  readonly text: string
  readonly imageCount: number
  readonly blocks: readonly ChatBlock[]
}

export interface SearchResult {
  readonly sessionId: string
  readonly snippet: string
}

export interface CommandMenuState {
  readonly query: string
  index: number
  items: readonly CommandEntry[]
}
