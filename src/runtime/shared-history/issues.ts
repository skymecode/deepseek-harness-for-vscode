import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface HistoryMigrationIssue {
  readonly source: string
  readonly sessionId?: string
  readonly reason: 'unsupported-format' | 'corrupt-session' | 'unlisted-header' | 'source-unavailable' | 'attachment-conflict' | 'migration-error'
}

/** Header discovery can omit unreadable entries; report them rather than claiming complete migration. */
export async function storedSessionDirectories(root: string): Promise<string[]> {
  const projects = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const ids: string[] = []
  for (const project of projects) {
    if (!project.isDirectory()) continue
    for (const entry of await readdir(join(root, project.name), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const files = await readdir(join(root, project.name, entry.name))
      if (files.some(file => /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/u.test(file))) ids.push(entry.name)
    }
  }
  return ids
}

export function issueReason(error: unknown): HistoryMigrationIssue['reason'] {
  const name = error instanceof Error ? error.name : ''
  if (name === 'SessionFormatUnsupportedError') return 'unsupported-format'
  if (name === 'SessionPersistenceCorruptionError') return 'corrupt-session'
  if (error instanceof Error && error.message.startsWith('Conflicting attachment')) return 'attachment-conflict'
  return 'migration-error'
}
