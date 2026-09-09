import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import * as vscode from 'vscode'
import type { ConfigurationService, HarnessConfiguration } from '../config/configuration.js'
import type { BundledRuntimeResolver } from './bundled-runtime.js'
import { harnessHomePath } from './harness-home.js'
import { isProjectionCacheFailure, recoverStaleProjectionCache } from './projection-cache-recovery.js'
import { pruneShadowedRuntimePackages } from './profile-scope-prune.js'
import { isModuleFallbackConflict } from './module-fallback-recovery.js'
import { prepareModuleFallback } from './prepare-module-fallback.js'
import { renderOverlay } from './runtime-overlay.js'
import { sharedHistoryHome } from './shared-history/paths.js'
import { runHistoryMigration } from './shared-history/runner.js'
import { historyCompression as detectHistoryCompression } from './shared-history/encoding.js'
import { LAST_SESSION_STATE_KEY } from '../domain/session-selection.js'

const START_TIMEOUT_MS = 90_000
const STOP_TIMEOUT_MS = 5_000

/**
 * Matches the Gateway's announced stdout line. The announced URL carries the
 * process launch token as `?token=` — the client trades that token for the
 * signed session cookie every /api call requires, so the query must survive
 * parsing; dropping it leaves every call unauthenticated (HTTP 401).
 */
const GATEWAY_ANNOUNCE_PATTERN = /dsh gateway:\s+(http:\/\/127\.0\.0\.1:\d+(?:\/\?token=[A-Za-z0-9_-]+)?)/u

