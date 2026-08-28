import { describe, expect, it } from 'vitest'
import type { Memento } from 'vscode'
import type { ExecResult, GitRunner } from '../src/editor/worktree-service.js'
import { WorktreeService } from '../src/editor/worktree-service.js'

function memStore(): { state: Map<string, unknown>; memento: Memento } {
  const state = new Map<string, unknown>()
  const memento = {
    get: (key: string) => state.get(key),
    update: async (key: string, value: unknown) => { state.set(key, value) },
  } as unknown as Memento
  return { state, memento }
}

function ok(stdout: string, stderr = ''): Promise<ExecResult> {
  return Promise.resolve({ stdout, stderr })
}

/** A git runner that reports a repo at /repo on branch main and records calls. */
function repoRunner(calls: string[][] = []): GitRunner {
  return (_cwd, args) => {
    calls.push([...args])
    if (args.includes('--show-toplevel')) return ok('/repo\n')
    if (args.includes('--abbrev-ref')) return ok('main\n')
    return ok('')
  }
}

describe('WorktreeService.prepare', () => {
  it('isolates a git workspace into a dsh worktree and returns its path as cwd', async () => {
    const { memento } = memStore()
    const calls: Array<{ cwd: string; args: string[] }> = []
    const run: GitRunner = (cwd, args) => {
      calls.push({ cwd, args: [...args] })
      if (args.includes('--show-toplevel')) return ok('/repo\n')
      if (args.includes('--abbrev-ref')) return ok('main\n')
      if (args.includes('worktree') && args.includes('add')) return ok('')
      return ok('')
    }
    const service = new WorktreeService(memento, run)

    const prepared = await service.prepare('abc123', '/repo')

    expect(prepared.isolated).toBe(true)
    expect(prepared.cwd).toBe('/repo/.dsh-worktrees/abc123')
    expect(prepared.record).toMatchObject({ sessionId: 'abc123', repoRoot: '/repo', baseBranch: 'main', branch: 'dsh/abc123' })
    expect(calls).toContainEqual({ cwd: '/repo', args: ['worktree', 'add', '/repo/.dsh-worktrees/abc123', '-b', 'dsh/abc123'] })
  })

  it('falls back to the shared cwd outside a git repo', async () => {
    const { memento } = memStore()
    const run: GitRunner = () => Promise.reject(new Error('not a git repository'))
    const service = new WorktreeService(memento, run)

    const prepared = await service.prepare('abc123', '/plain')

    expect(prepared.isolated).toBe(false)
    expect(prepared.cwd).toBe('/plain')
    expect(prepared.reason).toBe('no-git-repo')
  })

  it('falls back when the worktree add fails', async () => {
    const { memento } = memStore()
    const run: GitRunner = (_cwd, args) => {
      if (args.includes('--show-toplevel')) return ok('/repo\n')
      if (args.includes('--abbrev-ref')) return ok('main\n')
      if (args.includes('worktree') && args.includes('add')) return Promise.reject(new Error('branch exists'))
      return ok('')
    }
    const service = new WorktreeService(memento, run)

    const prepared = await service.prepare('abc123', '/repo')

    expect(prepared.isolated).toBe(false)
    expect(prepared.cwd).toBe('/repo')
    expect(prepared.reason).toBe('worktree-add-failed')
  })

  it('falls back on a detached HEAD (no branch to split from)', async () => {
    const { memento } = memStore()
    const run: GitRunner = (_cwd, args) => {
      if (args.includes('--show-toplevel')) return ok('/repo\n')
      if (args.includes('--abbrev-ref')) return ok('HEAD\n')
      return ok('')
    }
    const service = new WorktreeService(memento, run)

    const prepared = await service.prepare('abc123', '/repo')

    expect(prepared.isolated).toBe(false)
    expect(prepared.reason).toBe('detached-head')
  })
})

