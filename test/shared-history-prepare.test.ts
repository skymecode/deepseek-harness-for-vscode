import { describe, expect, it, vi } from 'vitest'
import { prepareSharedHistory } from '../src/runtime/shared-history/prepare.js'
import type { SharedHistoryReport } from '../src/runtime/shared-history/migration.js'

const healthy: SharedHistoryReport = { copied: 0, skipped: 0, advanced: 0, forked: 0, deferred: 0, unavailable: 0, sourceFailures: 0, issues: [], compression: 'zstd' }
const request = { destinationHome: '/canonical', sourceHomes: ['/legacy'] }

describe('one canonical session store', () => {
  it('keeps the shared target after a legacy worker failure, with a second target validation', async () => {
    const run = vi.fn().mockResolvedValueOnce(healthy).mockRejectedValueOnce(new Error('worker timed out')).mockResolvedValueOnce(healthy)
    expect(await prepareSharedHistory('node', 'worker', request, undefined, run)).toEqual({ compression: 'zstd', migrationError: 'worker timed out' })
    expect(run.mock.calls.map(call => call[2])).toEqual([{ destinationHome: '/canonical', sourceHomes: [] }, request, { destinationHome: '/canonical', sourceHomes: [] }])
  })
  it('refuses startup if the target is unreadable, instead of opening a private store', async () => {
    const run = vi.fn().mockRejectedValue(new Error('Mixed physical encodings'))
    await expect(prepareSharedHistory('node', 'worker', request, undefined, run)).rejects.toThrow('Mixed physical encodings')
    expect(run).toHaveBeenCalledOnce()
  })
  it('does not proceed if the target becomes unavailable during a failed migration', async () => {
    const run = vi.fn().mockResolvedValueOnce(healthy).mockRejectedValueOnce(new Error('worker failed')).mockRejectedValueOnce(new Error('target unavailable'))
    await expect(prepareSharedHistory('node', 'worker', request, undefined, run)).rejects.toThrow('target unavailable')
  })
  it('retains partial migration diagnostics while keeping the same canonical target', async () => {
    const partial = { ...healthy, copied: 3, unavailable: 1, issues: [{ source: '/legacy', sessionId: 'old', reason: 'unsupported-format' as const }] }
    const run = vi.fn().mockResolvedValueOnce(healthy).mockResolvedValueOnce(partial)
    expect(await prepareSharedHistory('node', 'worker', request, undefined, run)).toEqual({ compression: 'zstd', report: partial })
  })
})
