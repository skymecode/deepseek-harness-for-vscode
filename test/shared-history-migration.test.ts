import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { migrateSharedHistory } from '../src/runtime/shared-history/migration.js'
import { openHistoryStore } from '../src/runtime/shared-history/storage.js'
import { legacyProjectKey, legacyV2Session } from './helpers/legacy-v2-session.js'
import { runHistoryMigration } from '../src/runtime/shared-history/runner.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-shared-history-'))
  roots.push(root)
  const source = join(root, 'private')
  const destination = join(root, 'official')
  await mkdir(source, { recursive: true })
  await mkdir(destination, { recursive: true })
  return { root, source, destination, request: { destinationHome: destination, sourceHomes: [source] } }
}
async function seed(home: string, cwd: string, id: string, answer = 'Legacy answer.') {
  const directory = join(home, 'sessions', legacyProjectKey(cwd), id)
  await mkdir(directory, { recursive: true })
  const raw = legacyV2Session(id, cwd).replace('Legacy answer.', answer)
  await writeFile(join(directory, 'session.v2.jsonl'), raw)
  return { raw, file: join(directory, 'session.v2.jsonl') }
}

describe.runIf(process.env.DSH_RUNTIME_SMOKE === '1')('lossless shared history migration', () => {
  it('runs the packaged worker with bundled Node even with no CLI or Node on PATH', async () => {
    const f = await fixture()
    await seed(f.source, f.root, 'session-worker')
    const extension = resolve(process.env.DSH_SMOKE_EXTENSION_ROOT ?? '.')
    const originalPath = process.env.PATH
    try {
      process.env.PATH = ''
      const report = await runHistoryMigration(join(extension, 'node_modules', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'), join(extension, 'dist', 'runtime', 'shared-history-worker.mjs'), f.request)
      expect(report).toMatchObject({ copied: 1, deferred: 0 })
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  })
  it('migrates an old private V2 history, retains originals and is idempotent', async () => {
    const f = await fixture()
    const original = await seed(f.source, f.root, 'session-old')
    await mkdir(join(f.source, 'attachments', 'v1'), { recursive: true })
    await writeFile(join(f.source, 'attachments', 'v1', 'image.bin'), 'image bytes')
    await writeFile(join(f.source, 'credentials.json'), 'private credential sentinel')
    expect(await migrateSharedHistory(f.request)).toMatchObject({ copied: 1, deferred: 0 })
    expect(await readFile(original.file, 'utf8')).toBe(original.raw)
    expect(await readFile(join(f.destination, 'attachments', 'v1', 'image.bin'), 'utf8')).toBe('image bytes')
    await expect(readFile(join(f.destination, 'credentials.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const target = await openHistoryStore(f.destination)
    try {
      const handle = await target.context.sessionPersistence.open(SessionId('session-old'), 'read')
      try { expect(JSON.stringify((await handle.read()).events)).toContain('Legacy answer.') } finally { await handle.close() }
    } finally { await target.fiber.dispose() }
    expect(await migrateSharedHistory(f.request)).toMatchObject({ copied: 0, skipped: 1 })
  })

  it('preserves both histories on an ID collision by using a deterministic official fork', async () => {
    const f = await fixture()
    const a = await seed(f.source, f.root, 'session-collision', 'VS Code answer.')
    const b = await seed(f.destination, f.root, 'session-collision', 'Official answer.')
    const report = await migrateSharedHistory({ ...f.request, preferredSessionId: 'session-collision' })
    expect(report).toMatchObject({ forked: 1, compression: 'none' })
    expect(report.preferredSessionId).toMatch(/^session-vscode-history-/)
    expect(await readFile(a.file, 'utf8')).toBe(a.raw)
    expect(await readFile(b.file, 'utf8')).toBe(b.raw)
    const target = await openHistoryStore(f.destination)
    try {
      const snapshots = await target.context.sessionPersistence.list()
      expect(snapshots).toHaveLength(2)
      const fork = snapshots.find((row) => row.header.id !== 'session-collision')!
      expect(fork.header.parentSession).toBe('session-collision')
      const handle = await target.context.sessionPersistence.open(fork.header.id, 'read')
      try { expect(JSON.stringify((await handle.read()).events)).toContain('VS Code answer.') } finally { await handle.close() }
    } finally { await target.fiber.dispose() }
    expect(await migrateSharedHistory({ ...f.request, preferredSessionId: 'session-collision' })).toMatchObject({ forked: 0, skipped: 1, preferredSessionId: report.preferredSessionId })
  })

  it('does not duplicate equal histories in users who already installed official DSH', async () => {
    const f = await fixture()
    await seed(f.source, f.root, 'session-equal')
    await seed(f.destination, f.root, 'session-equal')
    expect(await migrateSharedHistory(f.request)).toMatchObject({ skipped: 1, copied: 0, forked: 0 })
  })

  it.each(['source', 'destination'] as const)('fast-forwards only when %s has a strictly newer prefix', async (side) => {
    const f = await fixture()
    await seed(f.source, f.root, 'session-prefix')
    await seed(f.destination, f.root, 'session-prefix')
    const store = await openHistoryStore(f[side])
    try {
      const handle = await store.context.sessionPersistence.open(SessionId('session-prefix'), 'write')
      try {
        const records = (await handle.read()).events
        await handle.append([{ type: 'session/title', seq: SessionSeq(records.length), time: 2000, data: { title: 'Newer title', messageSeqs: [], source: { kind: 'fallback' } } }])
        await handle.flush()
      } finally { await handle.close() }
    } finally { await store.fiber.dispose() }
    expect(await migrateSharedHistory(f.request)).toMatchObject(side === 'source' ? { advanced: 1, forked: 0 } : { skipped: 1, forked: 0 })
    const target = await openHistoryStore(f.destination)
    try {
      const handle = await target.context.sessionPersistence.open(SessionId('session-prefix'), 'read')
      try { expect(JSON.stringify((await handle.read()).events)).toContain('Newer title') } finally { await handle.close() }
    } finally { await target.fiber.dispose() }
  })

  it('defers a source held by an old process and retries after its lock is released', async () => {
    const f = await fixture()
    await seed(f.source, f.root, 'session-owned')
    const source = await openHistoryStore(f.source)
    const owner = await source.context.sessionPersistence.open(SessionId('session-owned'), 'write')
    try { expect(await migrateSharedHistory(f.request)).toMatchObject({ deferred: 1, copied: 0 }) }
    finally { await owner.close(); await source.fiber.dispose() }
    expect(await migrateSharedHistory(f.request)).toMatchObject({ copied: 1, deferred: 0 })
  })

  it('forks a newer private copy when the official destination is still owned', async () => {
    const f = await fixture()
    await seed(f.source, f.root, 'session-busy-target')
    await seed(f.destination, f.root, 'session-busy-target')
    const source = await openHistoryStore(f.source)
    const handle = await source.context.sessionPersistence.open(SessionId('session-busy-target'), 'write')
    try {
      const events = (await handle.read()).events
      await handle.append([{ type: 'session/title', seq: SessionSeq(events.length), time: 2001, data: { title: 'Private additions', messageSeqs: [], source: { kind: 'fallback' } } }])
      await handle.flush()
    } finally { await handle.close(); await source.fiber.dispose() }
    const target = await openHistoryStore(f.destination)
    const owner = await target.context.sessionPersistence.open(SessionId('session-busy-target'), 'write')
    try {
      expect(await migrateSharedHistory(f.request)).toMatchObject({ forked: 1, deferred: 0 })
      expect(JSON.stringify((await owner.read()).events)).not.toContain('Private additions')
      expect(await target.context.sessionPersistence.list()).toHaveLength(2)
    } finally { await owner.close(); await target.fiber.dispose() }
  })

  it('does not overwrite conflicting attachments or publish incomplete history', async () => {
    const f = await fixture()
    const original = await seed(f.source, f.root, 'session-image')
    for (const home of [f.source, f.destination]) await mkdir(join(home, 'attachments'), { recursive: true })
    await writeFile(join(f.source, 'attachments', 'image.bin'), 'original image')
    await writeFile(join(f.destination, 'attachments', 'image.bin'), 'other image')
    await expect(migrateSharedHistory(f.request)).rejects.toThrow('Conflicting attachment')
    expect(await readFile(original.file, 'utf8')).toBe(original.raw)
    expect(await readFile(join(f.destination, 'attachments', 'image.bin'), 'utf8')).toBe('other image')
  })
})
