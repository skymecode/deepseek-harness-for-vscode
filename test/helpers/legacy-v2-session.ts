/** Released storage grouping, used only to seed a fixture whose header matches its physical directory. */
export function legacyProjectKey(cwd: string): string {
  const readable = cwd.replace(/[\\/:]+/g, '-').replace(/[^A-Za-z0-9._-]/g, (ch) => `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** Minimal V2 transcript derived from a real 0.1.3-alpha.2 smoke run, without machine paths or secrets. */
export function legacyV2Session(id: string, cwd: string): string {
  const header = { type: 'session', version: 2, id, createdAt: 1000, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'minimal' }
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'user/message', surfaceOp: 'append', data: { id: 'legacy-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Legacy question.' }] } },
    { type: 'request/header', data: { reason: 'initial', header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, system: 'Legacy system instructions.' } } },
    { type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, stream: [], message: { id: 'legacy-assistant', role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' }, content: [{ type: 'text', text: 'Legacy answer.' }] } } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map((event, seq) => ({ ...event, seq, time: 1001 + seq }))
  return [header, ...events].map((record) => JSON.stringify(record)).join('\n') + '\n'
}
