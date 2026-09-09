import { constants, createReadStream } from 'node:fs'
import { copyFile, link, lstat, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

/** Copy content-addressed attachment files without ever publishing a partial or overwriting a collision. */
export async function migrateAttachments(source: string, target: string, verified = new Map<string, string>()): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error('Linked attachment requires review; original stores preserved.')
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) { await migrateAttachments(from, to, verified); continue }
    if (!entry.isFile()) continue
    try {
      const targetStat = await lstat(to)
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error('Unexpected attachment target; original stores preserved.')
      const sourceStat = await stat(from)
      const signature = JSON.stringify([sourceStat.size, sourceStat.mtimeMs, sourceStat.ctimeMs, targetStat.size, targetStat.mtimeMs, targetStat.ctimeMs])
      if (verified.get(to) === signature) continue
      if (await digest(from) !== await digest(to)) throw new Error('Conflicting attachment content; original stores preserved.')
      verified.set(to, signature)
      continue
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await mkdir(dirname(to), { recursive: true, mode: 0o700 })
    const temporary = `${to}.migration-${randomUUID()}.tmp`
    try {
      await copyFile(from, temporary, constants.COPYFILE_EXCL)
      try { await link(temporary, to) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await digest(temporary) !== await digest(to)) throw error
      }
    } finally { await unlink(temporary).catch(() => undefined) }
  }
}

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
