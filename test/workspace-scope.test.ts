import { describe, expect, it } from 'vitest'

import { normalizeWorkspacePath, projectRootOf, sameProjectPath, sameWorkspacePath } from '../src/domain/workspace-scope.js'

describe('workspace-scope', () => {
  describe('normalizeWorkspacePath', () => {
    it('strips trailing path separators', () => {
      expect(normalizeWorkspacePath('/Users/me/project/')).toBe('/Users/me/project')
      expect(normalizeWorkspacePath('C:\\Users\\me\\project\\')).toBe('C:\\Users\\me\\project')
    })

    it('leaves a bare root separator in place', () => {
      expect(normalizeWorkspacePath('/')).toBe('')
    })
  })

  describe('sameWorkspacePath', () => {
    it('matches the same folder', () => {
      expect(sameWorkspacePath('/Users/me/project', '/Users/me/project')).toBe(true)
    })
    it('tolerates a trailing separator on either side', () => {
      expect(sameWorkspacePath('/Users/me/project/', '/Users/me/project')).toBe(true)
      expect(sameWorkspacePath('/Users/me/project', '/Users/me/project/')).toBe(true)
    })

    it('rejects a different folder', () => {
      expect(sameWorkspacePath('/Users/me/project-a', '/Users/me/project-b')).toBe(false)
      expect(sameWorkspacePath('/Users/me/project', '/Users/me/project-sub')).toBe(false)
    })

    it('hides every session when no workspace folder is open', () => {
      expect(sameWorkspacePath('/Users/me/project', undefined)).toBe(false)
      expect(sameWorkspacePath(undefined, undefined)).toBe(false)
    })

    it('hides a session with no recorded cwd', () => {
      expect(sameWorkspacePath(undefined, '/Users/me/project')).toBe(false)
    })

    it.runIf(process.platform === 'win32')(
      'matches the same Windows folder across git and fsPath spellings',
      () => {
        // git reports repo roots with forward slashes (isolated sessions map
        // back to the repo root); uri.fsPath spells the open folder with
        // backslashes. They name the same directory and must match.
        expect(sameWorkspacePath('E:/vscodeextension/deepseek-harness-for-vscode', 'e:\\vscodeextension\\deepseek-harness-for-vscode')).toBe(true)
        expect(sameWorkspacePath('E:/react/newssystem', 'e:\\react\\newssystem')).toBe(true)
      },
    )

    it.runIf(process.platform === 'win32')(
      'rejects a different Windows folder regardless of separator spelling',
      () => {
        expect(sameWorkspacePath('E:/vscodeextension/project-a', 'e:\\vscodeextension\\project-b')).toBe(false)
        expect(sameWorkspacePath('E:/vscodeextension', 'e:\\vscodeextension\\deepseek-harness-for-vscode')).toBe(false)
      },
    )
  })

  describe('projectRootOf', () => {
    it('keeps a project folder unchanged', () => {
      expect(projectRootOf('/Users/me/project')).toBe('/Users/me/project')
      expect(projectRootOf('C:\\Users\\me\\project')).toBe('C:\\Users\\me\\project')
    })

    it('maps a worktree session to its repository root', () => {
      expect(projectRootOf('/Users/me/project/.dsh-worktrees/session-1')).toBe('/Users/me/project')
      expect(projectRootOf('C:\\Users\\me\\project\\.dsh-worktrees\\session-1')).toBe('C:/Users/me/project')
    })

    it('handles a missing cwd', () => {
      expect(projectRootOf(undefined)).toBeUndefined()
    })
  })

  describe('sameProjectPath', () => {
    it('groups worktree sessions under the repository project', () => {
      expect(sameProjectPath('/Users/me/project/.dsh-worktrees/session-1', '/Users/me/project')).toBe(true)
      expect(sameProjectPath('/Users/me/project', '/Users/me/project/.dsh-worktrees/session-1')).toBe(true)
    })

    it('still rejects a different project', () => {
      expect(sameProjectPath('/Users/me/project/.dsh-worktrees/session-1', '/Users/me/other')).toBe(false)
      expect(sameProjectPath('/Users/me/project-a/.dsh-worktrees/session-1', '/Users/me/project-b')).toBe(false)
    })

    it('hides sessions when no project is open', () => {
      expect(sameProjectPath('/Users/me/project', undefined)).toBe(false)
      expect(sameProjectPath(undefined, undefined)).toBe(false)
    })
  })
})
