import { mkdtemp, appendFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WorktreeService } from '../src/editor/worktree-service.js'

/**
 * End-to-end test against a real git repository (requires `git` on PATH).
 * Creates a throwaway repo under the OS temp dir and cleans it up after.
 */

let repo = ''
let realRepo = ''
let service: WorktreeService

function git(cwd: string, args: string[]): { stdout: string; stderr: string } {
  try {
    // Keep expected probes of non-git folders quiet; the test converts the
    // captured stderr into a structured assertion when needed.
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { stdout, stderr: '' }
  } catch (cause: unknown) {
    const err = cause as { stderr?: string; message?: string }
    throw new Error(err?.stderr?.trim() || err?.message || String(cause))
  }
}

function run(cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return Promise.resolve().then(() => git(cwd, [...args]))
}

function memento() {
  const state = new Map<string, unknown>()
  return { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => { state.set(k, v) } } as never
}

beforeAll(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), 'dsh-wt-e2e-'))
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'e2e@test'])
  git(repo, ['config', 'user.name', 'E2E'])
  await appendFile(path.join(repo, 'readme.md'), 'hello\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-qm', 'init'])
  realRepo = git(repo, ['rev-parse', '--show-toplevel']).stdout.trim()
  service = new WorktreeService(memento(), run)
})

afterAll(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('WorktreeService against a real repository', () => {
  it('isolates a session, diffs it, merges it back, then discards cleanly', async () => {
    const sid = 'e2e-1'
    const prepared = await service.prepare(sid, realRepo)
    expect(prepared.isolated, JSON.stringify(prepared)).toBe(true)
    expect(prepared.cwd).toBe(`${realRepo}/.dsh-worktrees/${sid}`)

    // The worktree is a real checkout on its own branch.
    const branch = git(prepared.cwd, ['branch', '--show-current']).stdout.trim()
    expect(branch).toBe(`dsh/${sid}`)
    // The main checkout is untouched by the existence of the worktree.
    expect(git(realRepo, ['status', '--porcelain']).stdout).toBe('')

    // Session edits the worktree copy.
    await appendFile(path.join(prepared.cwd, 'readme.md'), 'changed by session\n')
    git(prepared.cwd, ['add', '.'])
    git(prepared.cwd, ['-c', 'user.email=e2e@test', '-c', 'user.name=E2E', 'commit', '-qm', 'session work'])

    // Isolation: main checkout still shows the original file.
    expect(git(realRepo, ['show', 'HEAD:readme.md']).stdout).toBe('hello\n')
    expect(git(realRepo, ['status', '--porcelain']).stdout).toBe('')

    // Diff surfaces the session change.
    const diff = await service.diffText(sid)
    expect(diff).toContain('changed by session')

    // Merge back lands on main without touching the main working tree.
    const merge = await service.mergeBack(sid)
    expect(merge.ok, merge.message).toBe(true)
    expect(git(realRepo, ['show', 'main:readme.md']).stdout).toContain('changed by session')
    expect(git(realRepo, ['status', '--porcelain']).stdout).toBe('')

    // Discard removes the worktree and branch.
    const discard = await service.discard(sid)
    expect(discard.ok, discard.message).toBe(true)
    const branches = git(realRepo, ['branch']).stdout
    expect(branches).not.toContain(`dsh/${sid}`)
  }, 60_000)

  it('diffs and merges purely uncommitted session work (no commits, sandbox reality)', async () => {
    const sid = 'e2e-uncommitted'
    const prepared = await service.prepare(sid, realRepo)
    expect(prepared.isolated, JSON.stringify(prepared)).toBe(true)

    // The session edits an existing file and creates a new one — no git
    // commands at all. This is what a sandboxed session actually produces:
    // the seatbelt profile denies agent writes to the shared .git dir, so
    // `git add`/`git commit` inside the worktree cannot succeed.
    await appendFile(path.join(prepared.cwd, 'readme.md'), 'uncommitted session line\n')
    await appendFile(path.join(prepared.cwd, 'notes.md'), 'brand new file\n')

    // Review diff must show BOTH the edit and the untracked new file.
    const diff = await service.diffText(sid)
    expect(diff).toContain('uncommitted session line')
    expect(diff).toContain('brand new file')
    // A commit-based branch diff would be empty here; assert the new
    // working-tree diff is what we got.
    expect(diff).not.toBe('')

    // Merge back lands the uncommitted work on main.
    const merge = await service.mergeBack(sid)
    expect(merge.ok, merge.message).toBe(true)
    expect(merge.message).toBe('merged')
    expect(git(realRepo, ['show', 'main:readme.md']).stdout).toContain('uncommitted session line')
    expect(git(realRepo, ['show', 'main:notes.md']).stdout).toContain('brand new file')
    // And a clean main worktree reflects it on disk.
    expect(git(realRepo, ['status', '--porcelain']).stdout).toBe('')

    // A second merge with nothing left reports no-changes instead of lying.
    // (The worktree was already merged; the branch still has no new commits
    // and the working tree still differs — so discard it instead.)
    const discard = await service.discard(sid)
    expect(discard.ok, discard.message).toBe(true)
  }, 60_000)

  it('reports no-changes when the session produced nothing', async () => {
    const sid = 'e2e-empty'
    const prepared = await service.prepare(sid, realRepo)
    expect(prepared.isolated, JSON.stringify(prepared)).toBe(true)

    const diff = await service.diffText(sid)
    expect(diff?.trim()).toBe('')
    const merge = await service.mergeBack(sid)
    expect(merge).toEqual({ ok: true, message: 'no-changes' })
    // Main is untouched.
    expect(git(realRepo, ['rev-parse', 'main']).stdout).toBe(git(realRepo, ['rev-parse', 'HEAD']).stdout)
    await service.discard(sid)
  }, 60_000)

  it('falls back when the workspace is not a git repository', async () => {
    const plain = await mkdtemp(path.join(os.tmpdir(), 'dsh-wt-plain-'))
    try {
      const prepared = await service.prepare('e2e-plain', plain)
      expect(prepared.isolated).toBe(false)
      expect(prepared.reason).toBe('no-git-repo')
      expect(prepared.cwd).toBe(plain)
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })
})
