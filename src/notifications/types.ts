/** OS adapters accept display-only text, never commands or model output. */
export interface NativeNotification {
  readonly title: string
  readonly message: string
  readonly sound: boolean
}

export interface NotificationCommand {
  readonly executable: string
  readonly args: readonly string[]
  readonly input?: string
}
