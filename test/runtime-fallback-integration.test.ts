import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type * as vscode from 'vscode'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigurationService } from '../src/config/configuration.js'
import type { BundledRuntimeResolver } from '../src/runtime/bundled-runtime.js'

const state = vi.hoisted(() => ({ home: '', spawn: vi.fn() }))
vi.mock('vscode', () => ({
  EventEmitter: class { fire() {} dispose() {} event = () => ({ dispose() {} }) },
  workspace: { workspaceFolders: undefined },
  window: { showWarningMessage: vi.fn() },
  l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)])) },
}))
vi.mock('../src/runtime/harness-home.js', () => ({ harnessHomePath: () => state.home }))
vi.mock('../src/runtime/shared-history/runner.js', () => ({ runHistoryMigration: vi.fn(async () => ({ copied: 0, advanced: 0, forked: 0, skipped: 0, deferred: 0, compression: 'zstd' })) }))
vi.mock('node:child_process', async (original) => ({ ...await original<object>(), spawn: state.spawn }))

import { HarnessHostRuntime } from '../src/runtime/web-runtime.js'
import { DshPluginManager } from '../src/plugins/plugin-manager.js'
import { runHistoryMigration } from '../src/runtime/shared-history/runner.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); state.spawn.mockReset(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'runtime-fallback-integration-'))
  roots.push(root)
  state.home = join(root, 'home')
  const installed = join(root, 'extension')
  const anchorDir = join(installed, 'node_modules', '@deepseek-ai', 'dsh')
  const obstruction = join(state.home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(anchorDir, { recursive: true })
  await writeFile(join(anchorDir, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"1.0.0"}')
  const plant = async () => { await mkdir(obstruction, { recursive: true }); await writeFile(join(obstruction, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"0.9.0"}') }
  await plant()
  const context = { extensionUri: { fsPath: installed }, asAbsolutePath: (path: string) => join(installed, path) } as vscode.ExtensionContext
  const resolver = { resolve: async () => ({ command: 'node', args: [], environment: {} }) } as unknown as BundledRuntimeResolver
  const configuration = { get: () => ({ model: 'deepseek-v4-flash', provider: 'deepseek-official', reasoningEffort: 'high', agentPreset: 'standard', permissionMode: 'read-only' }) } as ConfigurationService
  const output = { appendLine: vi.fn(), append: vi.fn() } as unknown as vscode.OutputChannel
  return { root, context, resolver, configuration, output, obstruction, plant }
}

type BootSeam = { spawnGateway: () => Promise<{ url?: string; exitCode?: number; diagnostics?: string }> }
const conflict = 'exists and is not a symlink or dsh-managed module proxy; remove it so dsh can manage the installation fallback'

describe('automatic recovery entry points', () => {
  it('keeps the private history root when shared migration cannot complete safely', async () => {
    const f = await fixture()
    vi.mocked(runHistoryMigration).mockRejectedValueOnce(new Error('source history is unreadable'))
    const runtime = new HarnessHostRuntime(f.context, f.configuration, f.resolver, f.output)
    vi.spyOn(runtime as unknown as BootSeam, 'spawnGateway').mockResolvedValue({ url: 'http://127.0.0.1:1234' })
    await runtime.start()
    expect(runtime.sharedHistory).toBe(false)
    expect(await readFile(join(state.home, 'vscode.patch.yml'), 'utf8')).toContain(JSON.stringify(join(state.home, 'sessions')))
    await runtime.stop()
  })
  it('repairs before Gateway spawn and retries a newly reported conflict only once', async () => {
    const f = await fixture()
    const runtime = new HarnessHostRuntime(f.context, f.configuration, f.resolver, f.output)
    let attempts = 0
    const spawn = vi.spyOn(runtime as unknown as BootSeam, 'spawnGateway').mockImplementation(async () => {
      expect(existsSync(f.obstruction)).toBe(false)
      if (++attempts === 1) { await f.plant(); return { exitCode: 1, diagnostics: conflict } }
      return { url: 'http://127.0.0.1:1234' }
    })
    expect(await runtime.start()).toBe('http://127.0.0.1:1234')
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(f.output.appendLine).toHaveBeenCalledWith(expect.stringContaining('Backed up incompatible module'))
    await runtime.stop()
  })

  it('does not endlessly retry a persistent conflict or retry unrelated failures', async () => {
    const f = await fixture()
    const runtime = new HarnessHostRuntime(f.context, f.configuration, f.resolver, f.output)
    const spawn = vi.spyOn(runtime as unknown as BootSeam, 'spawnGateway').mockResolvedValue({ exitCode: 1, diagnostics: conflict })
    await expect(runtime.start()).rejects.toThrow('runtime exited')
    expect(spawn).toHaveBeenCalledTimes(2)
    spawn.mockClear().mockResolvedValue({ exitCode: 1, diagnostics: 'unrelated authentication error' })
    await expect(runtime.start()).rejects.toThrow('runtime exited')
    expect(spawn).toHaveBeenCalledOnce()
    await runtime.stop()
  })

  it('repairs before invoking a community-plugin installation, without replaying the mutation', async () => {
    const f = await fixture()
    state.spawn.mockImplementation(() => {
      expect(existsSync(f.obstruction)).toBe(false)
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() })
      queueMicrotask(() => child.emit('exit', 0, null))
      return child
    })
    const plugins = new DshPluginManager(f.context, f.resolver, f.output)
    await plugins.install('example-plugin')
    expect(state.spawn).toHaveBeenCalledOnce()
    expect(f.output.appendLine).toHaveBeenCalledWith(expect.stringContaining('Backed up incompatible module'))
    expect(await readFile(join(f.context.asAbsolutePath('node_modules/@deepseek-ai/dsh'), 'package.json'), 'utf8')).toContain('1.0.0')
  })
})
