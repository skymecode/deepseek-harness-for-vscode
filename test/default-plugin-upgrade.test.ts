import { describe, expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'
import type { BundledRuntimeResolver } from '../src/runtime/bundled-runtime.js'
vi.mock('vscode', () => ({ l10n: { t: (s: string) => s } }))
vi.mock('../src/runtime/harness-home.js', () => ({ harnessHomePath: () => '/fixture' }))
import { DshPluginManager } from '../src/plugins/plugin-manager.js'

type SeedSeam = { defaultPluginsSeedVersion(): Promise<number>; installVendored(path: string, enabled?: boolean): Promise<void>; markDefaultPluginsSeeded(): Promise<void> }
function fixture() {
  const manager = new DshPluginManager({} as vscode.ExtensionContext, {} as BundledRuntimeResolver, {} as vscode.OutputChannel)
  const seam = manager as unknown as SeedSeam
  vi.spyOn(seam, 'defaultPluginsSeedVersion').mockResolvedValue(2)
  const install = vi.spyOn(seam, 'installVendored').mockResolvedValue()
  vi.spyOn(seam, 'markDefaultPluginsSeeded').mockResolvedValue()
  return { manager, install }
}

describe('known importer compatibility upgrade', () => {
  it('does not reinstall a plugin removed after an older seed', async () => {
    const { manager, install } = fixture()
    vi.spyOn(manager, 'listInstalled').mockResolvedValue([])
    await manager.ensureDefaultPlugins()
    expect(install).not.toHaveBeenCalled()
  })
  it('updates the old bundled version without enabling a disabled plugin', async () => {
    const { manager, install } = fixture()
    vi.spyOn(manager, 'listInstalled').mockResolvedValue([{ name: 'dsh-chat-import', version: '0.6.2', enabled: false, source: 'file:vendor/import.tgz', includesWebClient: true }])
    await manager.ensureDefaultPlugins()
    expect(install).toHaveBeenCalledWith('vendor/plugins/dsh-chat-import-0.26.4.tgz', false)
  })
})
