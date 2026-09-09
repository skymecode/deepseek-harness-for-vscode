import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

interface Manifest {
  readonly name?: string
  readonly dependencies?: Record<string, unknown>
  readonly peerDependencies?: Record<string, unknown>
}

/** A package name is a single leaf, or one scope and leaf; never a filesystem path. */
function safePackageName(name: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu.test(name)
}

/**
 * Mirror app-boot's dependency/peer traversal from the installed DSH manifest.
 * Do not inspect user profile dependencies: only installation-owned names may
 * be repaired in the shared fallback. Resolve paths directly because many
 * packages deliberately do not export their package.json subpath.
 */
export async function fallbackPackageNames(installAnchor: string): Promise<readonly string[]> {
  const manifest = await readManifest(installAnchor)
  if (manifest.name !== '@deepseek-ai/dsh') throw new Error('Invalid bundled Harness installation anchor.')
  const names = new Set([manifest.name])
  const queue = [{ anchor: installAnchor, manifest }]
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!
    for (const name of [...Object.keys(current.manifest.dependencies ?? {}), ...Object.keys(current.manifest.peerDependencies ?? {})]) {
      if (!safePackageName(name)) throw new Error('Invalid package name in the bundled Harness dependency graph.')
      if (names.has(name)) continue
      const paths = createRequire(current.anchor).resolve.paths(name) ?? []
      const anchor = paths.map((directory) => join(directory, name, 'package.json')).find(existsSync)
      if (anchor === undefined) continue // Optional platform packages can legitimately be absent.
      names.add(name)
      queue.push({ anchor, manifest: await readManifest(anchor) })
    }
  }
  return [...names]
}

async function readManifest(file: string): Promise<Manifest> {
  const value: unknown = JSON.parse(await readFile(file, 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid bundled package manifest.')
  return value as Manifest
}
