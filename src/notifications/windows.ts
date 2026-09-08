import { win32 } from 'node:path'
import type { NativeNotification, NotificationCommand } from './types.js'

// JSON travels over stdin with explicit UTF-8 decoding. XML text nodes prevent markup
// injection, and the encoded command contains only this static script (no user data).
const SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
  $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
  [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
  $xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
  $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text/><text/></binding></visual></toast>')
  $texts = $xml.GetElementsByTagName('text')
  $null = $texts.Item(0).AppendChild($xml.CreateTextNode([string]$payload.title))
  $null = $texts.Item(1).AppendChild($xml.CreateTextNode([string]$payload.message))
  if (-not $payload.sound) {
    $audio = $xml.CreateElement('audio')
    $audio.SetAttribute('silent', 'true')
    $null = $xml.DocumentElement.AppendChild($audio)
  }
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier([string]$payload.appId)
  if ($notifier.Setting.ToString() -ne 'Enabled') { throw 'Windows notifications are disabled for this application.' }
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  $toast.ExpirationTime = [DateTimeOffset]::Now.AddMinutes(5)
  $notifier.Show($toast)
} catch {
  [Console]::Error.WriteLine('Unable to submit the Windows system notification. Check notification permissions and VS Code installation.')
  exit 1
}
`

export function windowsNotificationCommand(
  notification: NativeNotification,
  appId: string,
  systemRoot: string,
): NotificationCommand {
  if (!win32.isAbsolute(systemRoot) || systemRoot.startsWith('\\\\')) throw new Error('A local Windows system directory is required.')
  if (!/^[\w.-]{1,128}$/.test(appId)) throw new Error('VS Code does not provide a valid Windows AppUserModelID.')
  return {
    executable: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
    input: JSON.stringify({ ...notification, appId }),
  }
}
