import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import type { ExecFileOptions } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import type * as vscode from 'vscode'

const execFileAsync = promisify(execFile)

export type ExecResult = { stdout: string; stderr: string }

/** One worktree owned by one session: the session's sandbox root (cwd). */
export interface WorktreeRecord {
  readonly sessionId: string
  /** The repository the worktree was created from (`.git` lives here). */
  readonly repoRoot: string
  /** Branch the worktree was split from (typically `main`/`master`). */
  readonly baseBranch: string
  /** The isolated branch, always `dsh/<sessionId>`. */
  readonly branch: string
  /** Absolute path of the worktree working tree. */
  readonly worktreePath: string
  readonly createdAt: number
}

/** Result of preparing a session working directory (A2 isolation). */
export interface WorktreePreparation {
  /** The cwd to hand the new session: the worktree when isolated, else the shared base. */
  readonly cwd: string
  readonly isolated: boolean
  readonly record?: WorktreeRecord
  /** Human-readable reason when isolation could not be established. */
  readonly reason?: string
}

export interface MergeOutcome {
  readonly ok: boolean
  readonly message: string
}

export interface DiscardOutcome {
  readonly ok: boolean
  readonly message: string
}

/** Injectable git runner so tests never touch a real repository. */
export type GitRunner = (cwd: string, args: readonly string[]) => Promise<ExecResult>

const REGISTRY_KEY = 'dsh.worktrees.v1'
const SESSION_ROOTS_KEY = 'dsh.worktree-session-roots.v1'
const DISK_REGISTRY_VERSION = 2
/**
 * Mirror of the registry written inside each repository's `.git` directory.
 * The VSCode Memento (globalState) is not durable — the `state.vscdb` file can
 * be rebuilt empty — so this file is the authoritative record that lets
 * `recover()` restore Review/Merge/Discard affordances after a reset.
 */
const DISK_REGISTRY_FILE = 'dsh-worktrees.json'

interface DiskRegistrySnapshot {
  readonly records: readonly WorktreeRecord[]
  readonly sessionRoots: Readonly<Record<string, string>>
}

/**
 * Per-session git worktree isolation (plan A2).
 *
 * Every new session gets its own worktree checked out on a dedicated branch
 * `dsh/<sessionId>`, and that worktree path becomes the session cwd. Because
 * the DSH workspace-write sandbox fences writes under the session cwd, each
 * session's sandbox boundary is automatically its own worktree — the agent can
 * touch nothing outside it, and no session can clobber another's edits in the
 * shared repo. Non-git workspaces fall back to the shared cwd.
 */
