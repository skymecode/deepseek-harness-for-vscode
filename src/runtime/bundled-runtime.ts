import { constants as fsConstants } from 'node:fs'
import { access, chmod, mkdir, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type * as vscode from 'vscode'

const execFileAsync = promisify(execFile)

/** Executable information for the Harness runtime shipped inside the VSIX. */
export interface BundledRuntimeLaunch {
  readonly command: string
  readonly args: readonly string[]
  readonly environment: NodeJS.ProcessEnv
}

/**
 * Resolves the official `dsh` package bundled with this extension.
 *
 * A standalone Node executable is packaged in the platform VSIX. We do not use
 * VS Code's Electron executable because Harness loads native sandbox and PTY
 * modules whose ABI/signing contract is that of ordinary Node, not Electron.
 */
export class BundledRuntimeResolver {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly localize: RuntimeLocalize = defaultLocalize,
  ) {}

  async resolve(): Promise<BundledRuntimeLaunch> {
    const entry = this.context.asAbsolutePath('node_modules/@deepseek-ai/dsh/lib/bin.js')
    const node = this.context.asAbsolutePath(path.join(
      'node_modules',
      'node',
      'bin',
      process.platform === 'win32' ? 'node.exe' : 'node',
    ))
    const pnpm = this.context.asAbsolutePath(path.join('node_modules', 'pnpm', 'bin', 'pnpm.mjs'))
    try {
      await Promise.all([
        access(entry, fsConstants.R_OK),
        access(node, process.platform === 'win32' ? fsConstants.R_OK : fsConstants.R_OK | fsConstants.X_OK),
        access(pnpm, fsConstants.R_OK),
      ])
    } catch {
      throw new Error(this.localize('The bundled DeepSeek Harness runtime is incomplete. Reinstall the VSIX.'))
    }

    let versionText = ''
    try {
      const result = await execFileAsync(node, ['--version'], { encoding: 'utf8' })
      versionText = result.stdout.trim()
    } catch {
      throw new Error(this.localize('The bundled Node executable cannot run on this platform. Install the VSIX matching your operating system and architecture.'))
    }
    const version = parseNodeVersion(versionText)
    if (version === undefined || !supportsHarnessNode(version)) {
      throw new Error(this.localize('The bundled Node version is not supported by Harness: {0}.', versionText || this.localize('unknown')))
    }

    const tooling = await this.prepareTooling(node, pnpm)
    return {
      command: node,
      args: [entry],
      environment: {
        ...process.env,
        PATH: [tooling, path.dirname(node), process.env.PATH].filter(Boolean).join(path.delimiter),
        DSH_BUNDLED_NODE: node,
        DSH_BUNDLED_PNPM: pnpm,
      },
    }
  }

  /** Provides the `pnpm` executable name expected by the official DSH CLI. */
  private async prepareTooling(node: string, pnpm: string): Promise<string> {
    const directory = path.join(this.context.globalStorageUri.fsPath, 'runtime-bin')
    await mkdir(directory, { recursive: true })
    const tooling = pnpmWrapper(process.platform, { node, pnpm })
    const wrapper = path.join(directory, tooling.filename)
    await writeFile(wrapper, tooling.content, 'utf8')
    if (tooling.executable) await chmod(wrapper, 0o755)
    return directory
  }
}

/** Cross-platform shim consumed by DSH's official `spawnSync("pnpm")`. */
export function pnpmWrapper(platform: NodeJS.Platform, invocation?: { node: string; pnpm: string }): {
  readonly filename: string
  readonly content: string
  readonly executable: boolean
} {
  // Plugin Manager intentionally scrubs DSH_* variables. The launcher-owned
  // shim must carry its executable paths instead of relying on inherited env.
  const cmdQuote = (value: string): string => `"${value.replace(/%/gu, '%%')}"`
  const shQuote = (value: string): string => `'${value.replace(/'/gu, `'"'"'`)}'`
  return platform === 'win32'
    ? {
      filename: 'pnpm.cmd',
      content: invocation === undefined ? '@echo off\r\n"%DSH_BUNDLED_NODE%" "%DSH_BUNDLED_PNPM%" %*\r\n'
        : `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${cmdQuote(invocation.node)} ${cmdQuote(invocation.pnpm)} %*\r\n`,
      executable: false,
    }
    : {
      filename: 'pnpm',
      content: invocation === undefined ? '#!/bin/sh\nexec "$DSH_BUNDLED_NODE" "$DSH_BUNDLED_PNPM" "$@"\n'
        : `#!/bin/sh\nexec ${shQuote(invocation.node)} ${shQuote(invocation.pnpm)} "$@"\n`,
      executable: true,
    }
}

export type RuntimeLocalize = (message: string, ...args: Array<string | number | boolean>) => string

function defaultLocalize(message: string, ...args: Array<string | number | boolean>): string {
  return message.replace(/\{(\d+)\}/gu, (placeholder, index: string) => args[Number(index)]?.toString() ?? placeholder)
}

export function parseNodeVersion(value: string): { major: number; minor: number; patch: number } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(value.trim())
  if (match === null) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

export function supportsHarnessNode(version: { major: number; minor: number }): boolean {
  return version.major >= 24 || (version.major === 22 && version.minor >= 19)
}
