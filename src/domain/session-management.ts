/** Facts about a directory, independent of which client created its session. */
export interface SessionLocationView {
  readonly cwd: string
  readonly kind: 'directory' | 'worktree' | 'missing' | 'unknown'
  readonly exists?: boolean
  readonly projectPath?: string
  readonly repositoryId?: string
  readonly branch?: string
}

export type SessionExecutionStatus = 'preview' | 'ready' | 'resuming' | 'occupied' | 'unavailable'

export interface SessionManagementView {
  readonly status: SessionExecutionStatus
  readonly location?: SessionLocationView
  readonly projectCurrent: boolean
  readonly managedWorktree: boolean
  readonly archived: boolean
  readonly canResume: boolean
  readonly editorContextAvailable: boolean
  readonly error?: string
}

/** Exact metadata cut read from DSH without attaching an Agent. */
export interface SessionPreview {
  readonly projectCwd?: string
  readonly cursor: number
  readonly cwd?: string
  readonly agentPreset?: string
  readonly projections: Record<string, unknown>
}