describe('WorktreeService.diffText / merge / discard', () => {
  it('returns undefined diff for a session without a worktree', async () => {
    const { memento } = memStore()
    const service = new WorktreeService(memento, () => ok(''))
    expect(await service.diffText('missing')).toBeUndefined()
  })

  it('merges the session branch back and moves the base branch', async () => {
    const { memento } = memStore()
    const calls: string[][] = []
    const mergeRun: GitRunner = (_cwd, args) => {
      calls.push([...args])
      if (args.includes('--show-toplevel')) return ok('/repo\n')
      if (args.includes('--abbrev-ref')) return ok('main\n')
      if (args[0] === 'rev-parse' && typeof args[1] === 'string' && args[1].startsWith('refs/heads/')) {
        return ok(args[1] === 'refs/heads/main' ? 'base1\n' : 'sess1\n')
      }
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok('m1\n')
      return ok('')
    }
    const merging = new WorktreeService(memento, mergeRun)
    await merging.prepare('abc123', '/repo')

    const outcome = await merging.mergeBack('abc123')

    expect(outcome).toEqual({ ok: true, message: 'merged' })
    expect(calls).toContainEqual(['worktree', 'add', '--detach', '/repo/.dsh-worktrees/.merge-abc123', 'main'])
    expect(calls).toContainEqual(['merge', '--no-ff', '-m', 'Merge session abc123', 'dsh/abc123'])
    expect(calls).toContainEqual(['update-ref', 'refs/heads/main', 'm1'])
  })

  it('merges uncommitted worktree output even when the session never committed', async () => {
    const { memento } = memStore()
    const calls: string[][] = []
    const run: GitRunner = (_cwd, args) => {
      calls.push([...args])
      if (args.includes('--show-toplevel')) return ok('/repo\n')
      if (args.includes('--abbrev-ref')) return ok('main\n')
      // Branch and base point at the same commit: the session has no commits
      // (the sandbox keeps agent git writes out of the shared .git dir).
      if (args[0] === 'rev-parse' && typeof args[1] === 'string' && args[1].startsWith('refs/heads/')) return ok('same1\n')
      if (args[0] === 'diff' && args[1] === 'HEAD') return ok('diff --git a/app.ts b/app.ts\n')
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok('m1\n')
      return ok('')
    }
    const service = new WorktreeService(memento, run)
    await service.prepare('abc123', '/repo')

    const outcome = await service.mergeBack('abc123')

    expect(outcome).toEqual({ ok: true, message: 'merged' })
    expect(calls).not.toContainEqual(['merge', '--no-ff', '-m', 'Merge session abc123', 'dsh/abc123'])
    expect(calls.some((entry) => entry[0] === 'apply' && entry[1] === '--whitespace=nowarn')).toBe(true)
    expect(calls).toContainEqual(['add', '-A'])
    expect(calls).toContainEqual(['-c', 'user.name=DSH Session Merge', '-c', 'user.email=dsh-session@localhost', 'commit', '-m', 'Session abc123 worktree changes'])
    expect(calls).toContainEqual(['update-ref', 'refs/heads/main', 'm1'])
  })

  it('reports no-changes when the worktree is identical to the base', async () => {
    const { memento } = memStore()
    const calls: string[][] = []
    const run: GitRunner = (_cwd, args) => {
      calls.push([...args])
      if (args.includes('--show-toplevel')) return ok('/repo\n')
      if (args.includes('--abbrev-ref')) return ok('main\n')
      if (args[0] === 'rev-parse') return ok('same1\n')
      if (args[0] === 'diff') return ok('')
      return ok('')
    }
    const service = new WorktreeService(memento, run)
    await service.prepare('abc123', '/repo')

    const outcome = await service.mergeBack('abc123')

    expect(outcome).toEqual({ ok: true, message: 'no-changes' })
    expect(calls).not.toContainEqual(['update-ref', 'refs/heads/main', 'same1'])
  })

  it('reports a merge conflict and cleans the temp worktree', async () => {
    const { memento } = memStore()
    const calls: string[][] = []
    const run: GitRunner = (_cwd, args) => {
      calls.push([...args])
      if (args.includes('--show-toplevel')) return ok('/repo\n')
      if (args.includes('--abbrev-ref')) return ok('main\n')
      if (args[0] === 'rev-parse' && typeof args[1] === 'string' && args[1].startsWith('refs/heads/')) {
        return ok(args[1] === 'refs/heads/main' ? 'base1\n' : 'sess1\n')
      }
      if (args[0] === 'merge') return Promise.reject(new Error('conflict'))
      return ok('')
    }
    const service = new WorktreeService(memento, run)
    await service.prepare('abc123', '/repo')

    const outcome = await service.mergeBack('abc123')

    expect(outcome.ok).toBe(false)
    expect(outcome.message).toBe('merge-conflict')
    expect(calls).toContainEqual(['worktree', 'remove', '--force', '/repo/.dsh-worktrees/.merge-abc123'])
  })

  it('diffText compares the base commit to the working tree, not the branch tip', async () => {
    const { memento } = memStore()
    const calls: string[][] = []
    const run: GitRunner = (_cwd, args) => {
      calls.push([...args])
      if (args.includes('--show-toplevel')) return ok('/repo\n')
      if (args.includes('--abbrev-ref')) return ok('main\n')
      if (args[0] === 'diff' && args[1] === 'main') return ok('diff --git a/x b/x\n')
      return ok('')
    }
    const service = new WorktreeService(memento, run)
    await service.prepare('abc123', '/repo')

    const diff = await service.diffText('abc123')

    expect(diff).toBe('diff --git a/x b/x\n')
    // The diff runs inside the session worktree (its working tree is the
    // source of truth) and untracked files are marked intent-to-add first.
    expect(calls).toContainEqual(['add', '-N', '.'])
    expect(calls).toContainEqual(['diff', 'main'])
    expect(calls.some((entry) => entry[0] === 'diff' && entry[1]?.includes('...'))).toBe(false)
  })

  it('discard removes the worktree, the branch, and the registry entry', async () => {
    const { memento } = memStore()
    const calls: string[][] = []
    const run = repoRunner(calls)
    const service = new WorktreeService(memento, run)
    await service.prepare('abc123', '/repo')

    const outcome = await service.discard('abc123')

    expect(outcome).toEqual({ ok: true, message: 'discarded' })
    expect(calls).toContainEqual(['worktree', 'remove', '--force', '/repo/.dsh-worktrees/abc123'])
    expect(calls).toContainEqual(['branch', '-D', 'dsh/abc123'])
    expect(service.recordFor('abc123')).toBeUndefined()
    // Discard removes the editable worktree, but the session remains scoped to
    // the original project so its history can still be listed.
    expect(service.displayCwd('abc123', '/repo/.dsh-worktrees/abc123')).toBe('/repo')
    const reloaded = new WorktreeService(memento, run)
    expect(reloaded.displayCwd('abc123', '/repo/.dsh-worktrees/abc123')).toBe('/repo')
  })
})

