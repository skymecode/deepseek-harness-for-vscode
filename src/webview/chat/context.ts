import { createWebviewTranslator, type MessageArguments, type WebviewMessageKey } from '../localization.js'
import type { ChatComponents, ChatElements, CommandMenuState, OptimisticBubble, PastedImage, SearchResult, VSCodeApi, WebviewStatePayload } from './types.js'

declare function acquireVsCodeApi(): VSCodeApi

export const vscode = acquireVsCodeApi()
export const t = createWebviewTranslator()

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (element === null) throw new Error(`Missing webview element #${id}`)
  return element as T
}

export const elements: ChatElements = {
  connection: byId<HTMLElement>('connection'),
  historyToggle: byId<HTMLElement>('history-toggle'),
  historyPanel: byId<HTMLElement>('history-panel'),
  historyClose: byId<HTMLElement>('history-close'),
  historySearch: byId<HTMLInputElement>('history-search'),
  sessionList: byId<HTMLElement>('session-list'),
  newSession: byId<HTMLElement>('new-session'),
  sessionTitle: byId<HTMLButtonElement>('session-title'),
  backParent: byId<HTMLElement>('back-parent'),
  fork: byId<HTMLButtonElement>('fork'),
  importSession: byId<HTMLElement>('import-session'),
  historyImport: byId<HTMLElement>('history-import'),
  historyArchived: byId<HTMLButtonElement>('history-archived'),
  exportSession: byId<HTMLElement>('export-session'),
  permission: byId<HTMLElement>('permission'),
  permissionToggle: byId<HTMLButtonElement>('permission-toggle'),
  permissionToggleLabel: byId<HTMLElement>('permission-toggle-label'),
  permissionPopup: byId<HTMLElement>('permission-popup'),
  permissionOptions: byId<HTMLElement>('permission-options'),
  permissionConfirm: byId<HTMLElement>('permission-confirm'),
  permissionConfirmAccept: byId<HTMLButtonElement>('permission-confirm-accept'),
  permissionConfirmCancel: byId<HTMLButtonElement>('permission-confirm-cancel'),
  keyBanner: byId<HTMLElement>('key-banner'),
  setApiKey: byId<HTMLElement>('set-api-key'),
  openSettings: byId<HTMLElement>('open-settings'),
  loading: byId<HTMLElement>('loading'),
  error: byId<HTMLElement>('error'),
  errorMessage: byId<HTMLElement>('error-message'),
  retry: byId<HTMLElement>('retry'),
  showLogs: byId<HTMLElement>('show-logs'),
  chat: byId<HTMLElement>('chat'),
  conversation: byId<HTMLElement>('conversation'),
  loadOlder: byId<HTMLElement>('load-older'),
  empty: byId<HTMLElement>('empty'),
  messages: byId<HTMLElement>('messages'),
  details: byId<HTMLElement>('details'),
  detailsToggle: byId<HTMLElement>('details-toggle'),
  detailContent: byId<HTMLElement>('detail-content'),
  todoCount: byId<HTMLElement>('todo-count'),
  skillCount: byId<HTMLElement>('skill-count'),
  jobCount: byId<HTMLElement>('job-count'),
  agentCount: byId<HTMLElement>('agent-count'),
  interactions: byId<HTMLElement>('interactions'),
  prompt: byId<HTMLTextAreaElement>('prompt'),
  imagePreviewList: byId<HTMLElement>('image-preview-list'),
  timelineToggle: byId<HTMLElement>('timeline-toggle'),
  timelinePanel: byId<HTMLElement>('timeline-panel'),
  imageLightbox: byId<HTMLElement>('image-lightbox'),
  imageLightboxImage: byId<HTMLImageElement>('image-lightbox-image'),
  imageLightboxName: byId<HTMLElement>('image-lightbox-name'),
  imageLightboxClose: byId<HTMLElement>('image-lightbox-close'),
  commandMenu: byId<HTMLElement>('command-menu'),
  attachSelection: byId<HTMLElement>('attach-selection'),
  send: byId<HTMLButtonElement>('send'),
  composerStatus: byId<HTMLElement>('composer-status'),
  activityStatus: byId<HTMLElement>('activity-status'),
  compact: byId<HTMLElement>('compact'),
  queuedPanel: byId<HTMLElement>('queued-panel'),
}

export function post(type: string, data: Record<string, unknown> = {}): void {
  vscode.postMessage({ type, ...data })
}

export function node(tag: string, className = '', text = ''): HTMLElement {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text) element.textContent = text
  return element
}

// ---------------------------------------------------------------------------
// Mutable chat state. Modules read/write these through the shared context.
// ---------------------------------------------------------------------------

export let payload: WebviewStatePayload | undefined
export function setPayload(value: WebviewStatePayload | undefined): void {
  payload = value
}

export let currentDetail = 'todos'
export function setCurrentDetail(value: string): void {
  currentDetail = value
}

export let renderedSessionId = ''
export function setRenderedSessionId(value: string): void {
  renderedSessionId = value
}

export let stickToBottomOnLoad = false
export function setStickToBottomOnLoad(value: boolean): void {
  stickToBottomOnLoad = value
}

export let pastedImages: readonly PastedImage[] = []
export function setPastedImages(value: readonly PastedImage[]): void {
  pastedImages = value
}

export let startupComplete = false
export function setStartupComplete(value: boolean): void {
  startupComplete = value
}

export const messageSignatures = new WeakMap<HTMLElement, string>()

export let searchResults: readonly SearchResult[] = []
export function setSearchResults(value: readonly SearchResult[]): void {
  searchResults = value
}

export let searchTimer: ReturnType<typeof setTimeout> | undefined
export function setSearchTimer(value: ReturnType<typeof setTimeout> | undefined): void {
  searchTimer = value
}

export let menuState: CommandMenuState | null = null
export function setMenuState(value: CommandMenuState | null): void {
  menuState = value
}

export let menuLoadedSession: string | undefined
export function setMenuLoadedSession(value: string | undefined): void {
  menuLoadedSession = value
}

export let queuedEditingId: string | null = null
export function setQueuedEditingId(value: string | null): void {
  queuedEditingId = value
}

export let optimisticBubbles: readonly OptimisticBubble[] = []
export function setOptimisticBubbles(value: readonly OptimisticBubble[]): void {
  optimisticBubbles = value
}

export let optimisticSeq = 0
export function setOptimisticSeq(value: number): void {
  optimisticSeq = value
}

export let selectorSignature = ''
export function setSelectorSignature(value: string): void {
  selectorSignature = value
}

export let interactionSignature = ''
export function setInteractionSignature(value: string): void {
  interactionSignature = value
}

export let detailSignature = ''
export function setDetailSignature(value: string): void {
  detailSignature = value
}

export let queuedSignature = ''
export function setQueuedSignature(value: string): void {
  queuedSignature = value
}

/** Populated by components.ts before any render runs. */
export const components = {} as ChatComponents

export type { MessageArguments, WebviewMessageKey }
