import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Respect plaintext legacy/custom homes as well as the official default Zstandard format. */
export async function historyCompression(root: string): Promise<'zstd' | 'none'> {
  const formats = new Set<'zstd' | 'none'>()
  const list = async (directory: string) => readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const project of await list(root)) {
    if (!project.isDirectory()) continue
    for (const session of await list(join(root, project.name))) {
      if (!session.isDirectory()) continue
      for (const file of await list(join(root, project.name, session.name))) {
        if (!file.isFile() || !/^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/u.test(file.name)) continue
        formats.add(file.name.endsWith('.zstd') ? 'zstd' : 'none')
      }
    }
  }
  if (formats.size > 1) throw new Error('Mixed physical session formats require separate stores; originals preserved.')
  return formats.has('none') ? 'none' : 'zstd'
}
