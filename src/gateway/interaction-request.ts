import type { PendingApprovalView, PendingQuestionView, QuestionOptionView } from '../domain/workbench-state.js'
import { isNonEmptyString, isRecord, type RemoteWaterfallEvent } from './remote-event-protocol.js'

export type InteractionView =
  | { readonly kind: 'approval'; readonly view: PendingApprovalView }
  | { readonly kind: 'question'; readonly view: PendingQuestionView }

/** Translate actionable requests, not the similarly named durable audit events. */
export function projectInteractionRequest(frame: RemoteWaterfallEvent, key: string): InteractionView | undefined {
  const request = frame.request
  if (frame.event === 'approval/request') {
    if (!isNonEmptyString(request.toolName)) return undefined
    return {
      kind: 'approval',
      view: { key, toolName: request.toolName, ...(typeof request.reason === 'string' ? { reason: request.reason } : {}) },
    }
  }
  if (frame.event !== 'user-questions/request' || !Array.isArray(request.questions) || request.questions.length === 0) return undefined
  const questions: PendingQuestionView['questions'][number][] = []
  const ids = new Set<string>()
  for (const item of request.questions) {
    if (!isRecord(item) || !isNonEmptyString(item.id) || !isNonEmptyString(item.question) || ids.has(item.id)) return undefined
    const options = projectOptions(item.options)
    if (options === undefined) return undefined
    ids.add(item.id)
    questions.push({
      id: item.id,
      question: item.question,
      ...(typeof item.header === 'string' ? { header: item.header } : {}),
      ...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
      options,
      multiSelect: item.multiSelect === true,
    })
  }
  return { kind: 'question', view: { key, questions } }
}

function projectOptions(value: unknown): readonly QuestionOptionView[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const options: QuestionOptionView[] = []
  for (const item of value) {
    if (!isRecord(item) || !isNonEmptyString(item.label)) return undefined
    options.push({ label: item.label, ...(typeof item.description === 'string' ? { description: item.description } : {}) })
  }
  return options
}
