import { mkdtemp, mkdir, readdir, readFile, rename } from 'node:fs/promises'
import * as path from 'node:path'

/**
 * Quarantines profile-level copies of @deepseek-ai runtime packages whose version
 * differs from the runtime bundled in the VSIX.
 *
 * cordis-plugin-loader resolves profile entries from the profile's own
 * node_modules before the CLI bundle, so a package planted there by an older
 * extension build (e.g. dsh-llm-deepseek@0.1.0-rc.6, whose config schema
 * pre-dates the `low` reasoning tier) shadows the bundled runtime and crashes
 * the Gateway boot with a stale-schema validation error. Pruning mismatched
 * copies makes resolution fall through to the bundled packages again.
 *
 * Returns the names of the quarantined packages. Unreadable entries are left
 * in place: pruning must never block the boot or destroy user data.
 */
export async function pruneShadowedRuntimePackages(
  profileScopeDir: string,
  bundledScopeDir: string,
  log: (line: string) => void,
): Promise<string[]> {
  const removed: string[] = []
  let backupRoot: string | undefined
  let names: string[]
  try {
    names = (await readdir(profileScopeDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
  } catch {
    return removed
  }
  for (const name of names) {
    const bundledVersion = await packageVersion(path.join(bundledScopeDir, name))
    if (bundledVersion === undefined) continue
    const profileVersion = await packageVersion(path.join(profileScopeDir, name))
    if (profileVersion === undefined || profileVersion === bundledVersion) continue
    try {
      backupRoot ??= await mkdtemp(path.join(path.dirname(profileScopeDir), 'runtime-package-backup-'))
      const backup = path.join(backupRoot, name)
      await mkdir(path.dirname(backup), { recursive: true })
      await rename(path.join(profileScopeDir, name), backup)
      removed.push(name)
      log(`[host] Backed up stale profile runtime package @deepseek-ai/${name}@${profileVersion} to ${backup} (bundled: ${bundledVersion}).`)
    } catch {
      log(`[host] Failed to prune stale profile runtime package @deepseek-ai/${name}@${profileVersion}.`)
    }
  }
  return removed
}

async function packageVersion(directory: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as unknown
    if (typeof manifest !== 'object' || manifest === null) return undefined
    const version = (manifest as Record<string, unknown>).version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}
