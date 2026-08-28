import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
    this.save()
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
    this.save()
    return { ok: true, message: 'discarded' }
  }

  /** Forgets a session that failed before it was created by the Host. */
  forgetSession(sessionId: string): void {
    const removedRecord = this.records.delete(sessionId)
    const removedRoot = this.sessionRoots.delete(sessionId)
    if (removedRecord || removedRoot) this.save()
  }

  /**
   * Removes worktrees whose session no longer exists (deleted sessions, or a
   * crash between worktree add and session create). Also prunes stale git
   * worktree metadata. Returns the removed session ids.
   */
  async cleanupOrphans(liveSessionIds: ReadonlySet<string>): Promise<string[]> {
    const removed: string[] = []
    for (const [sessionId, record] of this.records) {
      if (liveSessionIds.has(sessionId)) continue
      await this.run(record.repoRoot, ['worktree', 'remove', '--force', record.worktreePath]).catch(() => undefined)
      await this.run(record.repoRoot, ['branch', '-D', record.branch]).catch(() => undefined)
      this.records.delete(sessionId)
      this.sessionRoots.delete(sessionId)
      removed.push(sessionId)
    }
    for (const sessionId of this.sessionRoots.keys()) {
      if (!liveSessionIds.has(sessionId)) this.sessionRoots.delete(sessionId)
    }
    this.save()
    return removed
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

  private save(): void {
    void this.storage.update(REGISTRY_KEY, [...this.records.values()])
    void this.storage.update(SESSION_ROOTS_KEY, Object.fromEntries(this.sessionRoots))
  }
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
