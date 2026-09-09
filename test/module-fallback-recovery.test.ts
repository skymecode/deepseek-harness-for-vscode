import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fallbackPackageNames } from '../src/runtime/fallback-package-catalog.js'
import { isModuleFallbackConflict, recoverModuleFallback } from '../src/runtime/module-fallback-recovery.js'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

const roots: string[] = []
afterEach(async () => {
  vi.mocked(fs.rename).mockClear()
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

async function packageAt(directory: string, name: string, extra: object = {}): Promise<string> {
  const target = join(directory, name)
  await fs.mkdir(target, { recursive: true })
  await fs.writeFile(join(target, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...extra }))
  return target
}

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh fallback recovery '))
  roots.push(root)
  const home = join(root, 'home')
  const modules = join(home, 'profiles', 'node_modules')
  const installed = join(root, 'installed', 'node_modules')
  await fs.mkdir(modules, { recursive: true })
  const anchor = join(await packageAt(installed, '@deepseek-ai/dsh', { dependencies: { '@deepseek-ai/dsh-base': '1', 'ordinary-dependency': '1' } }), 'package.json')
  await packageAt(installed, '@deepseek-ai/dsh-base', { peerDependencies: { 'no-manifest-export': '1', 'missing-optional-peer': '1' } })
  await packageAt(installed, 'ordinary-dependency')
  await packageAt(installed, 'no-manifest-export', { exports: { '.': './index.js' } })
  return { root, home, modules, installed, anchor }
}

