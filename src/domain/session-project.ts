import type { SessionLocationView } from './session-management.js'
import { sameWorkspacePath } from './workspace-scope.js'

/** Project identity comes from the original folder, never the mutable execution cwd or Git root. */
export function sessionProjectFolder(
  originalCwd: string | undefined,
  originalLocation: SessionLocationView | undefined,
  legacy?: { readonly worktreePath: string; readonly repoRoot: string },
  legacyProjectLocation?: SessionLocationView,
): string | undefined {
  // Compatibility for the extension's old per-session checkout records only.
  if (legacy && sameWorkspacePath(originalCwd, legacy.worktreePath)) return legacyProjectLocation?.cwd ?? legacy.repoRoot
  return originalLocation?.cwd ?? originalCwd
}