export class WorktreeService implements vscode.Disposable {
  private readonly records = new Map<string, WorktreeRecord>()
  /** Durable project identity retained after a worktree is discarded. */
  private readonly sessionRoots = new Map<string, string>()
  /** Serializes mirror snapshots so an older save cannot overwrite a newer one. */
  private diskWriteQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly storage: vscode.Memento,
    private readonly run: GitRunner = runGit,
  ) {
    this.load()
  }

  /** The record for one session, if it is isolated in a worktree. */
  recordFor(sessionId: string): WorktreeRecord | undefined {
    return this.records.get(sessionId)
  }

  /** The repository root associated with a session, including after discard. */
  repoRootFor(sessionId: string): string | undefined {
    return this.sessionRoots.get(sessionId) ?? this.records.get(sessionId)?.repoRoot
  }

  /** The cwd a session's history row should display (repo root, not the worktree leaf). */
  displayCwd(sessionId: string, fallback: string | undefined): string | undefined {
    return this.repoRootFor(sessionId) ?? fallback
  }

  /**
   * Creates the worktree for a new session and returns the cwd to hand it.
   * Falls back to the shared base cwd (non-git workspace, git missing, or
   * worktree creation failure) with a reason.
   */
  async prepare(sessionId: string, baseCwd: string): Promise<WorktreePreparation> {
    const repoRoot = await gitRoot(this.run, baseCwd)
    if (repoRoot === undefined) return { cwd: baseCwd, isolated: false, reason: 'no-git-repo' }
    const baseBranch = await currentBranch(this.run, repoRoot)
    if (baseBranch === undefined) return { cwd: baseCwd, isolated: false, reason: 'detached-head' }
    const branch = `dsh/${sessionId}`
    const worktreePath = joinPathLike(repoRoot, '.dsh-worktrees', sessionId)
    try {
      await this.run(repoRoot, ['worktree', 'add', worktreePath, '-b', branch])
      await ignoreDshWorktrees(repoRoot)
    } catch {
      return { cwd: baseCwd, isolated: false, reason: 'worktree-add-failed' }
    }
    const record: WorktreeRecord = {
      sessionId,
      repoRoot,
      baseBranch,
      branch,
      worktreePath,
      createdAt: Date.now(),
    }
    this.records.set(sessionId, record)
    this.sessionRoots.set(sessionId, repoRoot)
    await this.save()
    return { cwd: worktreePath, isolated: true, record }
  }

  /**
   * Full session output as a unified diff against the base branch. Deliberately
   * compares the base commit to the worktree's *working tree* (not to the
   * session branch): the sandbox fences agent git writes out of the shared
   * `.git` directory, so session work is normally uncommitted — a commit-based
   * `base...branch` diff would read as empty and hide everything.
   */
  async diffText(sessionId: string): Promise<string | undefined> {
    const record = this.records.get(sessionId)
    if (record === undefined) return undefined
    try {
      await this.markIntentToAdd(record)
      const { stdout } = await this.run(record.worktreePath, ['diff', record.baseBranch])
      return stdout
    } catch {
      return undefined
    }
  }

  /**
   * The shared (non-isolated) working tree's uncommitted diff against HEAD,
   * for sessions that run directly in the main checkout. Tracks edits and
   * deletions only — untracked files are deliberately left out so the intent
   * marker is never stamped into the user's real index.
   */
  async workingTreeDiff(repoRoot: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.run(repoRoot, ['diff', 'HEAD'])
      return stdout
    } catch {
      return undefined
    }
  }

  /**
   * Whether the main checkout has uncommitted changes. Auto-isolation uses
   * this as a safety gate: migrating a session while the shared checkout is
   * dirty would strand those changes outside the fresh worktree.
   */
  async workingTreeDirty(repoRoot: string): Promise<boolean> {
    return worktreeDirty(this.run, repoRoot)
  }

  /**
   * Marks untracked files intent-to-add so they appear in `git diff` output
   * (new files are half of what a session produces). Best-effort: a failure
   * (e.g. an index.lock race with the session) only loses untracked entries.
   */
  private async markIntentToAdd(record: WorktreeRecord): Promise<void> {
    await this.run(record.worktreePath, ['add', '-N', '.']).catch(() => undefined)
  }

  /**
   * Merges the session's final worktree state back into its base branch using
   * a temporary detached worktree, so the user's main checkout is never
   * touched by the merge machinery. Because the sandbox keeps agent commits
   * out of the shared `.git` directory, the session's work usually lives as
   * uncommitted changes: committed branch work (if any) comes in via `git
   * merge`, then the worktree's uncommitted diff is applied on top and
   * committed in the temporary worktree. The base branch ref is advanced with
   * `git update-ref` (the primitive `git fetch` uses), and — when the main
   * worktree was clean — its working tree is synced to the result.
   */
  async mergeBack(sessionId: string): Promise<MergeOutcome> {
    const record = this.records.get(sessionId)
    if (record === undefined) return { ok: false, message: 'no-worktree' }
    const tmp = joinPathLike(record.repoRoot, '.dsh-worktrees', `.merge-${sessionId}`)
    // Captured before the ref moves: after `update-ref` the main worktree is
    // necessarily "dirty" relative to the new HEAD, so post-merge checks are
    // meaningless. A clean start means we can safely sync the working tree.
    const wasClean = !(await worktreeDirty(this.run, record.repoRoot))
    const branchHead = await this.revParse(record.repoRoot, `refs/heads/${record.branch}`)
    const baseHead = await this.revParse(record.repoRoot, `refs/heads/${record.baseBranch}`)
    try {
      await this.run(record.repoRoot, ['worktree', 'add', '--detach', tmp, record.baseBranch])
      try {
        if (branchHead !== undefined && branchHead !== baseHead) {
          await this.run(tmp, ['merge', '--no-ff', '-m', `Merge session ${sessionId}`, record.branch])
        }
        const patch = await this.uncommittedPatch(record)
        if (patch !== '') {
          const applied = await this.applyPatch(tmp, sessionId, patch)
          if (!applied) {
            await this.run(record.repoRoot, ['worktree', 'remove', '--force', tmp]).catch(() => undefined)
            return { ok: false, message: 'merge-conflict' }
          }
        }
        const hasCommits = branchHead !== undefined && branchHead !== baseHead
        if (patch === '' && !hasCommits) {
          await this.run(record.repoRoot, ['worktree', 'remove', '--force', tmp]).catch(() => undefined)
          return { ok: true, message: 'no-changes' }
        }
        if (patch !== '') {
          await this.run(tmp, ['add', '-A'])
          await this.run(tmp, [
            '-c', 'user.name=DSH Session Merge',
            '-c', 'user.email=dsh-session@localhost',
            'commit', '-m', `Session ${sessionId} worktree changes`,
          ])
        }
        const { stdout: head } = await this.run(tmp, ['rev-parse', 'HEAD'])
        await this.run(record.repoRoot, ['update-ref', `refs/heads/${record.baseBranch}`, head.trim()])
        await this.run(record.repoRoot, ['worktree', 'remove', '--force', tmp])
        if (wasClean) {
          // The main worktree was clean, so syncing it to the merge result
          // loses nothing and shows the merged state in the user's checkout.
          await this.run(record.repoRoot, ['reset', '--hard', 'HEAD']).catch(() => undefined)
          return { ok: true, message: 'merged' }
        }
        // The ref moved but the user's working tree had uncommitted changes;
        // they are untouched and the tree now trails the branch.
        return { ok: true, message: 'merged-dirty' }
      } catch {
        await this.run(record.repoRoot, ['worktree', 'remove', '--force', tmp]).catch(() => undefined)
        return { ok: false, message: 'merge-conflict' }
      }
    } catch {
      return { ok: false, message: 'merge-worktree-failed' }
    }
  }

  private async revParse(cwd: string, ref: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.run(cwd, ['rev-parse', ref])
      return stdout.trim()
    } catch {
      return undefined
    }
  }

  /**
   * The worktree's uncommitted output as a patch (tracked edits, deletions and
   * intent-to-add new files vs HEAD). Empty string when there is nothing to
   * apply or the diff cannot be produced.
   */
  private async uncommittedPatch(record: WorktreeRecord): Promise<string> {
    try {
      await this.markIntentToAdd(record)
      const { stdout } = await this.run(record.worktreePath, ['diff', 'HEAD'])
      return stdout.trim() === '' ? '' : stdout
    } catch {
      return ''
    }
  }

  /** Applies a patch inside the temporary merge worktree via a scratch file. */
  private async applyPatch(tmp: string, sessionId: string, patch: string): Promise<boolean> {
    const patchFile = path.join(os.tmpdir(), `dsh-merge-${sessionId}.patch`)
    try {
      await writeFile(patchFile, patch)
      await this.run(tmp, ['apply', '--whitespace=nowarn', patchFile])
      return true
    } catch {
      return false
    } finally {
      await rm(patchFile, { force: true }).catch(() => undefined)
    }
  }

  /** Removes the session's worktree and its dedicated branch. */
  async discard(sessionId: string): Promise<DiscardOutcome> {
    const record = this.records.get(sessionId)
    if (record === undefined) return { ok: true, message: 'no-worktree' }
    try {
      await this.run(record.repoRoot, ['worktree', 'remove', '--force', record.worktreePath])
    } catch {
      return { ok: false, message: 'worktree-remove-failed' }
    }
    await this.run(record.repoRoot, ['branch', '-D', record.branch]).catch(() => undefined)
    this.records.delete(sessionId)
    // Keep the durable project identity: the session log survives discard and
    // must remain visible in the same workspace after the worktree is gone.
    await this.save()
    return { ok: true, message: 'discarded' }
  }

  /** Forgets a session that failed before it was created by the Host. */
  async forgetSession(sessionId: string): Promise<void> {
    const repoRoot = this.repoRootFor(sessionId)
    const removedRecord = this.records.delete(sessionId)
    const removedRoot = this.sessionRoots.delete(sessionId)
    if (removedRecord || removedRoot) await this.save(repoRoot === undefined ? [] : [repoRoot])
  }

  /**
   * Removes worktrees whose session no longer exists (deleted sessions, or a
   * crash between worktree add and session create). Also prunes stale git
   * worktree metadata. Returns the removed session ids.
   */
  async cleanupOrphans(liveSessionIds: ReadonlySet<string>): Promise<string[]> {
    const removed: string[] = []
    const affectedRepoRoots = new Set<string>()
    for (const [sessionId, record] of this.records) {
      if (liveSessionIds.has(sessionId)) continue
      await this.run(record.repoRoot, ['worktree', 'remove', '--force', record.worktreePath]).catch(() => undefined)
      await this.run(record.repoRoot, ['branch', '-D', record.branch]).catch(() => undefined)
      this.records.delete(sessionId)
      this.sessionRoots.delete(sessionId)
      affectedRepoRoots.add(record.repoRoot)
      removed.push(sessionId)
    }
    for (const [sessionId, repoRoot] of this.sessionRoots) {
      if (liveSessionIds.has(sessionId)) continue
      this.sessionRoots.delete(sessionId)
      affectedRepoRoots.add(repoRoot)
    }
    await this.save(affectedRepoRoots)
    return removed
  }

  /**
   * Restores worktree records from disk after the Memento was lost or cleared
   * (VSCode rebuilds `state.vscdb` empty from time to time). Two sources, in
   * priority order:
   *   1. the per-repository `.git/dsh-worktrees.json` mirror (accurate
   *      `baseBranch`/`createdAt`, written by every `save()`);
   *   2. a scan of the isolation directory `.dsh-worktrees/*`, which rebuilds
   *      a record from each surviving worktree even when the mirror is gone.
   * Existing in-memory records always win. Returns the restored records.
   */
  async recover(workspaceRoots: readonly string[]): Promise<WorktreeRecord[]> {
    const restored: WorktreeRecord[] = []
    const seen = new Set<string>(this.records.keys())
    let changed = false
    for (const root of workspaceRoots) {
      if (root === undefined || root === '') continue
      const disk = await this.readDiskRegistry(root)
      // Root-only entries deliberately restore even when the worktree no
      // longer exists: discarded sessions still belong to this repository.
      for (const [sessionId, repoRoot] of Object.entries(disk.sessionRoots)) {
        if (this.sessionRoots.has(sessionId)) continue
        this.sessionRoots.set(sessionId, repoRoot)
        changed = true
      }
      for (const record of disk.records) {
        if (seen.has(record.sessionId) || !(await pathExists(record.worktreePath))) continue
        this.records.set(record.sessionId, record)
        this.sessionRoots.set(record.sessionId, record.repoRoot)
        seen.add(record.sessionId)
        restored.push(record)
        changed = true
      }
      for (const sessionId of await listSubdirectories(joinPathLike(root, '.dsh-worktrees'))) {
        if (seen.has(sessionId) || sessionId.startsWith('.merge-')) continue
        const worktreePath = joinPathLike(root, '.dsh-worktrees', sessionId)
        const record = await this.recordFromWorktree(root, sessionId, worktreePath)
        if (record === undefined) continue
        this.records.set(sessionId, record)
        this.sessionRoots.set(sessionId, record.repoRoot)
        seen.add(sessionId)
        restored.push(record)
        changed = true
      }
    }
    if (changed) await this.save()
    return restored
  }

  /** Records and retained roots persisted in the repository mirror, if readable. */
  private async readDiskRegistry(root: string): Promise<DiskRegistrySnapshot> {
    try {
      const raw = await readFile(joinPathLike(root, '.git', DISK_REGISTRY_FILE), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      // Legacy mirrors were a bare WorktreeRecord array. Treat every record as
      // a root mapping too: an older discard could leave its now-stale record
      // in the file, and orphan cleanup will remove the mapping if the Host no
      // longer knows that session.
      if (Array.isArray(parsed)) {
        const records = worktreeRecords(parsed)
        return { records, sessionRoots: rootsFromRecords(records) }
      }
      if (typeof parsed !== 'object' || parsed === null) return emptyDiskRegistry()
      const candidate = parsed as { readonly records?: unknown; readonly sessionRoots?: unknown }
      const records = worktreeRecords(candidate.records)
      return {
        records,
        sessionRoots: {
          ...rootsFromRecords(records),
          ...sessionRootRecord(candidate.sessionRoots),
        },
      }
    } catch {
      return emptyDiskRegistry()
    }
  }

  /**
   * Rebuilds a record for one surviving worktree directory. `.git` inside a
   * worktree is a pointer file naming its gitdir; requiring it keeps us from
   * mistaking random directories for worktrees. The base branch degrades to
   * the repository's default branch when it cannot be recovered.
   */
  private async recordFromWorktree(root: string, sessionId: string, worktreePath: string): Promise<WorktreeRecord | undefined> {
    try {
      const gitFile = await readFile(joinPathLike(worktreePath, '.git'), 'utf8')
      if (!gitFile.trim().includes('worktrees')) return undefined
      const baseBranch = await defaultBranch(this.run, root)
      return {
        sessionId,
        repoRoot: root,
        baseBranch,
        branch: `dsh/${sessionId}`,
        worktreePath,
        createdAt: Date.now(),
      }
    } catch {
      return undefined
    }
  }

  dispose(): void {
    this.records.clear()
    this.sessionRoots.clear()
  }

  private load(): void {
    const roots = this.storage.get<Record<string, string>>(SESSION_ROOTS_KEY)
    if (roots !== undefined && typeof roots === 'object' && roots !== null) {
      for (const [sessionId, repoRoot] of Object.entries(roots)) {
        if (typeof repoRoot === 'string' && repoRoot !== '') this.sessionRoots.set(sessionId, repoRoot)
      }
    }
    const value = this.storage.get<WorktreeRecord[]>(REGISTRY_KEY)
    if (!Array.isArray(value)) return
    for (const entry of value) {
      if (typeof entry?.sessionId === 'string' && typeof entry.worktreePath === 'string') {
        this.records.set(entry.sessionId, entry)
        if (!this.sessionRoots.has(entry.sessionId) && typeof entry.repoRoot === 'string') {
          this.sessionRoots.set(entry.sessionId, entry.repoRoot)
        }
      }
    }
  }

  private async save(additionalRepoRoots: Iterable<string> = []): Promise<void> {
    const records = [...this.records.values()]
    const sessionRoots = Object.fromEntries(this.sessionRoots)
    const rootsToWrite = [...additionalRepoRoots]
    void this.storage.update(REGISTRY_KEY, records)
    void this.storage.update(SESSION_ROOTS_KEY, sessionRoots)
    this.diskWriteQueue = this.diskWriteQueue
      .then(() => this.writeDiskRegistries(records, sessionRoots, rootsToWrite))
      .catch(() => undefined)
    await this.diskWriteQueue
  }

  /** Mirrors live records and retained roots into each repository's `.git` directory. */
  private async writeDiskRegistries(
    records: readonly WorktreeRecord[],
    sessionRoots: Readonly<Record<string, string>>,
    additionalRepoRoots: readonly string[],
  ): Promise<void> {
    const repoRoots = new Set(additionalRepoRoots)
    for (const record of records) repoRoots.add(record.repoRoot)
    for (const repoRoot of Object.values(sessionRoots)) repoRoots.add(repoRoot)
    for (const repoRoot of repoRoots) {
      const repoRecords = records.filter((record) => record.repoRoot === repoRoot)
      const repoSessionRoots = Object.fromEntries(
        Object.entries(sessionRoots).filter(([, storedRoot]) => storedRoot === repoRoot),
      )
      const file = joinPathLike(repoRoot, '.git', DISK_REGISTRY_FILE)
      await mkdir(dirnameLike(repoRoot, file), { recursive: true }).catch(() => undefined)
      await writeFile(file, JSON.stringify({
        version: DISK_REGISTRY_VERSION,
        records: repoRecords,
        sessionRoots: repoSessionRoots,
      }, null, 2)).catch(() => undefined)
    }
  }
}

