/** Host-wide completion signal, independent of the selected webview conversation. */
export interface CompletionNotice {
  readonly title: string
  readonly failed: boolean
}
