import * as vscode from 'vscode'
import { NativeNotifier } from './native-notifier.js'
import type { NativeNotification } from './types.js'
import type { CompletionNotice } from '../domain/turn-completion.js'

/** Completion business policy, localization and lifecycle, separate from OS adapters. */
export class CompletionNotifications implements vscode.Disposable {
  private readonly abort = new AbortController()
  private pending = Promise.resolve()

  constructor(
    private readonly output: Pick<vscode.OutputChannel, 'appendLine'>,
    private readonly notifier: Pick<NativeNotifier, 'show'> = new NativeNotifier({
      platform: process.platform,
      remote: vscode.env.remoteName !== undefined,
      appRoot: vscode.env.appRoot,
      systemRoot: process.env.SystemRoot ?? '',
    }),
  ) {}

  complete(notice: CompletionNotice): void {
    const settings = vscode.workspace.getConfiguration('deepseekHarness.systemNotifications')
    if (!settings.get<boolean>('enabled', true) || this.abort.signal.aborted) return
    const summary = notice.failed
      ? vscode.l10n.t('The turn failed. Return to DeepSeek Harness to view details.')
      : vscode.l10n.t('The turn has finished. Return to DeepSeek Harness to view the reply.')
    const title = settings.get<boolean>('includeConversationTitle', false) ? safeTitle(notice.title) : ''
    this.enqueue({
      title: vscode.l10n.t('DeepSeek Harness'),
      message: title === '' ? summary : `${title}\n${summary}`,
      sound: settings.get<boolean>('sound', false),
    })
  }

  /** Explicit diagnostic command bypasses enabled, but never falls back to VS Code popups. */
  test(): Promise<void> {
    this.enqueue({
      title: vscode.l10n.t('DeepSeek Harness'),
      message: vscode.l10n.t('System notifications are ready. Future turn completions will appear here.'),
      sound: vscode.workspace.getConfiguration('deepseekHarness.systemNotifications').get<boolean>('sound', false),
    })
    return this.pending
  }

  dispose(): void { this.abort.abort() }

  private enqueue(notification: NativeNotification): void {
    // Serialize simultaneous session completions without blocking Gateway event consumption.
    this.pending = this.pending.then(async () => {
      if (this.abort.signal.aborted) return
      try {
        await this.notifier.show(notification, this.abort.signal)
        this.output.appendLine('[notifications] Submitted to the operating system; banner visibility depends on OS permissions and Focus settings.')
      } catch (cause) {
        if (!this.abort.signal.aborted) this.output.appendLine(`[notifications] ${cause instanceof Error ? cause.message : 'System notification failed.'}`)
      }
    })
  }
}

/** No reply, tool output, credentials or full error details are sent to the lock screen. */
function safeTitle(title: string): string {
  return [...title.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim()].slice(0, 100).join('')
}
