import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  appendFile: vi.fn(),
}))

import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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

const ok = (stdout = ''): Promise<ExecResult> => Promise.resolve({ stdout, stderr: '' })

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const REGISTRY_JSON = JSON.stringify([
  {
    sessionId: 'abc123',
    repoRoot: '/repo',
    baseBranch: 'main',
    branch: 'dsh/abc123',
    worktreePath: '/repo/.dsh-worktrees/abc123',
    createdAt: 1234,
  },
])

/** Makes readFile answer the mirror and the worktree .git pointer. */
function mockDiskWithMirror(): void {
  vi.mocked(readFile).mockImplementation(async (target) => {
    const p = String(target)
    if (p.endsWith('/.git/dsh-worktrees.json')) return REGISTRY_JSON
    if (p.endsWith('/.dsh-worktrees/abc123/.git')) return 'gitdir: /repo/.git/worktrees/abc123\n'
    throw new Error(`unexpected readFile: ${p}`)
  })
  vi.mocked(readdir).mockResolvedValue([])
  vi.mocked(stat).mockResolvedValue({} as never)
}

function lastWrittenRegistry(): string {
  const calls = vi.mocked(writeFile).mock.calls
  const data = calls[calls.length - 1]?.[1]
  if (typeof data !== 'string') throw new Error('expected a string disk-registry payload')
  return data
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(mkdir).mockResolvedValue(undefined)
  vi.mocked(writeFile).mockResolvedValue(undefined)
  vi.mocked(rm).mockResolvedValue(undefined)
  vi.mocked(appendFile).mockResolvedValue(undefined)
})

