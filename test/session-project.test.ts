import { describe, expect, it } from 'vitest'
import { sessionProjectFolder } from '../src/domain/session-project.js'
import type { SessionLocationView } from '../src/domain/session-management.js'

const folder = (cwd: string): SessionLocationView => ({ cwd, kind: 'directory', projectPath: '/repo', repositoryId: '/repo/.git', exists: true })

describe('folder is project', () => {
  it('groups different clients by their canonical original folder', () => {
    expect(sessionProjectFolder('/alias/plugin', folder('/repo/plugin'))).toBe('/repo/plugin')
    expect(sessionProjectFolder('/repo/plugin', folder('/repo/plugin'))).toBe('/repo/plugin')
  })
  it('keeps two folders in the same repository as distinct projects', () => {
    expect(sessionProjectFolder('/repo/appA', folder('/repo/appA'))).toBe('/repo/appA')
    expect(sessionProjectFolder('/repo/appB', folder('/repo/appB'))).toBe('/repo/appB')
  })
  it('does not collapse unowned linked checkouts merely because they share Git objects', () => {
    expect(sessionProjectFolder('/checkout', { ...folder('/checkout'), kind: 'worktree' })).toBe('/checkout')
  })
  it('maps only known legacy extension worktrees back to their recorded project', () => {
    const legacy = { worktreePath: '/repo/.dsh-worktrees/s1', repoRoot: '/repo' }
    expect(sessionProjectFolder(legacy.worktreePath, folder(legacy.worktreePath), legacy, folder('/repo'))).toBe('/repo')
    expect(sessionProjectFolder('/repo/appA', folder('/repo/appA'), legacy)).toBe('/repo/appA')
  })
})
