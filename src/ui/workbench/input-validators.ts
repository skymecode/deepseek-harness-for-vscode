/**
 * Pure parsers/validators for webview → host messages. Every function takes
 * the raw `Record<string, unknown>` a webview message carries and returns a
 * typed DTO or throws a localized error; none of them touches the gateway or
 * VS Code APIs beyond `l10n`.
 */
import * as vscode from 'vscode'
import type { ConnectionSettingsInput } from '../../domain/connection-settings.js'
import type { PromptAttachment, PromptImageMediaType } from '../../domain/prompt-context.js'
import type { OpenWorkspaceFileRequest } from '../../editor/types.js'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Whether an error is a transport timeout. AbortSignal.timeout() rejects with
 * a DOMException named "TimeoutError" whose message is "The operation was
 * aborted due to timeout"; some fetch stacks surface the message without the
 * name, so both are checked.
 */
export function isTimeoutError(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false
  const abortedByTimeout = /aborted due to timeout/u.test(cause.message)
  return cause.name === 'TimeoutError' || cause.name === 'AbortError' && abortedByTimeout || abortedByTimeout
}

export function requiredString(value: Record<string, unknown>, key: string): string {
  const item = value[key]
  if (typeof item !== 'string' || item.trim() === '') throw new Error(vscode.l10n.t('Invalid {0}.', key))
  return item
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

/** Coerces untrusted webview form values into the validated settings input shape. */
export function settingsInput(value: Record<string, unknown>): ConnectionSettingsInput {
  const provider = typeof value.provider === 'string' && value.provider !== '' ? value.provider : 'deepseek-official'
  const name = typeof value.name === 'string' ? value.name : ''
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl : ''
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey : ''
  const models = modelsInput(value.models)
  const modelContextWindows = modelContextWindowsInput(value.modelContextWindows)
  return { provider, name, baseUrl, apiKey, models, modelContextWindows, ...(typeof value.api === 'string' ? { api: value.api } : {}) }
}

/** Accepts an array of ids or a single comma/space-separated string. */
export function modelsInput(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (typeof value === 'string' && value.trim() !== '') {
    return value.split(/[,，\s]+/u).map((item) => item.trim()).filter((item) => item !== '')
  }
  return []
}

/** A model id → context window (tokens) map; non-positive or non-numeric entries are dropped. */
export function modelContextWindowsInput(value: unknown): Readonly<Record<string, number>> {
  if (!isRecord(value)) return {}
  const result: Record<string, number> = {}
  for (const [id, raw] of Object.entries(value)) {
    if (id === '' || typeof raw !== 'number' || !Number.isFinite(raw)) continue
    const tokens = Math.round(raw)
    if (tokens <= 0) continue
    result[id] = tokens
  }
  return result
}

/** Stable, cross-platform ZIP name for a session log export. */
export function exportFilename(sessionId: string): string {
  return `dsh-session-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.zip`
}

export function optionalHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return safeExternalUri(value)?.toString()
}

export function questionAnswers(value: unknown): { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[] {
  if (!Array.isArray(value)) throw new Error(vscode.l10n.t('Invalid question answer format.'))
  return value.map((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || !Array.isArray(item.selected)) {
      throw new Error(vscode.l10n.t('Invalid question answer format.'))
    }
    const selected = item.selected.filter((choice): choice is string => typeof choice === 'string')
    const custom = optionalString(item.custom)
    return { id: item.id, selected, ...(custom === undefined ? {} : { custom }) }
  })
}

/** Only ever hands out http(s) URLs to the external browser. */
export function safeExternalUri(raw: string): vscode.Uri | undefined {
  try {
    const uri = vscode.Uri.parse(raw)
    if (uri.scheme === 'http' || uri.scheme === 'https') return uri
  } catch {
    // Malformed URL: ignore.
  }
  return undefined
}

export function promptContextInput(value: unknown): { readonly selectionId?: string; readonly fileIds: readonly string[] } | undefined {
  if (!isRecord(value)) return undefined
  const selectionId = optionalString(value.selectionId)
  const fileIds = Array.isArray(value.fileIds)
    ? [...new Set(value.fileIds.filter((id): id is string => typeof id === 'string' && id !== ''))].slice(0, 8)
    : []
  return { ...(selectionId === undefined ? {} : { selectionId }), fileIds }
}

const PROMPT_IMAGE_MEDIA_TYPES: readonly PromptImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

export function promptImageAttachments(value: unknown): PromptAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(vscode.l10n.t('Invalid image attachment format.'))
  const images: PromptAttachment[] = []
  for (const item of value) {
    if (!isRecord(item)) throw new Error(vscode.l10n.t('Invalid image attachment format.'))
    const mediaType = item.mediaType
    const data = item.data
    const name = optionalString(item.name)
    if (
      typeof mediaType !== 'string'
      || !PROMPT_IMAGE_MEDIA_TYPES.includes(mediaType as PromptImageMediaType)
      || typeof data !== 'string'
      || data === ''
    ) {
      throw new Error(vscode.l10n.t('Invalid image attachment format.'))
    }
    images.push({
      kind: 'image',
      mediaType: mediaType as PromptImageMediaType,
      data,
      ...(name === undefined ? {} : { name }),
    })
  }
  return images
}

export function openFileRequest(value: Record<string, unknown>): OpenWorkspaceFileRequest {
  const id = optionalString(value.id)
  const filePath = optionalString(value.path)
  const line = numberValue(value.line)
  const column = numberValue(value.column)
  if (id === undefined && filePath === undefined) throw new Error(vscode.l10n.t('Invalid file reference.'))
  return {
    ...(id === undefined ? {} : { id }),
    ...(filePath === undefined ? {} : { path: filePath }),
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
  }
}

export function goalAction(value: unknown): 'pause' | 'resume' | 'complete' | 'clear' {
  if (value === 'pause' || value === 'resume' || value === 'complete' || value === 'clear') return value
  throw new Error(vscode.l10n.t('Invalid Goal action.'))
}

export function localizedOption(option: { readonly id: string; readonly label: string; readonly description?: string }): {
  readonly id: string
  readonly label: string
  readonly description?: string
} {
  return {
    id: option.id,
    label: vscode.l10n.t(option.label),
    ...(option.description === undefined ? {} : { description: vscode.l10n.t(option.description) }),
  }
}
