import type { ChatItem } from './workbench-state.js'

/** A presentation-only group: the durable transcript is never rewritten. */
export interface TurnProcessView {
  readonly key: string
  readonly messageIds: readonly string[]
  readonly elapsedMs?: number
}

export interface TurnProcessProjection {
  readonly messages: readonly ChatItem[]
  readonly groups: readonly TurnProcessView[]
}

interface TurnSegment {
  key: string
  turn?: number
  readonly items: ChatItem[]
}

/**
 * Completed turns show one process disclosure followed by their final answer.
 * Runtime turn ids prevent queued prompts, auto-continuations and paged history
 * from merging unrelated work. Legacy messages fall back to user boundaries.
 */
export function projectTurnProcesses(messages: readonly ChatItem[], running: boolean): TurnProcessProjection {
  const segments: TurnSegment[] = []
  let current: TurnSegment | undefined
  let boundary = 'history'
  for (const item of messages) {
    if ((item.kind === 'message' && item.role === 'user') || item.id.startsWith('command-')) {
      current = undefined
      boundary = item.id
      continue
    }
    const turn = item.turn ?? turnFromStreamKey(item.streamKey)
    if (current === undefined || (turn !== undefined && current.turn !== undefined && current.turn !== turn)) {
      current = { key: turn === undefined ? `after:${boundary}` : `turn:${turn}`, items: [], ...(turn === undefined ? {} : { turn }) }
      segments.push(current)
    } else if (turn !== undefined && current.turn === undefined) {
      current.turn = turn
      current.key = `turn:${turn}`
    }
    current.items.push(item)
  }

  const replacements = new Map<string, readonly ChatItem[]>()
  const groups: TurnProcessView[] = []
  const latestTurn = segments.findLast((segment) => segment.turn !== undefined)?.turn
  const groupKeys = new Set<string>()
  for (const segment of segments) {
    const duration = segment.items.findLast((item) => item.workDuration?.endedAt !== undefined)?.workDuration
    const latest = segment.items.at(-1)
    // A later human prompt is also a boundary, even before its first output.
    const followedByUser = messages.slice(messages.indexOf(latest!) + 1).some((item) => item.kind === 'message' && item.role === 'user')
    const live = segment.turn === undefined ? segment === segments.at(-1) && !followedByUser : segment.turn === latestTurn
    if (running && duration === undefined && live) continue
    const work = segment.items.filter((item) => item.kind === 'tool' || (item.kind === 'message' && item.role === 'assistant'))
    const last = work.at(-1)
    const conclusion = last?.kind === 'message' && last.blocks?.some((block) => block.kind !== 'reasoning' && block.text.trim() !== '') ? last : undefined
    const hasProcess = work.some((item) => item !== conclusion || item.blocks?.some((block) => block.kind === 'reasoning'))
    if (!hasProcess) continue
    const ids: string[] = []
    for (const item of segment.items) {
      // Terminal errors/stops and user-facing notices must stay visible.
      if (item.kind === 'notice') continue
      if (item === conclusion) {
        const reasoning = item.blocks?.filter((block) => block.kind === 'reasoning') ?? []
        const answer = withoutDuration(item)
        // The real message id stays on the visible answer for file-card and
        // timeline navigation. Only its reasoning gets a synthetic UI id.
        const visible = { ...answer }
        delete visible.streamKey
        const parts: ChatItem[] = []
        if (reasoning.length > 0) {
          const process = { ...answer, id: `process:${item.id}`, blocks: reasoning }
          ids.push(process.id)
          parts.push(process)
        }
        parts.push({ ...visible, blocks: item.blocks?.filter((block) => block.kind !== 'reasoning') ?? [] })
        replacements.set(item.id, parts)
      } else {
        ids.push(item.id)
        replacements.set(item.id, [withoutDuration(item)])
      }
    }
    if (ids.length === 0) continue
    const key = groupKeys.has(segment.key) ? `${segment.key}:from:${segment.items[0]!.id}` : segment.key
    groupKeys.add(key)
    groups.push({ key, messageIds: ids,
      ...(duration?.endedAt === undefined ? {} : { elapsedMs: Math.max(0, duration.endedAt - duration.startedAt) }) })
  }
  return { messages: messages.flatMap((item) => replacements.get(item.id) ?? [item]), groups }
}

function turnFromStreamKey(key: string | undefined): number | undefined {
  const match = key?.match(/^(\d+):\d+$/)
  return match === undefined || match === null ? undefined : Number(match[1])
}

function withoutDuration(item: ChatItem): ChatItem {
  const rest = { ...item }
  delete rest.workDuration
  return { ...rest,
    ...(item.status === 'running' ? { status: 'info' as const } : {}),
    ...(item.blocks === undefined ? {} : { blocks: item.blocks.map((block) => block.streaming ? { ...block, streaming: false } : block) }),
  }
}
