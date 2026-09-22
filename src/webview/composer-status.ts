export interface ComposerStatusInput {
  readonly running: boolean
  readonly subagentMode?: 'one-shot' | 'continuable' | 'unknown'
}

export interface ComposerStatusLabels {
  readonly oneShotReadOnly: string
  readonly continuableSubagent: string
}

/**
 * Builds status text without repeating the model already shown by the picker.
 * Token flow (↑ in / ↓ out) is rendered by the session heading's usage pill,
 * and the running state shows no status line (the send button already flips
 * to ■ with a stop hint).
 */
export function composerStatusText(
  input: ComposerStatusInput | undefined,
  labels: ComposerStatusLabels,
): string {
  if (input === undefined) return ''
  if (input.subagentMode === 'one-shot') return labels.oneShotReadOnly
  if (input.subagentMode === 'continuable') return labels.continuableSubagent
  return ''
}
