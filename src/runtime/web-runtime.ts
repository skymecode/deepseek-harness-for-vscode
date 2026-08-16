import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import * as vscode from 'vscode'
import type { ConfigurationService, HarnessConfiguration } from '../config/configuration.js'
import type { BundledRuntimeResolver } from './bundled-runtime.js'
import { renderOverlay } from './runtime-overlay.js'

const START_TIMEOUT_MS = 90_000
const STOP_TIMEOUT_MS = 5_000

export type HostRuntimePhase = 'idle' | 'starting' | 'ready' | 'stopping' | 'error'

export interface HostRuntimeState {
  readonly phase: HostRuntimePhase
  readonly url?: string
  readonly error?: string
}

/** Owns the headless local Gateway process; its official Web frontend is never loaded. */
export class HarnessHostRuntime implements vscode.Disposable {
  private readonly stateEmitter = new vscode.EventEmitter<HostRuntimeState>()
  private child: ChildProcessWithoutNullStreams | undefined
  private startTask: Promise<string> | undefined
  private stopTask: Promise<void> | undefined
  private identity: string | undefined
  private stateValue: HostRuntimeState = { phase: 'idle' }

  readonly onDidChangeState = this.stateEmitter.event

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configuration: ConfigurationService,
    private readonly resolver: BundledRuntimeResolver,
    private readonly output: vscode.OutputChannel,
  ) {}

  get state(): HostRuntimeState {
    return this.stateValue
  }

  async start(): Promise<string> {
    if (this.stopTask !== undefined) await this.stopTask
    const configuration = this.configuration.get()
    const workspace = workspaceDirectory()
    const identity = runtimeIdentity(workspace, configuration)
    if (this.stateValue.phase === 'ready' && this.identity === identity && this.stateValue.url !== undefined) {
      return this.stateValue.url
    }
    if (this.startTask !== undefined && this.identity === identity) return this.startTask
    if (this.child !== undefined) await this.stop()

    this.identity = identity
    this.setState({ phase: 'starting' })
    const task = this.spawnRuntime(workspace, configuration)
    this.startTask = task
    try {
      return await task
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setState({ phase: 'error', error: message })
      throw error
    } finally {
      if (this.startTask === task) this.startTask = undefined
    }
  }

  async restart(): Promise<string> {
    await this.stop()
    return await this.start()
  }

  stop(): Promise<void> {
    this.stopTask ??= this.performStop().finally(() => { this.stopTask = undefined })
    return this.stopTask
  }

  dispose(): void {
    void this.stop()
    this.stateEmitter.dispose()
  }

  private async spawnRuntime(
    workspace: string,
    configuration: HarnessConfiguration,
  ): Promise<string> {
    const launch = await this.resolver.resolve()
    const home = path.join(this.context.globalStorageUri.fsPath, 'harness-home')
    const overlay = path.join(home, 'vscode.patch.yml')
    await mkdir(home, { recursive: true })
    await writeFile(overlay, renderOverlay(configuration), 'utf8')

    const args = [...launch.args, 'web', '--patch', overlay, '--host', '127.0.0.1', '--port', '0']
    const env: NodeJS.ProcessEnv = {
      ...launch.environment,
      DSH_HOME: home,
      DSH_CWD: workspace,
      DSH_PERMISSION_MODE: configuration.permissionMode,
      DSH_TELEMETRY_DISABLED: '1',
    }
    this.output.appendLine(vscode.l10n.t(
      '[host] Starting bundled Harness Gateway (cwd={cwd}, model={model}, reasoning={reasoning}, preset={preset})',
      { cwd: workspace, model: configuration.model, reasoning: configuration.reasoningEffort, preset: configuration.agentPreset },
    ))

    const child = spawn(launch.command, args, { cwd: workspace, env, windowsHide: true })
    this.child = child
    child.stderr.on('data', (chunk: Buffer | string) => this.output.append(String(chunk)))

    return await new Promise<string>((resolve, reject) => {
      let settled = false
      let buffer = ''
      const timeout = setTimeout(() => finish(new Error(vscode.l10n.t('The bundled Harness runtime timed out while starting. Check the output logs.'))), START_TIMEOUT_MS)

      const finish = (result: string | Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (typeof result === 'string') {
          this.setState({ phase: 'ready', url: result })
          resolve(result)
        } else {
          reject(result)
        }
      }

      child.stdout.on('data', (chunk: Buffer | string) => {
        const text = String(chunk)
        this.output.append(text)
        buffer += text
        const lines = buffer.split(/\r?\n/u)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const match = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+)/u.exec(line)
          if (match?.[1] !== undefined) finish(match[1])
        }
      })
      child.once('error', (error) => finish(error))
      child.once('exit', (code, signal) => {
        if (this.child === child) this.child = undefined
        const message = vscode.l10n.t('The bundled Harness runtime exited (code={code}, signal={signal}).', {
          code: String(code),
          signal: String(signal),
        })
        if (!settled) finish(new Error(message))
        else if (this.stateValue.phase !== 'stopping' && this.stateValue.phase !== 'idle') {
          this.setState({ phase: 'error', error: message })
        }
      })
    })
  }

  private async performStop(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.identity = undefined
    if (child === undefined) {
      this.setState({ phase: 'idle' })
      return
    }
    this.setState({ phase: 'stopping' })

    // Attach the exit listener before signalling so a fast exit cannot race it.
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    if (process.platform === 'win32') {
      // On Windows SIGTERM is an immediate TerminateProcess of the direct child
      // only; dsh's tool subprocesses (shells, background jobs) can outlive it.
      // Kill the whole process tree via taskkill so nothing survives a reload.
      const killed = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      // spawnSync neither throws on a failing taskkill (status != 0) nor on a
      // missing executable (error set); either way descendants may survive.
      if (killed.error !== undefined || killed.status !== 0) {
        this.output.appendLine(vscode.l10n.t('[host] Failed to terminate the process tree with taskkill; falling back to direct termination. Child processes may remain.'))
        child.kill()
      }
    } else {
      // POSIX: graceful SIGTERM first, escalate to SIGKILL on timeout.
      child.kill('SIGTERM')
    }

    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(true), STOP_TIMEOUT_MS))
    const timedOut = await Promise.race([exited.then(() => false), timeout])
    if (timedOut && child.exitCode === null) {
      if (process.platform === 'win32') child.kill()
      else child.kill('SIGKILL')
      // The exit handler already settled the runtime state; do not await the
      // (already-resolving) exit event here to avoid a hang if the kill fails.
    }
    this.setState({ phase: 'idle' })
  }

  private setState(state: HostRuntimeState): void {
    this.stateValue = state
    this.stateEmitter.fire(state)
  }
}

function workspaceDirectory(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
}

function runtimeIdentity(
  workspace: string,
  configuration: HarnessConfiguration,
): string {
  const fingerprint = createHash('sha256').update(JSON.stringify(configuration)).digest('hex')
  return JSON.stringify({ workspace, fingerprint })
}
