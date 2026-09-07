import type { RemoteWaterfallEvent } from '../../src/gateway/remote-event-protocol.js'

/** Real dsh 0.1.3 request names and identity placement, not the audit events. */
export function approvalFrame(agentId = 'background', eventId = 'approval-1'): RemoteWaterfallEvent {
  return { type: 'waterfall', event: 'approval/request', eventId, agentId, request: { toolName: 'bash', reason: 'Run tests' } }
}

export function questionFrame(agentId = 'background', eventId = 'question-1'): RemoteWaterfallEvent {
  return { type: 'waterfall', event: 'user-questions/request', eventId, agentId, request: { questions: [{
    id: 'scope', question: 'Which tests?', header: 'Tests', detail: 'Choose a scope',
    options: [{ label: 'Unit', description: 'Fast checks' }, { label: 'Integration' }], multiSelect: true,
  }] } }
}
