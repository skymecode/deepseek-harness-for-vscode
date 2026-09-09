import * as vscode from 'vscode'
import { recoverModuleFallback } from './module-fallback-recovery.js'

/** Shared startup/install boundary; policy and filesystem work stay independently testable. */
export async function prepareModuleFallback(
  home: string,
  installAnchor: string,
  output: Pick<vscode.OutputChannel, 'appendLine'>,
): Promise<void> {
  try {
    await recoverModuleFallback(home, installAnchor, ({ packageName, backup }) => {
      output.appendLine(vscode.l10n.t('[runtime] Backed up incompatible module {0} to {1}; Harness will rebuild its link.', packageName, backup))
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    output.appendLine(`[runtime] Module fallback recovery failed: ${detail}`)
    throw new Error(vscode.l10n.t('Harness could not prepare its runtime module links. Existing files were preserved. See the output logs for details.'))
  }
}