function emptyDiskRegistry(): DiskRegistrySnapshot {
  return { records: [], sessionRoots: {} }
}

function worktreeRecords(value: unknown): WorktreeRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is WorktreeRecord =>
    typeof entry?.sessionId === 'string'
    && typeof entry.repoRoot === 'string'
    && typeof entry.baseBranch === 'string'
    && typeof entry.worktreePath === 'string')
}

function rootsFromRecords(records: readonly WorktreeRecord[]): Record<string, string> {
  return Object.fromEntries(records.map((record) => [record.sessionId, record.repoRoot]))
}

function sessionRootRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''),
  )
}

async function gitRoot(run: GitRunner, cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(cwd, ['rev-parse', '--show-toplevel'])
    const root = stdout.trim()
    return root === '' ? undefined : root
  } catch {
    return undefined
  }
}

async function currentBranch(run: GitRunner, repoRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = stdout.trim()
    return branch === 'HEAD' ? undefined : branch
  } catch {
    return undefined
  }
}

/** Whether the main worktree has uncommitted changes (porcelain status non-empty). */
async function worktreeDirty(run: GitRunner, repoRoot: string): Promise<boolean> {
  try {
    const { stdout } = await run(repoRoot, ['status', '--porcelain'])
    return stdout.trim() !== ''
  } catch {
    // If status is unreadable, err on the side of not touching the worktree.
    return true
  }
}

