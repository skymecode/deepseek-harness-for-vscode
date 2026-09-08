import { describe, expect, it, vi } from 'vitest'
import { macNotificationCommand } from '../src/notifications/macos.js'
import { windowsNotificationCommand } from '../src/notifications/windows.js'
import { NativeNotifier } from '../src/notifications/native-notifier.js'

const message = { title: 'DeepSeek Harness', message: '已完成 "你好" <&>\n$(whoami); `bad`', sound: false }
const signal = new AbortController().signal

describe('native OS adapters', () => {
  it('passes macOS text as arguments, not executable AppleScript', () => {
    const command = macNotificationCommand(message)
    expect(command.executable).toBe('/usr/bin/osascript')
    expect(command.args.slice(2)).toEqual(['--', message.title, message.message, 'false'])
    expect(command.args[1]).not.toContain(message.message)
    expect(macNotificationCommand({ ...message, sound: true }).args.at(-1)).toBe('true')
  })

  it('passes Windows Unicode as JSON stdin and only encodes a static PowerShell script', () => {
    const command = windowsNotificationCommand(message, 'Microsoft.VisualStudioCode', 'C:\\Windows')
    expect(command.executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(JSON.parse(command.input ?? '')).toEqual({ ...message, appId: 'Microsoft.VisualStudioCode' })
    const script = Buffer.from(command.args.at(-1) ?? '', 'base64').toString('utf16le')
    expect(script).not.toContain(message.message)
    expect(script).toContain('CreateTextNode')
    expect(script).toContain('InputEncoding')
    expect(command.args).not.toContain('-ExecutionPolicy')
    expect(windowsNotificationCommand({ ...message, sound: true }, 'Microsoft.VisualStudioCode', 'C:\\Windows').args).toEqual(command.args)
  })

  it('rejects missing system directories, UNC paths and malformed app IDs', () => {
    expect(() => windowsNotificationCommand(message, 'valid', '')).toThrow()
    expect(() => windowsNotificationCommand(message, 'valid', '\\\\host\\Windows')).toThrow()
    expect(() => windowsNotificationCommand(message, "bad'; command", 'C:\\Windows')).toThrow()
  })

  it('uses the running Windows product identity, including Insiders', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const read = vi.fn().mockResolvedValue({ win32AppUserModelId: 'Microsoft.VisualStudioCode.Insiders' })
    const notifier = new NativeNotifier({ platform: 'win32', remote: false, appRoot: 'product root', systemRoot: 'C:\\Windows' }, run, read)
    await notifier.show(message, signal)
    expect(read).toHaveBeenCalledWith('product root')
    expect(JSON.parse(run.mock.calls[0]?.[0].input as string).appId).toBe('Microsoft.VisualStudioCode.Insiders')
  })

  it('does not read product identity on macOS', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const read = vi.fn()
    await new NativeNotifier({ platform: 'darwin', remote: false, appRoot: '', systemRoot: '' }, run, read).show(message, signal)
    expect(run).toHaveBeenCalledWith(macNotificationCommand(message), signal)
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses unsupported or remote hosts without silently targeting the wrong desktop', async () => {
    const run = vi.fn()
    for (const env of [{ platform: 'linux' as const, remote: false }, { platform: 'darwin' as const, remote: true }]) {
      await expect(new NativeNotifier({ ...env, appRoot: '', systemRoot: '' }, run).show(message, signal)).rejects.toThrow()
    }
    expect(run).not.toHaveBeenCalled()
  })

  it('does not fall back to another Windows app identity or send after disposal', async () => {
    const run = vi.fn()
    const env = { platform: 'win32' as const, remote: false, appRoot: '', systemRoot: 'C:\\Windows' }
    await expect(new NativeNotifier(env, run, async () => ({})).show(message, signal)).rejects.toThrow('AppUserModelID')
    const abort = new AbortController()
    abort.abort()
    await new NativeNotifier(env, run).show(message, abort.signal)
    expect(run).not.toHaveBeenCalled()
  })
})
