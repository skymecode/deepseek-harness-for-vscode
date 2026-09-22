import { describe, expect, it, vi } from 'vitest'
import type { Memento, OutputChannel } from 'vscode'
import { ArchiveState, type ArchiveStateOptions } from '../src/gateway/archive-state.js'
import { inboxQueue } from '../src/gateway/inbox-projection.js'
import { formatWorkspaceDiff, officialChangesView } from '../src/gateway/workspace-changes.js'
import { RESTORED_ARCHIVE_STATE_KEY } from '../src/domain/archived-sessions.js'
import { projectSessionChanges } from '../src/domain/session-changes.js'
import type { HistoryEntry } from '../src/gateway/gateway-wire.js'

vi.mock('vscode', () => ({ l10n: { t: (value: string) => value } }))

function archives(restored: string[] = []) {
  let remote = ['archived']
  const saved = new Map<string, unknown>([[RESTORED_ARCHIVE_STATE_KEY, restored]])
  const unarchive = vi.fn(async (id: string) => { remote = remote.filter((value) => value !== id); return remote })
  const options: ArchiveStateOptions = {
    globalState: { keys: () => [...saved.keys()], get: (key: string) => saved.get(key), update: async (key: string, value: unknown) => { saved.set(key, value) } } as Memento,
    output: { appendLine: vi.fn() } as unknown as OutputChannel,
    listArchived: async () => remote,
    archiveSession: async (id) => { remote = [...remote, id]; return remote },
    unarchiveSession: unarchive,
    openSession: async () => {}, createSession: async () => 'new', visibleSummaries: () => [],
    activeSessionId: () => undefined, isArchived: () => false, fireChange: () => {},
  }
  return { state: new ArchiveState(options), unarchive, saved }
}

describe('official archive ownership', () => {
  it('restores remotely and does not persist a new local overlay', async () => {
    const { state, unarchive, saved } = archives()
    await state.refresh()
    expect(state.isArchived('archived')).toBe(true)
    await state.restore('archived')
    expect(unarchive).toHaveBeenCalledWith('archived')
    expect(state.isArchived('archived')).toBe(false)
    expect(saved.get(RESTORED_ARCHIVE_STATE_KEY)).toEqual([])
  })

  it('keeps the authoritative archive state if the restore RPC fails', async () => {
    const { state, unarchive } = archives()
    await state.refresh()
    unarchive.mockRejectedValueOnce(new Error('offline'))
    await expect(state.restore('archived')).rejects.toThrow('offline')
    expect(state.isArchived('archived')).toBe(true)
  })

  it('migrates legacy restores only after remote success, retrying failed ones', async () => {
    const { state, unarchive, saved } = archives(['archived'])
    unarchive.mockRejectedValueOnce(new Error('offline'))
    await state.refresh()
    expect(saved.get(RESTORED_ARCHIVE_STATE_KEY)).toEqual(['archived'])
    await state.refresh()
    expect(unarchive).toHaveBeenCalledTimes(2)
    expect(saved.get(RESTORED_ARCHIVE_STATE_KEY)).toEqual([])
    expect(state.isArchived('archived')).toBe(false)
  })
})

describe('official projection adapters', () => {
  it('prefers official turn totals and honors an empty official diff over legacy tool statistics', () => {
    const entries = [
      { event: { type: 'tool/call', seq: 1, time: 1, data: { turn: 1, callId: 'old', name: 'write', arguments: JSON.stringify({ file_path: 'old.txt', content: 'stale' }) } } },
      { event: { type: 'tool/result', seq: 2, time: 2, data: { turn: 1, message: { source: { callId: 'old' } } } } },
      { event: { type: 'turn/end', seq: 3, time: 3, data: { turn: 1 } } },
      { event: { type: 'workspace/changes', seq: 4, time: 4, data: { turn: 1 } } },
    ] as unknown as HistoryEntry[]
    expect(projectSessionChanges(entries)?.added).toBe(1)
    const recorded = { files: [{ path: 'shell.txt', added: 1, removed: 2 }], added: 1, removed: 2 }
    expect(projectSessionChanges(entries, new Map([[4, recorded]]))).toEqual(recorded)
    expect(projectSessionChanges(entries, new Map([[4, { files: [], added: 0, removed: 0 }]]))).toBeUndefined()
  })

  it('reads both durable Inbox targets and clears missing or malformed messages', () => {
    expect(inboxQueue({
      'next-step': [{ id: 'steer', content: [{ type: 'text', text: 'adjust' }] }],
      'next-turn': [{ id: 'queue', content: [{ type: 'file', ref: { name: 'report.pdf' } }] }, null, { id: 'bad' }],
    }).map(({ id, placement }) => ({ id, placement }))).toEqual([
      { id: 'steer', placement: 'next-step' }, { id: 'queue', placement: 'next-turn' },
    ])
    expect(inboxQueue(undefined)).toEqual([])
    expect(inboxQueue({ 'next-step': [], 'next-turn': [] })).toEqual([])
  })

  it('keeps official summary totals and exact historical diff hunks', () => {
    const view = officialChangesView('session', 42, { turn: 1, total: 1, added: 2, deleted: 1,
      files: [{ path: 'a.txt', display: 'a.txt', added: 2, deleted: 1 }],
    })
    expect(view).toMatchObject({ official: { sessionId: 'session', seq: 42 }, added: 2, removed: 1 })
    expect(formatWorkspaceDiff({ kind: 'text', path: 'a.txt', display: 'a.txt', before: true, after: true, coarse: false,
      hunks: [{ oldStart: 7, oldLines: 1, newStart: 7, newLines: 2, lines: ['-old', '+new', '+second'] }],
    })).toBe('--- a.txt\n+++ a.txt\n@@ -7,1 +7,2 @@\n-old\n+new\n+second\n')
  })
})
