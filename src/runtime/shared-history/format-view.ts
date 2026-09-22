import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { openHistoryStore } from './storage.js'

type Store = Awaited<ReturnType<typeof openHistoryStore>>
interface Lease { release(): Promise<void> }

/**
 * The pinned JSONL backend rejects mixed roots before listing. A filtered,
 * temporary view lets its official codecs read one encoding at a time.
 * Snapshot each source directory under the ORIGINAL backend's kernel lease,
 * never a lock on the temporary copy (especially important on Windows).
 */
export async function openFormatViewStore(sourceHome: string, format: 'zstd' | 'none') {
  const viewHome = await mkdtemp(join(tmpdir(), 'dsh-history-format-view-'))
  const original = await openHistoryStore(sourceHome, format)
  try {
    const deferred = await copyFormatSessions(original, join(sourceHome, 'sessions'), join(viewHome, 'sessions'), format)
    const view = await openHistoryStore(viewHome, format)
    return { ...view, deferred, cleanup: async () => { await rm(viewHome, { recursive: true, force: true }) } }
  } catch (error) {
    await rm(viewHome, { recursive: true, force: true })
    throw error
  } finally { await original.fiber.dispose() }
}

async function copyFormatSessions(store: Store, sourceRoot: string, targetRoot: string, format: 'zstd' | 'none'): Promise<number> {
  // No public directory-lease seam exists in the pinned DSH runtime. This guarded
  // adapter deliberately reuses the pinned implementation, including its
  // Windows semaphore identity and POSIX inode verification. Refuse recovery
  // if upstream removes it; never invent a second lock or copy an active log.
  const acquire = Reflect.get(store.context.sessionPersistence, 'acquireLease') as unknown
  if (typeof acquire !== 'function') throw new Error('Pinned Harness directory lease is unavailable; original histories preserved.')
  const projects = await readdir(sourceRoot, { withFileTypes: true })
  let deferred = 0
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const sourceProject = join(sourceRoot, project.name)
    for (const session of await readdir(sourceProject, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const sourceSession = join(sourceProject, session.name)
      const files = await readdir(sourceSession, { withFileTypes: true })
      const matching = files.filter(file => file.isFile()
        && /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/u.test(file.name)
        && file.name.endsWith('.zstd') === (format === 'zstd'))
      if (matching.length === 0) continue
      let lease: Lease | undefined
      try {
        lease = await acquire.call(store.context.sessionPersistence, SessionId(session.name), undefined, sourceSession) as Lease
        const targetSession = join(targetRoot, project.name, session.name)
        await mkdir(targetSession, { recursive: true, mode: 0o700 })
        for (const file of matching) await cp(join(sourceSession, file.name), join(targetSession, file.name), { preserveTimestamps: true })
      } catch (error) {
        if ((error as Error).name !== 'SessionAlreadyOwnedError') throw error
        deferred++
      } finally { await lease?.release() }
    }
  }
  return deferred
}
