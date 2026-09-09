import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionStore, interruptedTurnClosers, type SessionHeader, type SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { canonicalJson, compareHistories } from './compare.js'
import { migrateAttachments } from './attachments.js'
import { openHistoryStore } from './storage.js'

export interface SharedHistoryRequest {
  readonly destinationHome: string
  readonly sourceHomes: readonly string[]
  readonly forkLabel?: string
  readonly preferredSessionId?: string
}
export interface SharedHistoryReport { copied: number; advanced: number; forked: number; skipped: number; deferred: number; compression: 'zstd' | 'none'; preferredSessionId?: string }

/** Runs under the bundled Node, never under Electron, to use the official cross-platform session locks/codecs. */
export async function migrateSharedHistory(request: SharedHistoryRequest): Promise<SharedHistoryReport> {
  await mkdir(request.destinationHome, { recursive: true, mode: 0o700 })
  // Use realpath only to deduplicate stores. Windows' upstream semaphore name
  // is based on the configured path: changing a short-name root into its long
  // alias here would bypass a writer opened with the original spelling.
  const destination = resolve(request.destinationHome)
  const destinationIdentity = await realpath(destination)
  const { context: targetContext, fiber: targetFiber, compression } = await openHistoryStore(destination)
  const report: SharedHistoryReport = { copied: 0, advanced: 0, forked: 0, skipped: 0, deferred: 0, compression }
  const seen = new Set<string>([destinationIdentity])
  try {
    for (const path of request.sourceHomes) {
      const identity = await realpath(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
      if (identity === undefined || seen.has(identity)) continue
      seen.add(identity)
      const source = resolve(path)
      for (const store of ['attachments', 'sessions']) {
        const child = relative(join(identity, store), destinationIdentity)
        if (child === '' || (!child.startsWith('..') && !isAbsolute(child))) throw new Error('Shared history destination cannot be inside a legacy data store.')
      }
      const { context: sourceContext, fiber: sourceFiber } = await openHistoryStore(source)
      const attachments = new Map<string, string>()
      try {
        const journal = join(source, 'shared-history-migration', hash(destinationIdentity))
        await mkdir(journal, { recursive: true, mode: 0o700 })
        for (const snapshot of await sourceContext.sessionPersistence.list()) {
          const marker = join(journal, `${hash(String(snapshot.header.id))}.json`)
          // A migrated old backup must not resurrect history later deleted in the shared store.
          try {
            const previous = JSON.parse(await readFile(marker, 'utf8'))
            if (previous.schema === 1 && previous.complete === true && previous.sourceId === snapshot.header.id && previous.sourceRevision === canonicalJson(snapshot.revision)) {
              if (request.preferredSessionId === snapshot.header.id && typeof previous.targetId === 'string') report.preferredSessionId ??= previous.targetId
              report.skipped++; continue
            }
          }
          catch (error) { if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          let sourceHandle: SessionHandle | undefined
          try {
            // An old extension process can still own this private log. Defer;
            // never copy an active writer's log or remove its kernel lock.
            sourceHandle = await sourceContext.sessionPersistence.open(snapshot.header.id, 'write')
            await migrateAttachments(join(source, 'attachments'), join(destination, 'attachments'), attachments)
            const outcome = await transferSession(sourceHandle, targetContext, identity, request.forkLabel ?? 'VS Code history')
            const settledSource = await sourceContext.sessionPersistence.stat(sourceHandle.id)
            await writeFileAtomic(marker, JSON.stringify({ schema: 1, complete: true, sourceId: sourceHandle.id, sourceRevision: canonicalJson(settledSource?.revision), ...outcome }) + '\n', { mode: 0o600 })
            report[outcome.kind]++
            if (request.preferredSessionId === sourceHandle.id) report.preferredSessionId ??= outcome.targetId
          } catch (error) {
            if (['SessionAlreadyOwnedError', 'SessionAlreadyExistsError'].includes((error as Error).name)) { report.deferred++; continue }
            throw error
          } finally { await sourceHandle?.close() }
        }
      } finally { await sourceFiber.dispose() }
    }
  } finally { await targetFiber.dispose() }
  return report
}

async function transferSession(source: SessionHandle, targetContext: Context, sourceHome: string, forkLabel: string): Promise<{ kind: 'copied' | 'advanced' | 'forked' | 'skipped'; targetId: string }> {
  const target = targetContext.sessionPersistence
  const { events } = await source.read()
  const existing = await target.stat(source.id)
  if (existing === undefined) {
    await publish(targetContext, source.header, source.inheritedEventCount, events)
    return { kind: 'copied', targetId: source.id }
  }
  const reader = await target.open(source.id, 'read')
  let relation: ReturnType<typeof compareHistories>
  try {
    relation = compatibleHeader(source.header, reader.header) && source.inheritedEventCount === reader.inheritedEventCount
      ? compareHistories(events, (await reader.read()).events) : 'diverged'
  } finally { await reader.close() }
  if (relation === 'equal' || relation === 'target-ahead') return { kind: 'skipped', targetId: source.id }
  if (relation === 'source-ahead') {
    // An active official backend must not be interrupted just to fast-forward
    // an old VS Code copy. Preserve that newer copy as a separate fork instead.
    const writer = await target.open(source.id, 'write').catch((error: unknown) => {
      if ((error as Error).name === 'SessionAlreadyOwnedError') return undefined
      throw error
    })
    try {
      if (writer !== undefined) {
        const current = (await writer.read()).events
        const rechecked = compareHistories(events, current)
        if (rechecked === 'source-ahead') { await writer.append(events.slice(current.length)); await writer.flush(); return { kind: 'advanced', targetId: source.id } }
        if (rechecked !== 'diverged') return { kind: 'skipped', targetId: source.id }
      }
    } finally { await writer?.close() }
  }
  // The official fork implementation remaps the lineage boundary; never search/replace IDs in raw logs.
  const id = SessionId(`session-vscode-history-${hash(sourceHome + source.id + canonicalJson(events)).slice(0,24)}`)
  if (await target.stat(id) !== undefined) {
    const previous = await target.open(id, 'read')
    try {
      const restored = (await previous.read()).events
      if (!['equal', 'target-ahead'].includes(compareHistories(events, restored))) throw new Error('Incomplete history fork; original source retained.')
    } finally { await previous.close() }
    return { kind: 'skipped', targetId: id }
  }
  const context = new Context()
  const fiber = context.plugin(SessionStore)
  await fiber.await()
  const parent = Session.create(source.id, [...events, ...interruptedTurnClosers(events)], source.header, source.inheritedEventCount)
  const detach = context.sessions.enter(parent)
  try {
    const fork = context.sessions.fork(parent, undefined, id)
    const lastTitle = events.findLast((event) => event.type === 'session/title')
    const title = lastTitle?.type === 'session/title' ? lastTitle.data.title : 'Conversation'
    fork.append('session/title', { title: `${title} (${forkLabel})`, messageSeqs: [], source: { kind: 'fallback' } })
    await publish(targetContext, { ...fork.header, ...(source.header.agentPreset === undefined ? {} : { agentPreset: source.header.agentPreset }) }, fork.inheritedEventCount, fork.snapshotEvents())
    return { kind: 'forked', targetId: id }
  } finally { detach(); await fiber.dispose() }
}

async function publish(context: Context, header: SessionHeader, inheritedEventCount: SessionLogOffset, events: Parameters<SessionHandle['append']>[0]): Promise<void> {
  const handle = await context.sessionPersistence.create(header, { inheritedEventCount })
  try { await handle.append(events); await handle.flush() } finally { await handle.close() }
}
function compatibleHeader(a: SessionHeader, b: SessionHeader): boolean {
  return a.cwd === b.cwd && a.parentSession === b.parentSession && a.isSeeded === b.isSeeded && a.origin === b.origin
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