describe('WorktreeService.cleanupOrphans', () => {
  it('removes worktrees whose session no longer exists and keeps live ones', async () => {
    const { memento } = memStore()
    const calls: string[][] = []
    const run = repoRunner(calls)
    const service = new WorktreeService(memento, run)
    await service.prepare('gone', '/repo')
    await service.prepare('live', '/repo')

    const removed = await service.cleanupOrphans(new Set(['live']))

    expect(removed).toEqual(['gone'])
    expect(service.recordFor('gone')).toBeUndefined()
    expect(service.recordFor('live')).toBeDefined()
    expect(calls).toContainEqual(['worktree', 'remove', '--force', '/repo/.dsh-worktrees/gone'])
    expect(calls).not.toContainEqual(['worktree', 'remove', '--force', '/repo/.dsh-worktrees/live'])
  })
})

describe('WorktreeService persistence', () => {
  it('reloads the registry from storage on construction', async () => {
    const { memento } = memStore()
    const service = new WorktreeService(memento, repoRunner())
    await service.prepare('abc123', '/repo')

    const reloaded = new WorktreeService(memento, repoRunner())
    const record = reloaded.recordFor('abc123')
    expect(record).toBeDefined()
    expect(record?.worktreePath).toBe('/repo/.dsh-worktrees/abc123')
    expect(reloaded.displayCwd('abc123', '/fallback')).toBe('/repo')
  })

  it('scoping helpers: displayCwd maps the worktree back to the repo root', async () => {
    const { memento } = memStore()
    const service = new WorktreeService(memento, repoRunner())
    await service.prepare('abc123', '/repo')
    expect(service.displayCwd('abc123', '/repo')).toBe('/repo')
    expect(service.displayCwd('other', '/fallback')).toBe('/fallback')
  })
})
