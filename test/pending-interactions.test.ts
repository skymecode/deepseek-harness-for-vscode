import { describe, expect, it } from 'vitest'
import { PendingInteractions } from '../src/gateway/pending-interactions.js'
import { approvalFrame, questionFrame } from './helpers/interaction-frames.js'

describe('connection-owned pending interactions', () => {
  it('keeps approvals and questions strictly with agentId across navigation', () => {
    const store = new PendingInteractions()
    const generation = store.beginConnection('client-1')
    const frame = approvalFrame()
    store.receive({ ...frame, request: { ...frame.request, sessionId: 'foreground' } }, generation)
    store.receive(questionFrame('child-session'), generation)
    expect(store.forSession('foreground')).toEqual({ approvals: [], questions: [] })
    expect(store.forSession(undefined)).toEqual({ approvals: [], questions: [] })
    expect(store.forSession('background').approvals).toHaveLength(1)
    expect(store.forSession('child-session').questions).toHaveLength(1)
    expect(store.forSession('background').approvals).toHaveLength(1)
  })

  it('requires a ready connection and a non-empty owner', () => {
    const store = new PendingInteractions()
    expect(store.receive(approvalFrame(), 0)).toBeUndefined()
    const generation = store.beginConnection('client-1')
    expect(store.receive(approvalFrame(''), generation)).toBeUndefined()
    store.disconnect()
    expect(store.receive(approvalFrame(), generation)).toBeUndefined()
  })

  it('deduplicates a repeated delivery and cancels only its own event', () => {
    const store = new PendingInteractions()
    const generation = store.beginConnection('client-1')
    expect(store.receive(approvalFrame(), generation)).toBeDefined()
    expect(store.receive(approvalFrame(), generation)).toBeUndefined()
    store.receive(questionFrame(), generation)
    expect(store.cancel('approval-1', generation)).toBe(true)
    expect(store.forSession('background').approvals).toEqual([])
    expect(store.forSession('background').questions).toHaveLength(1)
  })

  it('clears disconnected deliveries and gives replayed events fresh keys/client IDs', () => {
    const store = new PendingInteractions()
    const first = store.beginConnection('old-client')
    const old = store.receive(approvalFrame(), first)!
    store.receive(questionFrame(), first)
    expect(store.disconnect(first)).toBe(true)
    expect(store.forSession('background')).toEqual({ approvals: [], questions: [] })
    const next = store.beginConnection('new-client')
    const replay = store.receive(approvalFrame(), next)!
    expect(replay.clientId).toBe('new-client')
    expect(replay.key).not.toBe(old.key)
    expect(store.beginResponse(old.key, 'approval')).toBeUndefined()
    expect(store.forSession('background').questions).toEqual([])
  })

  it('a new ready frame also replaces pending state without waiting for disconnect', () => {
    const store = new PendingInteractions()
    store.receive(approvalFrame(), store.beginConnection('old-client'))
    store.beginConnection('new-client')
    expect(store.forSession('background').approvals).toEqual([])
  })

  it('does not let old pump cleanup or cancellation erase new deliveries', () => {
    const store = new PendingInteractions()
    const old = store.beginConnection('old-client')
    const current = store.beginConnection('new-client')
    const replay = store.receive(approvalFrame(), current)!
    expect(store.disconnect(old)).toBe(false)
    expect(store.cancel('approval-1', old)).toBe(false)
    expect(store.receive(questionFrame(), old)).toBeUndefined()
    expect(store.has(replay.key)).toBe(true)
  })

  it('prevents duplicate/wrong-kind replies and allows retry after an RPC failure', () => {
    const store = new PendingInteractions()
    const pending = store.receive(approvalFrame(), store.beginConnection('client-1'))!
    expect(store.beginResponse(pending.key, 'question')).toBeUndefined()
    expect(store.beginResponse(pending.key, 'approval')).toBe(pending)
    expect(store.beginResponse(pending.key, 'approval')).toBeUndefined()
    store.finishResponse(pending, false)
    expect(store.beginResponse(pending.key, 'approval')).toBe(pending)
    store.finishResponse(pending, true)
    expect(store.has(pending.key)).toBe(false)
  })

  it.each([true, false])('ignores a stale in-flight response (success=%s) after replay', (succeeded) => {
    const store = new PendingInteractions()
    const old = store.receive(approvalFrame(), store.beginConnection('old-client'))!
    store.beginResponse(old.key, 'approval')
    const replay = store.receive(approvalFrame(), store.beginConnection('new-client'))!
    store.finishResponse(old, succeeded)
    expect(store.has(old.key)).toBe(false)
    expect(store.beginResponse(replay.key, 'approval')).toBe(replay)
  })

  it('does not resurrect a canceled request when its reply fails', () => {
    const store = new PendingInteractions()
    const generation = store.beginConnection('client-1')
    const pending = store.receive(approvalFrame(), generation)!
    store.beginResponse(pending.key, 'approval')
    store.cancel(pending.eventId, generation)
    store.finishResponse(pending, false)
    expect(store.has(pending.key)).toBe(false)
  })

  it('removes only the deleted session, including any in-flight reply', () => {
    const store = new PendingInteractions()
    const generation = store.beginConnection('client-1')
    const pending = store.receive(approvalFrame(), generation)!
    store.beginResponse(pending.key, 'approval')
    store.receive(questionFrame('child-session'), generation)
    store.removeSession('background')
    store.finishResponse(pending, false)
    expect(store.forSession('background').approvals).toEqual([])
    expect(store.forSession('child-session').questions).toHaveLength(1)
  })
})
