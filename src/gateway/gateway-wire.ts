import type { ModelSelection as DshModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ModelProviderGroup as DshModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ModelCatalogFailure as DshModelCatalogFailure } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionAddress as DshSessionAddress } from '@deepseek-ai/dsh-api-session-controller/types'
/**
 * Gateway wire-type mapping for the dsh 0.1.7 Typert Remote protocol.
 *
 * dsh 0.1.2 replaced the host-apiproxy / client-connection domain clients
 * with the Typert Remote wire (unary `POST /api/<ns>/<method>` + the
 * `/api/remote.mux` WebSocket). This module is the single type seam that
 * keeps the old workbench vocabulary compiling against the new wire shapes:
 * names stay, sources change, and the handful of renamed fields are bridged
 * here so call sites keep their meaning.
 */
import type { PromptContentPart as WirePromptContentPart } from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  SessionControlFrame as WireControlFrame,
  SessionEventEntry,
  SessionFollowFrame as WireFollowFrame,
  SessionPage as WirePage,
  SessionSummary as WireSessionSummary,
  SkillEntry as WireSkillEntry,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  SubagentAddress as WireSubagentAddress,
  SubagentListEntry as WireSubagentListEntry,
} from '@deepseek-ai/dsh-subagent/client'
import type { JobView as DshJobView } from '@deepseek-ai/dsh-api-job-controller/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'

export type { SessionId } from '@deepseek-ai/dsh-session/types'
export type { RpcId, ConnectionRpcResult as RpcResult, ConnectionRpcFailure as RpcFailure } from '@deepseek-ai/dsh-client-connection'
export type { MessageId } from '@deepseek-ai/dsh-llm/brand'

/** One raw conversation event, as consumed by the workbench projections. */
export interface HistoryEntry {
  readonly event: SessionEvent | PresentationChunkEvent
}

/** Display-only adapter event. Never persisted or used as a pagination cursor. */
export interface PresentationChunkEvent {
  readonly type: 'assistant/chunk'
  readonly seq: number
  readonly time: number
  readonly data: { readonly turn: number; readonly step: number; readonly chunk: StreamChunk }
}

/** Session list row; `agentPreset` is an extension-side memo carried by the summary. */
export type SessionSummary = WireSessionSummary & { readonly agentPreset?: string }

/** Live queue row; content blocks are JSON-safe wire values. */
export type { QueuedInboxItem } from './inbox-projection.js'

/** Background job row exposed by the native `job` Remote namespace. */
export type JobView = DshJobView

/** Skill catalog entry (same shape, new home). */
export type SkillEntry = WireSkillEntry

/** Sub-agent catalog entry. */
export type SubagentListEntry = WireSubagentListEntry

/** Durable parent/child address selecting subagent transport. */
export type SubagentAddress = WireSubagentAddress

/** One prompt part accepted by the session/subagent prompt RPCs. */
export type PromptContentPart = WirePromptContentPart

/** Model catalog with the current selection carried on `current` (default + local memo). */
export type SessionModels = {
  readonly default: DshModelSelection
  readonly current: DshModelSelection
  readonly groups: readonly DshModelProviderGroup[]
  readonly failures: readonly DshModelCatalogFailure[]
  readonly routableProviders: readonly string[]
}

/** V2/V3/V4 history embeds compact timed streams in durable assistant events. */
export type SessionHistoryRecord = SessionEventEntry

/** One session event stream frame (snapshot + delta) from `session/follow`. */
export type FollowFrame = WireFollowFrame

/** Host-wide live state stream frame from `session/control`. */
export type ControlFrame = WireControlFrame

/** One backward history page. */
export type SessionPage = WirePage

/** Session-address discriminator (ordinary session or direct subagent child). */
export type SessionAddress = DshSessionAddress

export type { RemoteEvent } from './remote-event-protocol.js'

/** Stable remote-endpoint function descriptors for the typed client seam. */
export interface RemoteRpc {
  call<T>(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T>
  stream(endpoint: string, args: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<unknown>
}

/** Local session id brand helper (mints a v4-like id; callers persist it). */
export function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Stringifies a session address for log / map keys. */
export function addressKey(address: SessionAddress): string {
  return address.kind === 'session' ? `session:${String(address.sessionId)}` : `subagent:${String(address.parentSessionId)}/${String(address.childSessionId)}`
}
