/**
 * Session visibility: the official Harness archive set plus this workbench's
 * restore overlay. Unrelated to `src/import/session-archive.ts`, which handles
 * session ZIPs.
 */

export const RESTORED_ARCHIVE_STATE_KEY = 'sessionArchive.restoredIds'

export function readRestoredArchiveIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((id): id is string => typeof id === 'string' && id !== '')
}

/**
 * A session is hidden from the default list when Harness has archived it
 * and this workbench has not restored it. Restore is a local overlay because
 * rc.7 has `workspace.archiveSession` but no unarchive RPC.
 */
export function isEffectivelyArchived(
  sessionId: string,
  archivedIds: ReadonlySet<string>,
  restoredIds: ReadonlySet<string>,
): boolean {
  return archivedIds.has(sessionId) && !restoredIds.has(sessionId)
}

export function partitionSessionLists<T extends { readonly id: string }>(
  sessions: readonly T[],
  archivedIds: ReadonlySet<string>,
  restoredIds: ReadonlySet<string>,
): { readonly active: readonly T[]; readonly archived: readonly T[] } {
  const active: T[] = []
  const archived: T[] = []
  for (const session of sessions) {
    if (isEffectivelyArchived(session.id, archivedIds, restoredIds)) archived.push(session)
    else active.push(session)
  }
  return { active, archived }
}

/** Drop restore overlays that no longer correspond to an official archive. */
export function pruneRestoredArchiveIds(
  archivedIds: ReadonlySet<string>,
  restoredIds: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set([...restoredIds].filter((id) => archivedIds.has(id)))
}