/** Extracts the announced Gateway URL (launch token included) from one stdout line. */
export function parseGatewayAnnouncement(line: string): string | undefined {
  return GATEWAY_ANNOUNCE_PATTERN.exec(line)?.[1]
}

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
  private preparationAbort: AbortController | undefined
  private sharedHistoryValue = false

  get sharedHistory(): boolean { return this.sharedHistoryValue }

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
    const abort = new AbortController()
    this.preparationAbort = abort
    const task = this.spawnRuntime(workspace, configuration, abort.signal)
    this.startTask = task
    try {
      return await task
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setState({ phase: 'error', error: message })
      throw error
    } finally {
      if (this.startTask === task) this.startTask = undefined
      if (this.preparationAbort === abort) this.preparationAbort = undefined
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
    signal: AbortSignal,
  ): Promise<string> {
    const launch = await this.resolver.resolve()
    const home = harnessHomePath(this.context)
    const overlay = path.join(home, 'vscode.patch.yml')
    const gatewayPlugin = path.join(this.context.extensionUri.fsPath, 'dist', 'runtime', 'gateway-runtime.mjs')
    await mkdir(home, { recursive: true })
    const sharedHome = sharedHistoryHome(configuration.historyHome)
    let historyCompression: 'zstd' | 'none' = 'zstd'
    this.sharedHistoryValue = false
    try {
      const preferredSessionId = this.context.globalState?.get<string>(LAST_SESSION_STATE_KEY)
      const report = await runHistoryMigration(launch.command, this.context.asAbsolutePath('dist/runtime/shared-history-worker.mjs'), {
        destinationHome: sharedHome,
        forkLabel: vscode.l10n.t('VS Code history'),
        ...(preferredSessionId === undefined ? {} : { preferredSessionId }),
        sourceHomes: [home, ...(this.context.globalStorageUri?.fsPath === undefined ? [] : [path.join(this.context.globalStorageUri.fsPath, 'harness-home')])],
      }, signal)
      this.sharedHistoryValue = true
      historyCompression = report.compression
      if (report.preferredSessionId !== undefined) await this.context.globalState?.update(LAST_SESSION_STATE_KEY, report.preferredSessionId)
      this.output.appendLine(`[history] Shared history ready: ${JSON.stringify(report)}`)
      if (report.deferred > 0) void vscode.window.showWarningMessage(vscode.l10n.t('Some old sessions are still in use. Their originals are preserved; migration will retry on the next Harness start.'))
    } catch (error) {
      if (signal.aborted) throw error
      this.sharedHistoryValue = false
      this.output.appendLine(`[history] ${error instanceof Error ? error.message : String(error)}`)
      historyCompression = await detectHistoryCompression(path.join(home, 'sessions'))
      void vscode.window.showWarningMessage(vscode.l10n.t('History sharing could not finish safely. This launch keeps your previous extension history; no original logs were removed. See the output logs.'))
    }
    signal.throwIfAborted()
    await writeFile(overlay, renderOverlay(configuration, gatewayPlugin, this.sharedHistoryValue ? sharedHome : home, historyCompression), 'utf8')
    const installAnchor = this.context.asAbsolutePath(path.join('node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    await prepareModuleFallback(home, installAnchor, this.output)
    // Profile-level @deepseek-ai copies shadow the bundled runtime during
    // plugin resolution; drop stale ones so an older build's leftovers cannot
    // fail the boot with a stale-schema validation error.
    await pruneShadowedRuntimePackages(
      path.join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai'),
      this.context.asAbsolutePath(path.join('node_modules', '@deepseek-ai')),
      (line) => this.output.appendLine(line),
    )

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

    // Each recovery may run once; neither path can cause an endless restart.
    let retriedModules = false
    let retriedProjection = false
    for (;;) {
      const boot = await this.spawnGateway(launch, home, args, env)
      if (boot.url !== undefined) { this.setState({ phase: 'ready', url: boot.url }); return boot.url }
      if (boot.failure !== undefined) {
        this.setState({ phase: 'error', error: boot.failure })
        throw new Error(boot.failure)
      }
      if (!retriedModules && (boot.exitCode ?? 0) !== 0 && isModuleFallbackConflict(boot.diagnostics ?? '')) {
        retriedModules = true
        await prepareModuleFallback(home, installAnchor, this.output)
        this.output.appendLine(vscode.l10n.t('[host] Retrying Harness startup after a module fallback conflict.'))
        continue
      }
      if (!retriedProjection
        && (boot.exitCode ?? 0) !== 0
        && isProjectionCacheFailure(boot.diagnostics ?? '')
        && (await recoverStaleProjectionCache(home))) {
        retriedProjection = true
        this.output.appendLine(vscode.l10n.t('[host] The Gateway crashed on a stale session-projection cache; the cache was backed up and the boot is retried once.'))
        continue
      }
      const message = vscode.l10n.t('The bundled Harness runtime exited (code={code}, signal={signal}).', {
        code: String(boot.exitCode),
        signal: String(boot.signal ?? ''),
      })
      this.setState({ phase: 'error', error: message })
      throw new Error(message)
    }
  }

  /**
   * Spawns the headless Gateway once and waits for its announced URL. Boot
   * failures are returned (never thrown) so the caller can self-heal and
   * retry; stderr is collected as diagnostics for failure classification.
   */
  private async spawnGateway(
    launch: { readonly command: string; readonly args: readonly string[]; readonly environment: NodeJS.ProcessEnv },
    home: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): Promise<GatewayBoot> {
    // Spawn from the harness home, not the workspace: dsh boot reads
    // `cwd/.env` as the project layer and refuses bootstrap-only variables
    // (DEEPSEEK_BASE_URL, DSH_*, XDG_*, proxy vars, ...) declared there. A
    // workspace .env often carries such a var for unrelated tooling, which
    // made the Gateway refuse to boot. The harness still operates in the
    // workspace through DSH_CWD (agent cwd) — process cwd only drives .env
    // and profile/config discovery, both of which live under DSH_HOME.
    const child = spawn(launch.command, args, { cwd: home, env, windowsHide: true })
    this.child = child
    let diagnostics = ''
    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = String(chunk)
      this.output.append(text)
      diagnostics = (diagnostics + text).slice(-16_384)
    })

    return await new Promise<GatewayBoot>((resolve) => {
      let settled = false
      let buffer = ''
      const timeout = setTimeout(() => finish({
        failure: vscode.l10n.t('The bundled Harness runtime timed out while starting. Check the output logs.'),
      }), START_TIMEOUT_MS)

      const finish = (boot: GatewayBoot): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(boot)
      }

      child.stdout.on('data', (chunk: Buffer | string) => {
        const text = String(chunk)
        this.output.append(text)
        buffer += text
        const lines = buffer.split(/\r?\n/u)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.includes('dsh gateway-auth-unavailable')) {
            finish({ failure: vscode.l10n.t('The Gateway could not arm its authentication channel. Reload the workbench or reinstall the VSIX.') })
            return
          }
          const url = parseGatewayAnnouncement(line)
          if (url !== undefined) finish({ url })
        }
      })
      child.once('error', (error) => finish({ failure: error.message, diagnostics }))
      child.once('exit', (code, signal) => {
        if (this.child === child) this.child = undefined
        // The gateway may have announced readiness and then died later (a
        // crash mid-session): surface that as a runtime error instead of a
        // boot failure so the caller does not re-clear caches for an
        // unrelated drop.
        if (settled) {
          if (this.stateValue.phase !== 'stopping' && this.stateValue.phase !== 'idle') {
            const message = vscode.l10n.t('The bundled Harness runtime exited (code={code}, signal={signal}).', {
              code: String(code),
              signal: String(signal),
            })
            this.setState({ phase: 'error', error: message })
          }
          return
        }
        finish({ exitCode: code, signal, diagnostics })
      })
    })
  }

  private async performStop(): Promise<void> {
    this.preparationAbort?.abort()
    this.preparationAbort = undefined
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

/** Outcome of one headless Gateway boot attempt. */
interface GatewayBoot {
  readonly url?: string
  readonly failure?: string
  readonly exitCode?: number | null
  readonly signal?: NodeJS.Signals | null
  readonly diagnostics?: string
}
