/**
 * Public wire shapes for dsh-api-gateway's `$events` stream. The upstream
 * stream-protocol module is internal, so keep this adapter at the transport
 * boundary instead of importing a private package path or casting in the UI.
 */
export type RemoteEvent =
  | { readonly type: 'ready'; readonly clientId: string }
  | { readonly type: 'emit'; readonly event: string; readonly args: readonly unknown[] }
  | RemoteWaterfallEvent
  | { readonly type: 'cancel'; readonly eventId: string }

export interface RemoteWaterfallEvent {
  readonly type: 'waterfall'
  readonly event: string
  readonly eventId: string
  /** Authoritative owner, including a child session for subagent requests. */
  readonly agentId: string
  readonly request: Readonly<Record<string, unknown>>
}

export type RemoteEventOutcome =
  | { readonly kind: 'next' }
  | { readonly kind: 'result'; readonly value?: unknown }
  | { readonly kind: 'rejected'; readonly error: { readonly name: string; readonly message: string; readonly code?: string; readonly details?: unknown } }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Fail closed on malformed identity fields; never infer ownership from focus. */
export function parseRemoteEvent(value: unknown): RemoteEvent | undefined {
  if (!isRecord(value)) return undefined
  switch (value.type) {
    case 'ready':
      return isNonEmptyString(value.clientId) ? { type: 'ready', clientId: value.clientId } : undefined
    case 'emit':
      return isNonEmptyString(value.event) && Array.isArray(value.args)
        ? { type: 'emit', event: value.event, args: value.args }
        : undefined
    case 'cancel':
      return isNonEmptyString(value.eventId) ? { type: 'cancel', eventId: value.eventId } : undefined
    case 'waterfall':
      if (!isNonEmptyString(value.event) || !isNonEmptyString(value.eventId)
        || !isNonEmptyString(value.agentId) || !isRecord(value.request)) return undefined
      return { type: 'waterfall', event: value.event, eventId: value.eventId, agentId: value.agentId, request: value.request }
    default:
      return undefined
  }
}
