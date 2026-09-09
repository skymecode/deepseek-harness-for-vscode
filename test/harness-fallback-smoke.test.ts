import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootSmokeRuntime } from './helpers/runtime-smoke.js'
import { recoverModuleFallback } from '../src/runtime/module-fallback-recovery.js'

describe.runIf(process.env.DSH_RUNTIME_SMOKE === '1')('real Harness module fallback recovery', () => {
  it('repairs old ordinary directories before boot, without changing history, credentials or community dependencies', async () => {
    let installAnchor = ''
    // No model calls: the unused endpoint is loopback, and the helper never reads user keys.
    const runtime = await bootSmokeRuntime('http://127.0.0.1:1', {
      prepare: async (home, extensionRoot) => {
        installAnchor = join(extensionRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
        for (const name of ['dsh', 'dsh-base']) {
          const obstruction = join(home, 'profiles', 'node_modules', '@deepseek-ai', name)
          await mkdir(obstruction, { recursive: true })
          await writeFile(join(obstruction, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version: '0.1.3-alpha.2' }))
          await writeFile(join(obstruction, 'preserve.txt'), name)
        }
        const plugin = join(home, 'profiles', 'web', 'node_modules', 'custom-plugin')
        await mkdir(plugin, { recursive: true })
        await writeFile(join(plugin, 'package.json'), '{"name":"custom-plugin","version":"1.0.0"}')
        await mkdir(join(home, 'sessions'), { recursive: true })
        await writeFile(join(home, 'sessions', 'sentinel'), 'history kept')
        await writeFile(join(home, 'credential-sentinel'), 'test-only-secret')
      },
    })
    try {
      await runtime.client.probe()
      expect(runtime.moduleBackups.map((entry) => entry.packageName).sort()).toEqual(['@deepseek-ai/dsh', '@deepseek-ai/dsh-base'])
      for (const backup of runtime.moduleBackups) {
        expect((await lstat(backup.original)).isSymbolicLink()).toBe(true)
        expect(await readFile(join(backup.backup, 'preserve.txt'), 'utf8')).toBe(backup.packageName.split('/')[1])
      }
      expect(await readFile(join(runtime.home, 'sessions', 'sentinel'), 'utf8')).toBe('history kept')
      expect(await readFile(join(runtime.home, 'credential-sentinel'), 'utf8')).toBe('test-only-secret')
      expect(await readFile(join(runtime.home, 'profiles', 'web', 'node_modules', 'custom-plugin', 'package.json'), 'utf8')).toContain('custom-plugin')
      expect(await recoverModuleFallback(runtime.home, installAnchor)).toEqual([])
    } finally { await runtime.close() }
  }, 45_000)
})
