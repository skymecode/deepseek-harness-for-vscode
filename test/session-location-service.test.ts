import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { inspectSessionLocation, SessionLocationService } from '../src/editor/session-location-service.js'

const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', ['-C', cwd, ...args], { windowsHide: true })

describe('session directories from filesystem facts', () => {
  it('recognizes official and arbitrarily located worktrees without adopting their ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-location-'))
    const repo = join(root, 'project'), linked = join(root, 'external checkout')
    await mkdir(repo)
    try {
      await git(repo, 'init')
      await writeFile(join(repo, 'a'), 'fixture')
      await git(repo, 'add', 'a')
      await git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture')
      await git(repo, 'worktree', 'add', linked, '-b', 'official-task')
      const main = await inspectSessionLocation(repo)
      const worktree = await inspectSessionLocation(linked)
      expect(main.kind).toBe('directory')
      expect(worktree).toMatchObject({ kind: 'worktree', exists: true, branch: 'official-task', projectPath: main.projectPath })
      expect(worktree.repositoryId).toBe(main.repositoryId)
      const missing = await inspectSessionLocation(join(root, 'missing'))
      expect(missing).toMatchObject({ kind: 'missing', exists: false })
      const plain = join(root, '.dsh-worktrees', 'not-a-worktree')
      await mkdir(plain, { recursive: true })
      expect((await inspectSessionLocation(plain)).kind).toBe('directory')
      expect((await inspectSessionLocation(plain)).repositoryId).toBeUndefined()
      vi.stubEnv('GIT_DIR', join(repo, '.git'))
      vi.stubEnv('GIT_WORK_TREE', repo)
      try {
        expect((await inspectSessionLocation(plain)).repositoryId).toBeUndefined()
        expect((await inspectSessionLocation(plain)).repositoryId).toBeUndefined()
      } finally { vi.unstubAllEnvs() }
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('deduplicates directory checks and limits concurrent Git probes', async () => {
    let running = 0, peak = 0, calls = 0
    const service = new SessionLocationService(() => {}, async cwd => {
      calls++; running++; peak = Math.max(peak, running)
      await new Promise(done => setTimeout(done, 5))
      running--
      return { cwd, kind: 'directory', exists: true }
    })
    await Promise.all(Array.from({ length: 30 }, (_, i) => service.refresh(`/path/${i % 10}`)))
    expect(calls).toBe(10)
    expect(peak).toBeLessThanOrEqual(4)
    service.dispose()
  })
})
