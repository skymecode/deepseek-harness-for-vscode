const MINIMUM_STEP = 3
const TARGET_FRAMES = 8

/** Advances a stream enough to stay smooth without falling far behind large chunks. */
export function nextStreamText(rendered: string, target: string): string {
  if (rendered === target) return rendered
  if (!target.startsWith(rendered)) return target
  const remaining = target.length - rendered.length
  const step = Math.max(MINIMUM_STEP, Math.ceil(remaining / TARGET_FRAMES))
  return target.slice(0, Math.min(target.length, rendered.length + step))
}

/** Minimum time between full markdown rebuilds of a streaming block (≈33 fps). */
export const STREAMING_REBUILD_MIN_INTERVAL_MS = 30
/** Minimum accumulated text before a streaming block is rebuilt. */
export const STREAMING_REBUILD_CHAR_THRESHOLD = 80

export interface StreamFrameState {
  /** Text advanced so far in the current frame. */
  readonly rendered: string
  /** The streaming block's full target text. */
  readonly target: string
  /** Text handed to the last full markdown rebuild (empty before the first). */
  readonly lastRendered?: string
  /** Timestamp of the last full markdown rebuild. */
  readonly lastRenderAt?: number
}

/**
 * Decides whether this streaming frame must rebuild the block's Markdown.
 * Full rebuilds (markdown-it + DOMPurify + innerHTML) scale with the
 * accumulated text, so rebuilding on every animation frame makes long replies
 * janky. The first visible frame renders immediately, then rebuilds only when
 * enough new text has accumulated, enough time has passed, or the block is
 * about to finish (so the stream always lands exactly on its target).
 */
export function shouldRebuildStreamFrame(
  state: StreamFrameState,
  now: number,
  minIntervalMs: number,
  charThreshold: number,
): boolean {
  const lastRendered = state.lastRendered ?? ''
  if (state.rendered !== '' && lastRendered === '') return true
  if (state.rendered === state.target) return true
  const delta = state.rendered.length - lastRendered.length
  if (delta >= charThreshold) return true
  if (delta > 0 && now - (state.lastRenderAt ?? 0) >= minIntervalMs) return true
  return false
}

const SPLIT_MIN_CHARS = 240
const FENCE_LINE = /^( {0,3})(`{3,}|~{3,})(.*)$/u

/**
 * Splits a streaming Markdown source into a frozen prefix and a live tail.
 * The prefix ends only on a block boundary outside an open fence: before a
 * new paragraph, heading, or fence, or just after a fence closes. Lists,
 * quotes, and tables stay in the tail so they are not torn into separate
 * documents. The finished message still renders once as a whole.
 */
export function splitStreamingMarkdown(source: string): { settled: string; tail: string } {
  if (source.length < SPLIT_MIN_CHARS) return { settled: '', tail: source }
  const lines: { start: number; text: string }[] = []
  let offset = 0
  while (offset < source.length) {
    const nl = source.indexOf('\n', offset)
    if (nl === -1) {
      lines.push({ start: offset, text: source.slice(offset) })
      break
    }
    lines.push({ start: offset, text: source.slice(offset, nl) })
    offset = nl + 1
  }
  let open: { char: string; length: number } | undefined
  let lastSafe = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) continue
    if (open !== undefined) {
      if (isClosingFence(line.text, open)) {
        open = undefined
        const next = lines[index + 1]
        if (next !== undefined && next.start < source.length) lastSafe = next.start
      }
      continue
    }
    const marker = fenceMarker(line.text)
    if (marker !== undefined) {
      if (line.start > 0) lastSafe = line.start
      open = marker
      continue
    }
    if (line.text.trim() !== '' || line.start === 0) continue
    const next = nextContentLine(lines, index + 1)
    if (next === undefined || next.start === 0 || next.start >= source.length) continue
    const previous = previousContentLine(lines, index - 1)
    if (previous !== undefined && sameOpenBlock(previous.text, next.text)) continue
    lastSafe = next.start
  }
  if (lastSafe <= 0 || lastSafe >= source.length) return { settled: '', tail: source }
  return { settled: source.slice(0, lastSafe), tail: source.slice(lastSafe) }
}

function fenceMarker(line: string): { char: string; length: number } | undefined {
  const match = FENCE_LINE.exec(line)
  const marker = match?.[2]
  if (marker === undefined) return undefined
  return { char: marker[0] ?? '`', length: marker.length }
}

function isClosingFence(line: string, open: { char: string; length: number }): boolean {
  const marker = fenceMarker(line)
  if (marker === undefined || marker.char !== open.char || marker.length < open.length) return false
  return line.trim().slice(marker.length).trim() === ''
}

function nextContentLine(lines: readonly { start: number; text: string }[], start: number): { start: number; text: string } | undefined {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]
    if (line !== undefined && line.text.trim() !== '') return line
  }
  return undefined
}

function previousContentLine(lines: readonly { start: number; text: string }[], start: number): { start: number; text: string } | undefined {
  for (let index = start; index >= 0; index -= 1) {
    const line = lines[index]
    if (line !== undefined && line.text.trim() !== '') return line
  }
  return undefined
}

function sameOpenBlock(previous: string, next: string): boolean {
  return (isListItem(previous) && isListItem(next))
    || (isQuote(previous) && isQuote(next))
    || (isTableRow(previous) && isTableRow(next))
}

function isListItem(line: string): boolean {
  return /^ {0,3}(?:[-*+]|\d+[.)])\s/u.test(line)
}

function isQuote(line: string): boolean {
  return /^ {0,3}>/u.test(line)
}

function isTableRow(line: string): boolean {
  return /^ {0,3}\|/u.test(line)
}