describe('WorktreeService.recover (Memento reset self-healing)', () => {
  it('restores records from the .git disk mirror after a Memento reset', async () => {
    const { memento } = memStore() // empty — simulates state.vscdb cleared
    mockDiskWithMirror()
    const run: GitRunner = () => ok()
    const service = new WorktreeService(memento, run)

    const restored = await service.recover(['/repo'])

    expect(restored).toHaveLength(1)
    expect(service.recordFor('abc123')).toMatchObject({
      sessionId: 'abc123',
      repoRoot: '/repo',
      baseBranch: 'main',
      branch: 'dsh/abc123',
      worktreePath: '/repo/.dsh-worktrees/abc123',
    })
    // Re-saved into the Memento and mirrored back to disk.
    expect(memento.get('dsh.worktrees.v1')).toHaveLength(1)
    await flush()
    expect(writeFile).toHaveBeenCalledWith('/repo/.git/dsh-worktrees.json', expect.any(String))
  })

  it('restores a discarded session root from disk after the Memento is reset', async () => {
    const { memento } = memStore()
    mockDiskWithMirror()
    const service = new WorktreeService(memento, () => ok())
    await service.recover(['/repo'])

    await service.discard('abc123')

    expect(service.recordFor('abc123')).toBeUndefined()
    expect(service.displayCwd('abc123', '/repo/.dsh-worktrees/abc123')).toBe('/repo')
    expect(memento.get<Record<string, string>>('dsh.worktree-session-roots.v1')).toEqual({ abc123: '/repo' })

    await flush()
    const rootOnlyMirror = lastWrittenRegistry()
    expect(JSON.parse(rootOnlyMirror)).toMatchObject({
      version: 2,
      records: [],
      sessionRoots: { abc123: '/repo' },
    })

    // Simulate VS Code rebuilding state.vscdb: the new service receives an
    // empty Memento and can only recover the discarded session from disk.
    const reset = memStore()
    vi.mocked(readFile).mockImplementation(async (target) => {
      if (String(target).endsWith('/.git/dsh-worktrees.json')) return rootOnlyMirror
      throw new Error('worktree was discarded')
    })
    vi.mocked(readdir).mockResolvedValue([])
    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'))
    const reloaded = new WorktreeService(reset.memento, () => ok())

    const restored = await reloaded.recover(['/repo'])

    expect(restored).toHaveLength(0)
    expect(reloaded.recordFor('abc123')).toBeUndefined()
    expect(reloaded.displayCwd('abc123', '/repo/.dsh-worktrees/abc123')).toBe('/repo')
    expect(reset.memento.get<Record<string, string>>('dsh.worktree-session-roots.v1')).toEqual({ abc123: '/repo' })
  })

  it('clears the root-only disk mapping when a failed session is forgotten', async () => {
    const { state, memento } = memStore()
    state.set('dsh.worktree-session-roots.v1', { abc123: '/repo' })
    const service = new WorktreeService(memento, () => ok())

    await service.forgetSession('abc123')

    expect(JSON.parse(lastWrittenRegistry())).toMatchObject({
      version: 2,
      records: [],
      sessionRoots: {},
    })
  })

  it('clears root-only disk mappings during orphan cleanup', async () => {
    const { state, memento } = memStore()
    state.set('dsh.worktree-session-roots.v1', { abc123: '/repo' })
    const service = new WorktreeService(memento, () => ok())

    await service.cleanupOrphans(new Set())
    await flush()

    expect(service.displayCwd('abc123', '/fallback')).toBe('/fallback')
    expect(JSON.parse(lastWrittenRegistry())).toMatchObject({
      version: 2,
      records: [],
      sessionRoots: {},
    })
  })

  it('rebuilds records by scanning the isolation directory when the mirror is gone', async () => {
    const { memento } = memStore()
    vi.mocked(readFile).mockImplementation(async (target) => {
      if (String(target).endsWith('/.dsh-worktrees/abc123/.git')) return 'gitdir: /repo/.git/worktrees/abc123\n'
      throw new Error('mirror missing')
    })
    vi.mocked(readdir).mockResolvedValue([{ name: 'abc123', isDirectory: () => true }] as never)
    vi.mocked(stat).mockResolvedValue({} as never)
    const run: GitRunner = (_cwd, args) => (args.includes('symbolic-ref') ? ok('origin/main\n') : ok())
    const service = new WorktreeService(memento, run)

    const restored = await service.recover(['/repo'])

    expect(restored).toHaveLength(1)
    expect(service.recordFor('abc123')).toMatchObject({
      sessionId: 'abc123',
      baseBranch: 'main',
      branch: 'dsh/abc123',
      worktreePath: '/repo/.dsh-worktrees/abc123',
    })
  })

  it('ignores merge scratch and non-worktree directories during the scan', async () => {
    const { memento } = memStore()
    vi.mocked(readFile).mockImplementation(async (target) => {
      if (String(target).endsWith('/.dsh-worktrees/abc123/.git')) return 'gitdir: /repo/.git/worktrees/abc123\n'
      throw new Error('not a worktree')
    })
    vi.mocked(readdir).mockResolvedValue([
      { name: '.merge-abc123', isDirectory: () => true },
      { name: 'random-dir', isDirectory: () => true },
    ] as never)
    const run: GitRunner = () => ok()
    const service = new WorktreeService(memento, run)

    const restored = await service.recover(['/repo'])

    expect(restored).toHaveLength(0)
    expect(service.recordFor('.merge-abc123')).toBeUndefined()
    expect(service.recordFor('random-dir')).toBeUndefined()
  })

  it('keeps the in-memory record over a disk mirror (does not overwrite)', async () => {
    const { state, memento } = memStore()
    state.set('dsh.worktrees.v1', [
      {
        sessionId: 'abc123',
        repoRoot: '/repo',
        baseBranch: 'develop',
        branch: 'dsh/abc123',
        worktreePath: '/repo/.dsh-worktrees/abc123',
        createdAt: 999,
      },
    ])
    mockDiskWithMirror()
    const service = new WorktreeService(memento, () => ok())

    const restored = await service.recover(['/repo'])

    expect(restored).toHaveLength(0)
    expect(service.recordFor('abc123')?.baseBranch).toBe('develop')
  })

  it('migrates a legacy root without restoring its missing worktree record', async () => {
    const { memento } = memStore()
    vi.mocked(readFile).mockImplementation(async (target) => {
      if (String(target).endsWith('/.git/dsh-worktrees.json')) return REGISTRY_JSON
      throw new Error('missing')
    })
    vi.mocked(readdir).mockResolvedValue([])
    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'))
    const service = new WorktreeService(memento, () => ok())

    const restored = await service.recover(['/repo'])

    expect(restored).toHaveLength(0)
    expect(service.recordFor('abc123')).toBeUndefined()
    expect(service.displayCwd('abc123', '/repo/.dsh-worktrees/abc123')).toBe('/repo')
    expect(memento.get<Record<string, string>>('dsh.worktree-session-roots.v1')).toEqual({ abc123: '/repo' })
  })
})
