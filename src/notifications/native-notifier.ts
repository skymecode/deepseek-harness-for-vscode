import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { macNotificationCommand } from './macos.js'
import { windowsNotificationCommand } from './windows.js'
import type { NativeNotification, NotificationCommand } from './types.js'

export interface NotificationEnvironment {
  readonly platform: NodeJS.Platform
  readonly remote: boolean
  readonly appRoot: string
  readonly systemRoot: string
}

/** Uses only OS-supplied executables, so VSIX files need no extra native binaries. */
export class NativeNotifier {
  constructor(
    private readonly environment: NotificationEnvironment,
    private readonly run = runNotificationCommand,
    private readonly readProduct = async (root: string): Promise<unknown> => JSON.parse(await readFile(join(root, 'product.json'), 'utf8')),
  ) {}

  async show(notification: NativeNotification, signal: AbortSignal): Promise<void> {
    const env = this.environment
    if (env.remote) throw new Error('System notifications require a local desktop extension host; SSH, WSL and containers are not supported.')
    if (signal.aborted) return
    if (env.platform === 'darwin') return this.run(macNotificationCommand(notification), signal)
    if (env.platform !== 'win32') throw new Error('System notifications currently support Windows and macOS only.')
    // Read the actual running VS Code product, including Insiders. Do not create
    // registry entries, use another application's identity, or assume Stable's ID.
    const product = await this.readProduct(env.appRoot) as { win32AppUserModelId?: unknown } | null
    const appId = product?.win32AppUserModelId
    if (typeof appId !== 'string') throw new Error('The VS Code Windows AppUserModelID is unavailable.')
    if (!signal.aborted) await this.run(windowsNotificationCommand(notification, appId, env.systemRoot), signal)
  }
}

/** Bounded, cancellable child process with no shell and no message data in logs. */
export function runNotificationCommand(command: NotificationCommand, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
      shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], signal,
    })
    const timeout = setTimeout(() => { child.kill(); reject(new Error('System notification submission timed out.')) }, 10_000)
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error(`System notification process exited with code ${String(code)}.`))
    })
    // A process denied by system policy may close stdin before we finish writing.
    child.stdin.on('error', () => { /* Exit/error handlers above own the failure. */ })
    child.stdin.end(command.input)
  })
}