describe('shared Harness module fallback recovery', () => {
  it('resolves the installation dependency/peer closure even without package.json exports', async () => {
    const f = await fixture()
    expect(await fallbackPackageNames(f.anchor)).toEqual(['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', 'ordinary-dependency', 'no-manifest-export'])
  })

  it('backs up all obstructing ordinary packages, including same-version copies, without touching user data', async () => {
    const f = await fixture()
    const source = await packageAt(f.modules, '@deepseek-ai/dsh')
    const other = await packageAt(f.modules, 'ordinary-dependency')
    await fs.writeFile(join(source, 'user-notes.txt'), 'preserve even unexpected files')
    const original = await fs.readFile(join(source, 'package.json'))
    const unrelated = await packageAt(f.modules, 'unrelated-user-package')
    const privatePlugin = await packageAt(join(f.home, 'profiles', 'web', 'node_modules'), '@deepseek-ai/dsh')
    await fs.mkdir(join(f.home, 'sessions'), { recursive: true })
    await fs.writeFile(join(f.home, 'sessions', 'sentinel'), 'history')
    await fs.writeFile(join(f.home, 'credentials-sentinel'), 'test-only-credential')
    const backup = vi.fn()
    const result = await recoverModuleFallback(f.home, f.anchor, backup)
    expect(result.map((entry) => entry.packageName)).toEqual(['@deepseek-ai/dsh', 'ordinary-dependency'])
    expect(await fs.readFile(join(result[0]!.backup, 'package.json'))).toEqual(original)
    expect(await fs.readFile(join(result[0]!.backup, 'user-notes.txt'), 'utf8')).toBe('preserve even unexpected files')
    expect(backup).toHaveBeenCalledTimes(2)
    await expect(fs.lstat(source)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.lstat(other)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.lstat(privatePlugin)).isDirectory()).toBe(true)
    expect((await fs.lstat(unrelated)).isDirectory()).toBe(true)
    expect(await fs.readFile(join(f.home, 'sessions', 'sentinel'), 'utf8')).toBe('history')
    expect(await fs.readFile(join(f.home, 'credentials-sentinel'), 'utf8')).toBe('test-only-credential')
    expect(await recoverModuleFallback(f.home, f.anchor)).toEqual([])
  })

  it('preserves good/stale/dangling junctions and DSH-managed proxy directories', async () => {
    const f = await fixture()
    await fs.mkdir(join(f.modules, '@deepseek-ai'), { recursive: true })
    await fs.symlink(join(f.installed, '@deepseek-ai', 'dsh'), join(f.modules, '@deepseek-ai', 'dsh'), 'junction')
    await fs.symlink(join(f.root, 'missing-old-install'), join(f.modules, 'ordinary-dependency'), 'junction')
    const proxy = await packageAt(f.modules, '@deepseek-ai/dsh-base', { dsh: { moduleFallback: { targets: { '.': 'file:///old-runtime/index.js' } } } })
    expect(await recoverModuleFallback(f.home, f.anchor)).toEqual([])
    expect((await fs.lstat(join(f.modules, 'ordinary-dependency'))).isSymbolicLink()).toBe(true)
    expect((await fs.lstat(proxy)).isDirectory()).toBe(true)
    expect((await fs.readdir(f.home)).some((name) => name.startsWith('module-fallback-backup-'))).toBe(false)
  })

  it('backs up damaged manifests, empty directories and package-name file collisions', async () => {
    const f = await fixture()
    const corrupt = await packageAt(f.modules, '@deepseek-ai/dsh')
    await fs.writeFile(join(corrupt, 'package.json'), '{broken')
    await fs.mkdir(join(f.modules, 'ordinary-dependency'))
    await fs.writeFile(join(f.modules, 'no-manifest-export'), 'unexpected file')
    const result = await recoverModuleFallback(f.home, f.anchor)
    expect(result).toHaveLength(3)
    expect(await fs.readFile(join(result[0]!.backup, 'package.json'), 'utf8')).toBe('{broken')
    expect(await fs.readFile(result[2]!.backup, 'utf8')).toBe('unexpected file')
  })

  it('coordinates concurrent windows through the upstream lock and creates only one backup', async () => {
    const f = await fixture()
    await packageAt(f.modules, '@deepseek-ai/dsh')
    const results = await Promise.all([recoverModuleFallback(f.home, f.anchor), recoverModuleFallback(f.home, f.anchor)])
    expect(results.flat()).toHaveLength(1)
    await expect(fs.lstat(f.modules + '.lock')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not follow a scoped directory junction into another installation', async () => {
    const f = await fixture()
    const outside = join(f.root, 'outside')
    const source = await packageAt(outside, 'dsh')
    await fs.symlink(outside, join(f.modules, '@deepseek-ai'), 'junction')
    expect(await recoverModuleFallback(f.home, f.anchor)).toEqual([])
    expect((await fs.lstat(source)).isDirectory()).toBe(true)
  })

  it('preserves the source on Windows sharing/permission errors and can recover on a later launch', async () => {
    const f = await fixture()
    const source = await packageAt(f.modules, '@deepseek-ai/dsh')
    vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('sharing violation'), { code: 'EPERM' }))
    await expect(recoverModuleFallback(f.home, f.anchor)).rejects.toThrow('existing files were preserved')
    expect((await fs.lstat(source)).isDirectory()).toBe(true)
    expect(await recoverModuleFallback(f.home, f.anchor)).toHaveLength(1)
  })

  it('is a no-op on the first install, before a shared module directory exists', async () => {
    const f = await fixture()
    expect(await recoverModuleFallback(join(f.root, 'absent'), f.anchor)).toEqual([])
  })

  it('rejects traversal names from an invalid installation manifest before moving anything', async () => {
    const f = await fixture()
    const source = await packageAt(f.modules, '@deepseek-ai/dsh')
    await fs.writeFile(f.anchor, JSON.stringify({ name: '@deepseek-ai/dsh', dependencies: { '../../outside': '1' } }))
    await expect(recoverModuleFallback(f.home, f.anchor)).rejects.toThrow('Invalid package name')
    expect((await fs.lstat(source)).isDirectory()).toBe(true)
    expect(fs.rename).not.toHaveBeenCalled()
  })

  it('keeps earlier backups and remaining originals when recovery fails part-way', async () => {
    const f = await fixture()
    await packageAt(f.modules, '@deepseek-ai/dsh')
    const second = await packageAt(f.modules, 'ordinary-dependency')
    const actualRename = vi.mocked(fs.rename).getMockImplementation()!
    vi.mocked(fs.rename).mockImplementationOnce(actualRename).mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))
    const backups: string[] = []
    await expect(recoverModuleFallback(f.home, f.anchor, (entry) => backups.push(entry.backup))).rejects.toThrow('existing files were preserved')
    expect(backups).toHaveLength(1)
    expect((await fs.lstat(backups[0]!)).isDirectory()).toBe(true)
    expect((await fs.lstat(second)).isDirectory()).toBe(true)
    expect((await recoverModuleFallback(f.home, f.anchor)).map((entry) => entry.packageName)).toEqual(['ordinary-dependency'])
  })

  it('recognizes only the specific upstream conflict, never arbitrary startup errors', () => {
    expect(isModuleFallbackConflict('dsh: C:\\Users\\user\\.dsh\\profiles\\node_modules\\@deepseek-ai\\dsh exists and is not a symlink or dsh-managed module proxy; remove it so dsh can manage the installation fallback')).toBe(true)
    expect(isModuleFallbackConflict('dsh: /tmp/profiles/node_modules/pkg exists and is not a dsh-managed module proxy; remove it so dsh can manage the installation fallback')).toBe(true)
    for (const text of ['EACCES creating symlink', 'invalid API key', 'exists and is not a directory']) expect(isModuleFallbackConflict(text)).toBe(false)
  })
})
