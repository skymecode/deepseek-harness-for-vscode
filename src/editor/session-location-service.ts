import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, dirname } from 'node:path'
import { promisify } from 'node:util'
import type { SessionLocationView } from '../domain/session-management.js'
import { sameWorkspacePath } from '../domain/workspace-scope.js'

const run = promisify(execFile)
async function git(cwd: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
  env.GIT_OPTIONAL_LOCKS = '0'
  env.LC_ALL = 'C'
  const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 5_000, maxBuffer: 262_144, windowsHide: true, env })
  return stdout.trimEnd()
}

/** Read Git's actual registration; never infer isolation from a folder name or our registry. */
export async function inspectSessionLocation(cwd: string): Promise<SessionLocationView> {
  if (!isAbsolute(cwd)) return { cwd, kind: 'unknown' }
  let canonical: string
  try {
    if (!(await stat(cwd)).isDirectory()) return { cwd, kind: 'missing', exists: false }
    canonical = await realpath(cwd)
  } catch (error) {
    return { cwd, kind: ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') ? 'missing' : 'unknown',
      ...(['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') ? { exists: false } : {}) }
  }
  try {
    const lines = (await git(canonical, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'])).split('\n')
    const [top, admin, common] = lines
    if (lines.length !== 3 || !top || !admin || !common) return { cwd: canonical, kind: 'unknown', exists: true }
    const repositoryId = await realpath(common)
    const isolated = !sameWorkspacePath(await realpath(admin), repositoryId)
    // A linked worktree may live anywhere, including the official .agents/worktrees pool.
    let projectPath = top
    if (isolated) {
      const listing = await git(canonical, ['worktree', 'list', '--porcelain', '-z'])
      const primary = listing.split('\0').find(field => field.startsWith('worktree '))?.slice(9)
      projectPath = primary || (repositoryId.endsWith('/.git') ? dirname(repositoryId) : top)
    }
    const branch = await git(canonical, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
    return { cwd: canonical, kind: isolated ? 'worktree' : 'directory', exists: true, projectPath,
      repositoryId, ...(branch ? { branch } : {}) }
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? '')
    return { cwd: canonical, projectPath: canonical, exists: true,
      kind: /not a git repository/i.test(stderr) ? 'directory' : 'unknown' }
  }
}

/** Deduplicated, bounded background probes keep large history lists responsive. */
export class SessionLocationService {
  private readonly cache = new Map<string, { value?: SessionLocationView; time: number; pending?: Promise<SessionLocationView> }>()
  private readonly queue: { cwd: string; start: () => void }[] = []
  private running = 0
  private disposed = false
  constructor(private readonly changed: () => void, private readonly inspect = inspectSessionLocation) {}

  get(cwd: string | undefined): SessionLocationView | undefined {
    if (!cwd) return undefined
    const entry = this.cache.get(cwd)
    if (!entry || Date.now() - entry.time > 30_000) void this.refresh(cwd, false)
    return entry?.value
  }

  refresh(cwd: string, priority = true): Promise<SessionLocationView> {
    const existing = this.cache.get(cwd)
    if (existing?.pending) {
      const index = this.queue.findIndex(item => item.cwd === cwd)
      if (priority && index > 0) this.queue.unshift(this.queue.splice(index, 1)[0]!)
      return existing.pending
    }
    const entry: { value?: SessionLocationView; time: number; pending?: Promise<SessionLocationView> } = {
      ...(existing?.value ? { value: existing.value } : {}), time: Date.now(),
    }
    const pending = new Promise<SessionLocationView>(resolve => {
      const start = (): void => {
        this.running++
        void this.inspect(cwd).catch((): SessionLocationView => ({ cwd, kind: 'unknown' })).then(value => {
          entry.value = value
          entry.time = Date.now()
          delete entry.pending
          resolve(value)
          if (!this.disposed) this.changed()
        }).finally(() => { this.running--; this.drain() })
      }
      if (priority) this.queue.unshift({ cwd, start })
      else this.queue.push({ cwd, start })
    })
    entry.pending = pending
    this.cache.set(cwd, entry)
    this.drain()
    return pending
  }

  private drain(): void { while (this.running < 4 && this.queue.length) this.queue.shift()!.start() }
  dispose(): void { this.disposed = true }
}
