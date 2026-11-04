/**
 * Per-session git worktree isolation (plan A2).
 *
 * Every new session gets its own worktree checked out on a dedicated branch
 * `dsh/<sessionId>`, and that worktree path becomes the session cwd. Because
 * the DSH workspace-write sandbox fences writes under the session cwd, each
 * session's sandbox boundary is automatically its own worktree — the agent can
 * touch nothing outside it, and no session can clobber another's edits in the
 * shared repo. Non-git workspaces fall back to the shared cwd.
 *
 * The shell-layer git helpers this class drives live in `./worktree-git.ts`.
 */
import type * as vscode from 'vscode'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { rm } from 'node:fs/promises'
import {
  currentBranch,
  defaultBranch,
  dirnameLike,
  gitRoot,
  ignoreDshWorktrees,
  joinPathLike,
  listSubdirectories,
  pathExists,
  runGit,
  worktreeDirty,
} from './worktree-git.js'
import type { GitRunner } from './worktree-git.js'

export type { ExecResult, GitRunner } from './worktree-git.js'

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
  readonly reason?: 'git-not-found' | 'no-git-repo' | 'detached-head' | 'worktree-add-failed'
}

export interface MergeOutcome {
  readonly ok: boolean
  readonly message: string
}

export interface DiscardOutcome {
  readonly ok: boolean
  readonly message: string
}

const REGISTRY_KEY = 'dsh.worktrees.v1'
/**
 * Mirror of the registry written inside each repository's `.git` directory.
 * The VSCode Memento (globalState) is not durable — the `state.vscdb` file can
 * be rebuilt empty — so this file is the authoritative record that lets
 * `recover()` restore Review/Merge/Discard affordances after a reset.
 */
const DISK_REGISTRY_FILE = 'dsh-worktrees.json'

export class WorktreeService implements vscode.Disposable {
  private readonly records = new Map<string, WorktreeRecord>()

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

  /** The repository root a session's worktree lives under, when isolated. */
  repoRootFor(sessionId: string): string | undefined {
    return this.records.get(sessionId)?.repoRoot
  }

  /** The cwd a session's history row should display (repo root, not the worktree leaf). */
  displayCwd(sessionId: string, fallback: string | undefined): string | undefined {
    return this.records.get(sessionId)?.repoRoot ?? fallback
  }

  /**
   * Creates the worktree for a new session and returns the cwd to hand it.
   * Falls back to the shared base cwd (non-git workspace, git missing, or
   * worktree creation failure) with a reason.
   */
  async prepare(sessionId: string, baseCwd: string): Promise<WorktreePreparation> {
    const probe = await gitRoot(this.run, baseCwd)
    if (probe.gitNotFound) return { cwd: baseCwd, isolated: false, reason: 'git-not-found' }
    if (probe.root === undefined) return { cwd: baseCwd, isolated: false, reason: 'no-git-repo' }
    const repoRoot = probe.root
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
    this.save()
    return { ok: true, message: 'discarded' }
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
      removed.push(sessionId)
    }
    this.save()
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
    for (const root of workspaceRoots) {
      if (root === undefined || root === '') continue
      for (const record of await this.readDiskRegistry(root)) {
        if (seen.has(record.sessionId) || !(await pathExists(record.worktreePath))) continue
        this.records.set(record.sessionId, record)
        seen.add(record.sessionId)
        restored.push(record)
      }
      for (const sessionId of await listSubdirectories(joinPathLike(root, '.dsh-worktrees'))) {
        if (seen.has(sessionId) || sessionId.startsWith('.merge-')) continue
        const worktreePath = joinPathLike(root, '.dsh-worktrees', sessionId)
        const record = await this.recordFromWorktree(root, sessionId, worktreePath)
        if (record === undefined) continue
        this.records.set(sessionId, record)
        seen.add(sessionId)
        restored.push(record)
      }
    }
    if (restored.length > 0) this.save()
    return restored
  }

  /** Records persisted in `root/.git/dsh-worktrees.json`, if readable. */
  private async readDiskRegistry(root: string): Promise<WorktreeRecord[]> {
    try {
      const raw = await readFile(joinPathLike(root, '.git', DISK_REGISTRY_FILE), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter((entry): entry is WorktreeRecord =>
        typeof entry?.sessionId === 'string'
        && typeof entry.repoRoot === 'string'
        && typeof entry.baseBranch === 'string'
        && typeof entry.worktreePath === 'string')
    } catch {
      return []
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
  }

  private load(): void {
    const value = this.storage.get<WorktreeRecord[]>(REGISTRY_KEY)
    if (!Array.isArray(value)) return
    for (const entry of value) {
      if (typeof entry?.sessionId === 'string' && typeof entry.worktreePath === 'string') {
        this.records.set(entry.sessionId, entry)
      }
    }
  }

  private save(): void {
    void this.storage.update(REGISTRY_KEY, [...this.records.values()])
    void this.writeDiskRegistries().catch(() => undefined)
  }

  /** Mirrors the registry into each repository's `.git` directory. */
  private async writeDiskRegistries(): Promise<void> {
    const byRepo = new Map<string, WorktreeRecord[]>()
    for (const record of this.records.values()) {
      const list = byRepo.get(record.repoRoot)
      if (list === undefined) byRepo.set(record.repoRoot, [record])
      else list.push(record)
    }
    for (const [repoRoot, records] of byRepo) {
      const file = joinPathLike(repoRoot, '.git', DISK_REGISTRY_FILE)
      await mkdir(dirnameLike(repoRoot, file), { recursive: true }).catch(() => undefined)
      await writeFile(file, JSON.stringify(records, null, 2)).catch(() => undefined)
    }
  }
}
