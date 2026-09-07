import type { HistoryEntry } from '../../src/gateway/gateway-wire.js'

/** Small durable-history fixture; seq bases can model a migrated event log. */
export function historyEvent(seq: number, type: string, data: unknown): HistoryEntry {
  return { event: { seq, time: seq * 100, type, data } } as HistoryEntry
}

export function completedEditTurn(turn: number, base: number, file = `turn-${turn}.ts`): HistoryEntry[] {
  const callId = `edit-${turn}`
  return [
    historyEvent(base, 'turn/start', { turn }),
    historyEvent(base + 1, 'user/message', { id: `user-${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `Edit ${file}` }] }),
    historyEvent(base + 2, 'assistant/message', { turn, step: 1, message: { id: `thought-${turn}`, role: 'assistant', content: [{ type: 'reasoning', text: 'Check the file.' }] } }),
    historyEvent(base + 3, 'tool/call', { turn, step: 1, callId, name: 'edit', arguments: JSON.stringify({ file_path: file, old_string: 'before', new_string: 'after\nadded' }) }),
    historyEvent(base + 4, 'tool/result', { turn, step: 1, message: { id: `result-${turn}`, role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'text', text: 'Edited.' }] } }),
    historyEvent(base + 5, 'assistant/message', { turn, step: 2, message: { id: `answer-${turn}`, role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }),
    historyEvent(base + 6, 'turn/end', { turn, reason: { kind: 'completed' } }),
  ]
}
