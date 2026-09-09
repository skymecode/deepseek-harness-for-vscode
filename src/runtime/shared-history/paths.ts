import * as os from 'node:os'
import * as path from 'node:path'

/** Runtime/profile settings remain private; only transcripts and their attachments are shared. */
export function sharedHistoryHome(
  configured = '',
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const selected = configured.trim() || env.DSH_HOME?.trim() || paths.join(home, '.dsh')
  const expanded = selected === '~' ? home : /^~[\\/]/u.test(selected) ? paths.join(home, selected.slice(2)) : selected
  if (!paths.isAbsolute(expanded)) throw new Error('The shared Harness history home must be an absolute path.')
  return paths.normalize(expanded)
}
