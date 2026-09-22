/**
 * Domain request/response types for the Typert Remote session surface.
 *
 * Re-exports the authoritative shapes from the upstream controller packages
 * and adds the small extension-facing unions the workbench consumes. Kept in
 * one module so the gateway client and the workbench service share a single
 * vocabulary (dsh 0.1.2 renamed the old `sessions.*` client into the
 * `session/*` remote namespace).
 */
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
export type { WorkspaceArchiveValue, WorkspaceFollowFrame } from '@deepseek-ai/dsh-api-workspace-controller/types'

export type {
  SessionAddress,
  SessionControlFrame,
  SessionCreateRequest,
  SessionCreateValue,
  SessionFollowFrame,
  SessionFollowRequest,
  SessionListValue,
  SessionPage,
  SessionPageRequest,
  SessionPromptRequest,
  SessionPromptValue,
  SessionRenameValue,
  SessionSearchValue,
  SessionSelectModelValue,
  SessionSummary,
  SessionUpdateQueueValue,
  SkillEntry,
  SkillListValue,
} from '@deepseek-ai/dsh-api-session-controller/types'

/** One client-requested mutation of a pending queue item. */
export type SessionQueueMutation =
  | { readonly kind: 'edit'; readonly content: readonly { readonly type: 'text'; readonly text: string }[] }
  | { readonly kind: 'remove' }
  | { readonly kind: 'steer' }

/** One session-list item, extended with the local agentPreset memo. */
export type SessionListItem = SessionSummary & { readonly agentPreset?: string }

/** Session queue view (the item's content is JSON-safe wire values). */
export type { QueuedInboxItem as QueueInboxItem } from './inbox-projection.js'

export type { MessageId, SessionId }