/** Whether a path exists on disk (worktree directories are the usual target). */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/** Immediate subdirectories of `dir` (skips files and unreadable entries). */
async function listSubdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

/** The repository's default branch (origin/HEAD), falling back to `main`. */
async function defaultBranch(run: GitRunner, repoRoot: string): Promise<string> {
  try {
    const { stdout } = await run(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    const branch = stdout.trim()
    if (branch !== '' && !branch.endsWith('/HEAD')) return branch.replace(/^origin\//u, '')
  } catch {
    // origin/HEAD is unset for local-only repositories.
  }
  return 'main'
}

function runGit(cwd: string, args: readonly string[]): Promise<ExecResult> {
  const options: ExecFileOptions = { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  return execFileAsync('git', [...args], options) as Promise<ExecResult>
}

const EXCLUDE_ENTRY = '.dsh-worktrees/\n'

/**
 * Ensures `.dsh-worktrees/` is ignored by the repository (via the local, never
 * committed `.git/info/exclude`) so the isolation directory and its worktrees
 * do not pollute `git status` of the main checkout. Best-effort: a failure
 * here never fails session creation.
 */
async function ignoreDshWorktrees(repoRoot: string): Promise<void> {
  try {
    const gitDir = joinPathLike(repoRoot, '.git', 'info', 'exclude')
    let content = ''
    try {
      content = await readFile(gitDir, 'utf8')
    } catch {
      await mkdir(dirnameLike(repoRoot, gitDir), { recursive: true })
    }
    if (content.split('\n').includes('.dsh-worktrees/')) return
    await appendFile(gitDir, content.endsWith('\n') ? EXCLUDE_ENTRY : `\n${EXCLUDE_ENTRY}`)
  } catch {
    // Never fail session creation over an exclude-entry nicety.
  }
}

/** Preserve the separator style returned by the injected/real git root. */
function joinPathLike(root: string, ...parts: string[]): string {
  const join = isWindowsPath(root) ? path.win32.join : path.posix.join
  return join(root, ...parts).replaceAll('\\', '/')
}

function dirnameLike(root: string, value: string): string {
  return isWindowsPath(root) ? path.win32.dirname(value) : path.posix.dirname(value)
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.includes('\\')
}
