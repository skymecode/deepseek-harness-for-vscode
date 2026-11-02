/**
 * Per-project session history scoping.
 *
 * Sessions record the workspace folder they were created in (`cwd`); the
 * history panel shows only the sessions that belong to the project currently
 * open in the window. Nothing is deleted — switching projects just filters the
 * view, and switching back restores the other project's sessions.
 */

/** Strips trailing separators without changing the path's spelling. */
export function normalizeWorkspacePath(value: string): string {
  const trimmed = value.replace(/[\\/]+$/u, '')
  return trimmed
}

/**
 * The project root a session cwd belongs to. Isolated sessions live under
 * `<repo>/.dsh-worktrees/<sessionId>`; grouping them by that parent keeps a
 * worktree session visible from the repository window even when the local
 * worktree registry was rebuilt, or the session was created by another DSH
 * backend that this extension never recorded.
 */
export function projectRootOf(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  const normalized = cwd.replaceAll('\\', '/')
  const segments = normalized.split('/')
  const index = segments.lastIndexOf('.dsh-worktrees')
  if (index <= 0) return cwd
  return segments.slice(0, index).join('/')
}

/**
 * Whether a session's recorded cwd belongs to the workspace currently open in
 * this window. Worktree sessions are mapped to their repository root first.
 * Both sides must exist and match exactly: with no project open nothing is
 * listed (there is no project to scope by), and sessions created with no
 * project open fall back to the Host working directory, so they never equal a
 * real project folder and stay hidden everywhere.
 *
 * On Windows the two sides come from different sources and spell the same
 * directory differently: session cwds are recorded by git (forward slashes,
 * e.g. `E:/project`, and an isolated session is mapped back to its repo root)
 * while the open workspace folder comes from `uri.fsPath` (backslashes, e.g.
 * `e:\project`). Comparison must therefore be case-insensitive *and*
 * separator-normalized, or every worktree-isolated session is filtered out of
 * the history list ("the current project has no sessions yet").
 */
export function sameProjectPath(sessionCwd: string | undefined, workspaceCwd: string | undefined): boolean {
  return sameWorkspacePath(projectRootOf(sessionCwd), projectRootOf(workspaceCwd))
}

/**
 * Whether a session's recorded cwd exactly matches the workspace currently
 * open in this window. Kept for callers that must distinguish "inside this
 * project" from "this exact folder" (for example opening a worktree session
 * in its own window).
 */
export function sameWorkspacePath(sessionCwd: string | undefined, workspaceCwd: string | undefined): boolean {
  if (sessionCwd === undefined || workspaceCwd === undefined) return false
  const left = normalizeWorkspacePath(sessionCwd)
  const right = normalizeWorkspacePath(workspaceCwd)
  const windowsPath = /^[A-Za-z]:[\\/]/u.test(left)
    || /^[A-Za-z]:[\\/]/u.test(right)
    || left.includes('\\')
    || right.includes('\\')
  return process.platform === 'win32' && windowsPath
    ? left.replaceAll('/', '\\').toLowerCase() === right.replaceAll('/', '\\').toLowerCase()
    : left === right
}
