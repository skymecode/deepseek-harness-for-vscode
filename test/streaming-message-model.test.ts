import { describe, expect, it } from 'vitest'
import {
  nextStreamText,
  shouldRebuildStreamFrame,
  splitStreamingMarkdown,
  STREAMING_REBUILD_CHAR_THRESHOLD,
  STREAMING_REBUILD_MIN_INTERVAL_MS,
} from '../src/webview/streaming-message/model.js'

describe('smooth message streaming', () => {
  it('reveals small deltas progressively and eventually reaches the target', () => {
    let rendered = ''
    const target = 'DeepSeek is reasoning in a visible stream.'
    const frames: string[] = []
    while (rendered !== target) {
      rendered = nextStreamText(rendered, target)
      frames.push(rendered)
    }
    expect(frames.length).toBeGreaterThan(1)
    expect(frames.at(-1)).toBe(target)
  })

  it('repairs non-prefix updates immediately', () => {
    expect(nextStreamText('old content', 'replacement')).toBe('replacement')
  })
})

describe('streaming rebuild throttle', () => {
  const NOW = 10_000

  it('renders the first visible frame immediately', () => {
    expect(shouldRebuildStreamFrame(
      { rendered: 'Hello', target: 'Hello world', lastRendered: '', lastRenderAt: 0 },
      NOW, STREAMING_REBUILD_MIN_INTERVAL_MS, STREAMING_REBUILD_CHAR_THRESHOLD,
    )).toBe(true)
  })

  it('skips an empty first frame (nothing to show yet)', () => {
    expect(shouldRebuildStreamFrame(
      { rendered: '', target: 'Hello', lastRendered: '', lastRenderAt: 0 },
      NOW, STREAMING_REBUILD_MIN_INTERVAL_MS, STREAMING_REBUILD_CHAR_THRESHOLD,
    )).toBe(false)
  })

  it('skips small deltas within the time interval', () => {
    expect(shouldRebuildStreamFrame(
      { rendered: 'Hello wo', target: 'Hello world', lastRendered: 'Hello', lastRenderAt: NOW - 5 },
      NOW, STREAMING_REBUILD_MIN_INTERVAL_MS, STREAMING_REBUILD_CHAR_THRESHOLD,
    )).toBe(false)
  })

  it('rebuilds once enough time has passed', () => {
    expect(shouldRebuildStreamFrame(
      { rendered: 'Hello wo', target: 'Hello world', lastRendered: 'Hello', lastRenderAt: NOW - STREAMING_REBUILD_MIN_INTERVAL_MS },
      NOW, STREAMING_REBUILD_MIN_INTERVAL_MS, STREAMING_REBUILD_CHAR_THRESHOLD,
    )).toBe(true)
  })

  it('rebuilds once the character threshold is crossed', () => {
    const lastRendered = 'a'.repeat(10)
    const rendered = lastRendered + 'b'.repeat(STREAMING_REBUILD_CHAR_THRESHOLD)
    expect(shouldRebuildStreamFrame(
      { rendered, target: `${rendered} more`, lastRendered, lastRenderAt: NOW - 1 },
      NOW, STREAMING_REBUILD_MIN_INTERVAL_MS, STREAMING_REBUILD_CHAR_THRESHOLD,
    )).toBe(true)
  })

  it('always rebuilds the final frame so the stream lands on its target', () => {
    expect(shouldRebuildStreamFrame(
      { rendered: 'Hello', target: 'Hello', lastRendered: 'Hell', lastRenderAt: NOW - 1 },
      NOW, STREAMING_REBUILD_MIN_INTERVAL_MS, STREAMING_REBUILD_CHAR_THRESHOLD,
    )).toBe(true)
  })

  it('keeps a short reply in one tail', () => {
    const source = 'Short reply.'
    expect(splitStreamingMarkdown(source)).toEqual({ settled: '', tail: source })
  })

  it('freezes prose before an open fence and keeps the fence in the tail', () => {
    const prose = `${'Explain the change in detail. '.repeat(12)}\n\n`
    const fence = '```ts\nconst value = 1\n'
    const split = splitStreamingMarkdown(`${prose}${fence}`)
    expect(split.settled.endsWith('\n\n') || split.settled.endsWith('\n')).toBe(true)
    expect(split.tail.startsWith('```ts')).toBe(true)
    expect(`${split.settled}${split.tail}`).toBe(`${prose}${fence}`)
  })

  it('freezes a closed fence and leaves the following paragraph live', () => {
    const prefix = `${'A finished explanation. '.repeat(12)}\n\n`
    const fence = '```\nconst done = true\n```\n\n'
    const live = 'Still writing'
    const split = splitStreamingMarkdown(`${prefix}${fence}${live}`)
    expect(split.settled.endsWith('```\n\n')).toBe(true)
    expect(split.tail).toBe(live)
  })

  it('does not tear a list apart at blank lines between items', () => {
    const intro = `${'Context before the list. '.repeat(12)}\n\n`
    const list = '- one\n\n- two\n\n- three'
    const split = splitStreamingMarkdown(`${intro}${list}`)
    expect(split.tail.startsWith('- one')).toBe(true)
    expect(split.settled.includes('- one')).toBe(false)
  })

  it('rebuilds a completed frame even when the last render already matched', () => {
    // The renderedSources cache in renderMarkdown turns this into a no-op, but
    // the decision stays "rebuild" so stream termination is deterministic.
    expect(shouldRebuildStreamFrame(
      { rendered: 'Hello', target: 'Hello', lastRendered: 'Hello', lastRenderAt: NOW - 1 },
      NOW, STREAMING_REBUILD_MIN_INTERVAL_MS, STREAMING_REBUILD_CHAR_THRESHOLD,
    )).toBe(true)
  })
})
