import { describe, expect, it } from 'vitest'
import { TurnCompletionTracker } from '../src/gateway/turn-completion-tracker.js'

describe('live turn completion tracking', () => {
  it('ignores idle snapshots and emits once per running -> idle edge', () => {
    const tracker = new TurnCompletionTracker()
    expect(tracker.status('a', false)).toBeUndefined()
    tracker.status('a', true)
    tracker.status('a', true)
    expect(tracker.status('a', false)).toEqual({ sessionId: 'a', failed: false })
    expect(tracker.status('a', false)).toBeUndefined()
    tracker.status('a', true)
    expect(tracker.status('a', false)).toBeDefined()
    expect(tracker.status('', true)).toBeUndefined()
  })

  it('isolates failures across sessions and runs, including duplicate starts', () => {
    const tracker = new TurnCompletionTracker()
    tracker.fail('a')
    tracker.status('a', true)
    tracker.status('b', true)
    tracker.fail('a')
    tracker.status('a', true)
    expect(tracker.status('a', false)?.failed).toBe(true)
    expect(tracker.status('b', false)?.failed).toBe(false)
    tracker.status('a', true)
    expect(tracker.status('a', false)?.failed).toBe(false)
  })

  it('suppresses cancellation and rolls back a rejected cancellation only for its run', () => {
    const tracker = new TurnCompletionTracker()
    tracker.status('a', true)
    const restore = tracker.cancel('a')
    restore()
    expect(tracker.status('a', false)).toBeDefined()
    tracker.status('a', true)
    tracker.cancel('a')
    restore()
    expect(tracker.status('a', false)).toBeUndefined()
  })

  it('forgets removed sessions and connection generations', () => {
    const tracker = new TurnCompletionTracker()
    tracker.status('a', true)
    tracker.status('b', true)
    tracker.remove('a')
    expect(tracker.status('a', false)).toBeUndefined()
    tracker.clear()
    expect(tracker.status('b', false)).toBeUndefined()
  })
})
