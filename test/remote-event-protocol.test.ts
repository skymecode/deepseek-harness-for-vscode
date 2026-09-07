import { describe, expect, it } from 'vitest'
import { parseRemoteEvent } from '../src/gateway/remote-event-protocol.js'
import { projectInteractionRequest } from '../src/gateway/interaction-request.js'
import { approvalFrame, questionFrame } from './helpers/interaction-frames.js'

describe('remote-event wire adapter', () => {
  it('decodes all four official frame types without inventing a sessionId', () => {
    expect(parseRemoteEvent({ type: 'ready', clientId: 'client-1', host: { home: '/tmp' } })).toEqual({ type: 'ready', clientId: 'client-1' })
    const emit = { type: 'emit', event: 'api-session/status', args: ['background', true] }
    expect(parseRemoteEvent(emit)).toEqual(emit)
    expect(parseRemoteEvent(approvalFrame())).toEqual(approvalFrame())
    expect(parseRemoteEvent({ type: 'cancel', eventId: 'request-1' })).toEqual({ type: 'cancel', eventId: 'request-1' })
  })

  it.each([
    null, [], {}, { type: 'unknown' }, { type: 'ready', clientId: '' },
    { type: 'emit', event: 'api-session/status', args: null },
    { type: 'cancel', eventId: 42 },
    { ...approvalFrame(), agentId: undefined }, { ...approvalFrame(), agentId: ' ' },
    { ...approvalFrame(), eventId: '' }, { ...approvalFrame(), request: null },
  ])('ignores malformed input %#', (value) => {
    expect(parseRemoteEvent(value)).toBeUndefined()
  })
})

describe('actionable interaction projection', () => {
  it('uses the official request names and preserves question descriptions and choices', () => {
    expect(projectInteractionRequest(approvalFrame(), 'key')).toEqual({ kind: 'approval', view: { key: 'key', toolName: 'bash', reason: 'Run tests' } })
    expect(projectInteractionRequest(questionFrame(), 'key')).toEqual({
      kind: 'question', view: { key: 'key', questions: [{
        id: 'scope', question: 'Which tests?', header: 'Tests', detail: 'Choose a scope',
        options: [{ label: 'Unit', description: 'Fast checks' }, { label: 'Integration' }], multiSelect: true,
      }] },
    })
  })

  it.each(['approval/asked', 'question/asked', 'approval/decided'])('does not turn audit event %s into a new prompt', (event) => {
    expect(projectInteractionRequest({ ...approvalFrame(), event }, 'key')).toBeUndefined()
  })

  it('supports free-text questions without options', () => {
    const frame = { ...questionFrame(), request: { questions: [{ id: 'name', question: 'Name?' }] } }
    expect(projectInteractionRequest(frame, 'key')).toMatchObject({ view: { questions: [{ id: 'name', options: [], multiSelect: false }] } })
  })

  it.each([
    { questions: [null] }, { questions: [] }, { questions: [{ id: '', question: 'Name?' }] },
    { questions: [{ id: 'a', question: 'Name?', options: [null] }] },
    { questions: [{ id: 'a', question: 'Name?', options: {} }] },
    { questions: [{ id: 'a', question: 'A?' }, { id: 'a', question: 'B?' }] },
  ])('fails closed on malformed questions %# without breaking the event stream', (request) => {
    expect(projectInteractionRequest({ ...questionFrame(), request }, 'key')).toBeUndefined()
  })
})
