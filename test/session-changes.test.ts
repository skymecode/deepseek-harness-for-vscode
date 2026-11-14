import { describe, expect, it } from 'vitest'
import { projectSessionChanges } from '../src/domain/session-changes.js'
import { officialChangesView } from '../src/gateway/workspace-changes.js'
import { completedEditTurn, historyEvent } from './helpers/turn-history.js'

const summary = officialChangesView('s', 17, { turn: 1, total: 1, added: 1, deleted: 1,
  files: [{ path: 'shell.txt', display: 'shell.txt', added: 1, deleted: 1 }],
})
const announcement = historyEvent(17, 'workspace/changes', { turn: 1 })
const entries = [...completedEditTurn(1, 10), announcement]

describe('official-only turn changes', () => {
  it('never estimates from successful file-tool calls, including old histories', () => {
    expect(projectSessionChanges(completedEditTurn(1, 10))).toBeUndefined()
    expect(projectSessionChanges(entries)).toBeUndefined()
    expect(projectSessionChanges(entries, new Map([[17, undefined]]))).toBeUndefined()
  })

  it('uses official net counts, including paths changed only by shell', () => {
    expect(projectSessionChanges(entries, new Map([[17, summary]]))).toBe(summary)
  })

  it('honors only the latest announcement, even while its summary is pending, absent, or empty', () => {
    const replaced = [...entries, historyEvent(18, 'workspace/changes', { turn: 1 })]
    const cache = new Map([[17, summary]])
    expect(projectSessionChanges(replaced, cache)).toBeUndefined()
    expect(projectSessionChanges(replaced, new Map([[17, summary], [18, undefined]]))).toBeUndefined()
    cache.set(18, { ...summary, files: [], total: 0, added: 0, removed: 0 })
    expect(projectSessionChanges(replaced, cache)).toBeUndefined()
    cache.set(18, { ...summary, added: 3 })
    expect(projectSessionChanges(replaced, cache)?.added).toBe(3)
  })

  it('hides unfinished turns and the prior summary while a new turn runs', () => {
    const cache = new Map([[17, summary]])
    expect(projectSessionChanges(entries.filter(({ event }) => event.type !== 'turn/end'), cache)).toBeUndefined()
    expect(projectSessionChanges([...entries, historyEvent(18, 'turn/start', { turn: 2 })], cache)).toBeUndefined()
  })

  it('preserves native display paths, truncated totals, and unavailable counts', () => {
    const view = officialChangesView('s', 42, { turn: 1, total: 501, added: 700, deleted: 30, files: [
      { path: 'C:\\Users\\name\\image.png', display: '~/image.png', added: 0, deleted: 0, binary: true },
      { path: 'huge.txt', display: 'huge.txt', added: 0, deleted: 0, oversized: true },
    ] })
    expect(view).toMatchObject({ total: 501, added: 700, removed: 30, files: [
      { index: 0, display: '~/image.png', binary: true }, { index: 1, oversized: true },
    ] })
  })
})
