import { describe, expect, it } from 'vitest'
import {
  isEffectivelyArchived,
  partitionSessionLists,
  pruneRestoredArchiveIds,
  readRestoredArchiveIds,
} from '../src/domain/archived-sessions.js'

describe('session archive overlay', () => {
  it('hides Harness-archived sessions unless the workbench restored them', () => {
    expect(isEffectivelyArchived('a', new Set(['a']), new Set())).toBe(true)
    expect(isEffectivelyArchived('a', new Set(['a']), new Set(['a']))).toBe(false)
    expect(isEffectivelyArchived('a', new Set(), new Set(['a']))).toBe(false)
  })

  it('partitions the session list into active and archived rows', () => {
    const sessions = [{ id: 'keep' }, { id: 'hidden' }, { id: 'restored' }]
    expect(partitionSessionLists(sessions, new Set(['hidden', 'restored']), new Set(['restored']))).toEqual({
      active: [{ id: 'keep' }, { id: 'restored' }],
      archived: [{ id: 'hidden' }],
    })
  })

  it('drops restore overlays that are no longer in the official archive set', () => {
    expect([...pruneRestoredArchiveIds(new Set(['a']), new Set(['a', 'b']))]).toEqual(['a'])
  })

  it('reads persisted restore ids and ignores invalid values', () => {
    expect(readRestoredArchiveIds(['a', '', 1, 'b'])).toEqual(['a', 'b'])
    expect(readRestoredArchiveIds('nope')).toEqual([])
  })
})
