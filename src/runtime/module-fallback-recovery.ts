import { lstat, mkdir, mkdtemp, readFile, realpath, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { fallbackPackageNames } from './fallback-package-catalog.js'

export interface ModuleFallbackBackup {
  readonly packageName: string
  readonly original: string
  readonly backup: string
}

/** Diagnostic recognition only: filesystem targets never come from stderr. */
export function isModuleFallbackConflict(diagnostics: string): boolean {
  return /exists and is not (?:a symlink or dsh-managed module proxy|a dsh-managed module proxy); remove it so dsh can manage the installation fallback/u.test(diagnostics)
}

/**
 * Quarantine incompatible ordinary entries in DSH's shared module fallback.
 * No recursive deletion, no session/config changes, and no profile-local npm
 * changes. Missing, dangling or stale links and managed proxies are left to
 * upstream's normal healer. Every moved entry remains recoverable inside the
 * home, including its original bytes and file permissions.
 */
export async function recoverModuleFallback(
  home: string,
  installAnchor: string,
  onBackup: (entry: ModuleFallbackBackup) => void = () => {},
): Promise<readonly ModuleFallbackBackup[]> {
  const canonicalHome = await realpath(home).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  })
  if (canonicalHome === undefined) return []
  const profiles = join(canonicalHome, 'profiles')
  const modules = join(profiles, 'node_modules')
  if (!await ordinaryDirectory(profiles) || !await ordinaryDirectory(modules)) return []
  const names = await fallbackPackageNames(installAnchor)
  // Healthy launches do not create a lock or a backup directory.
  if ((await conflicts(modules, names)).length === 0) return []

  // This is exactly app-boot's <profiles/node_modules>.lock, not a parallel
  // extension-only lock. Never steal a lock based on its age.
  return await withFileLock(modules, async () => {
    if (!await ordinaryDirectory(profiles) || !await ordinaryDirectory(modules)) return []
    const candidates = await conflicts(modules, names)
    const moved: ModuleFallbackBackup[] = []
    let backupRoot: string | undefined
    for (const packageName of candidates) {
      const original = join(modules, packageName)
      // Recheck ownership/type while holding the official lock: another window
      // may already have healed the directory since the initial inspection.
      if (!await conflictEntry(modules, packageName)) continue
      backupRoot ??= await mkdtemp(join(canonicalHome, 'module-fallback-backup-'))
      const backup = join(backupRoot, packageName)
      await mkdir(dirname(backup), { recursive: true, mode: 0o700 })
      try { await rename(original, backup) }
      catch (error) {
        // A failed rename never authorizes deleting the source. Earlier moves
        // remain in their logged backups and a later launch can resume safely.
        throw new Error(`Cannot back up Harness module ${packageName} (${errorCode(error) ?? 'unknown error'}); existing files were preserved.`, { cause: error })
      }
      const entry = { packageName, original, backup }
      moved.push(entry)
      onBackup(entry)
    }
    return moved
  }, { waitMs: 5_000 })
}

async function conflicts(modules: string, names: readonly string[]): Promise<string[]> {
  const found: string[] = []
  for (const name of names) if (await conflictEntry(modules, name)) found.push(name)
  return found
}

async function conflictEntry(modules: string, name: string): Promise<boolean> {
  // Never traverse a scope junction into some unrelated installation.
  if (name.startsWith('@') && !await ordinaryDirectory(join(modules, name.split('/')[0]!))) return false
  const entry = join(modules, name)
  const stat = await lstat(entry).catch(missingOnly)
  if (stat === undefined || stat.isSymbolicLink()) return false
  if (!stat.isDirectory() && !stat.isFile()) return false
  if (!stat.isDirectory()) return true
  try {
    const manifest = JSON.parse(await readFile(join(entry, 'package.json'), 'utf8')) as { dsh?: { moduleFallback?: { targets?: unknown } } } | null
    // Match upstream's ownership marker rather than inventing a version rule.
    return manifest?.dsh?.moduleFallback?.targets === undefined
  } catch (error) {
    if (error instanceof SyntaxError || ['ENOENT', 'EISDIR'].includes(errorCode(error) ?? '')) return true
    throw error // Permission/I/O errors are not evidence that the entry is disposable.
  }
}

async function ordinaryDirectory(directory: string): Promise<boolean> {
  const stat = await lstat(directory).catch(missingOnly)
  return stat !== undefined && stat.isDirectory() && !stat.isSymbolicLink()
}

function missingOnly(error: unknown): undefined {
  if (errorCode(error) === 'ENOENT') return undefined
  throw error
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
}
