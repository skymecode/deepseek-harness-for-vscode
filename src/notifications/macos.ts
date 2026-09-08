import type { NativeNotification, NotificationCommand } from './types.js'

// All dynamic strings are argv data. Never interpolate conversation titles into AppleScript.
const SCRIPT = `on run argv
  if item 3 of argv is "true" then
    display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"
  else
    display notification (item 2 of argv) with title (item 1 of argv)
  end if
end run`

export function macNotificationCommand(notification: NativeNotification): NotificationCommand {
  return {
    executable: '/usr/bin/osascript',
    args: ['-e', SCRIPT, '--', notification.title, notification.message, String(notification.sound)],
  }
}
