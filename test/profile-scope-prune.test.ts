import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { pruneShadowedRuntimePackages } from '../src/runtime/profile-scope-prune.js'

let root = ''

async function setup(): Promise<{ profileScope: string, bundledScope: string }> {
  root = await mkdtemp(path.join(tmpdir(), 'profile-scope-prune-'))
  const profileScope = path.join(root, 'profile', 'node_modules', '@deepseek-ai')
  const bundledScope = path.join(root, 'bundled', 'node_modules', '@deepseek-ai')
  await mkdir(profileScope, { recursive: true })
  await mkdir(bundledScope, { recursive: true })
  return { profileScope, bundledScope }
}

async function plantPackage(scope: string, name: string, version: string): Promise<void> {
  const directory = path.join(scope, name)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version }))
}

afterEach(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true })
  root = ''
})

describe('pruneShadowedRuntimePackages', () => {
  it('removes profile copies whose version differs from the bundled runtime', async () => {
    const { profileScope, bundledScope } = await setup()
    await plantPackage(profileScope, 'dsh-llm-deepseek', '0.1.0-rc.6')
    await plantPackage(bundledScope, 'dsh-llm-deepseek', '0.1.1-rc.2')
    const lines: string[] = []

    const removed = await pruneShadowedRuntimePackages(profileScope, bundledScope, (line) => lines.push(line))

    expect(removed).toEqual(['dsh-llm-deepseek'])
    expect(lines[0]).toContain('0.1.0-rc.6')
    expect(lines[0]).toContain('Backed up')
    await expect(readVersion(profileScope, 'dsh-llm-deepseek')).resolves.toBeUndefined()
    const backups = (await readdir(path.dirname(profileScope))).filter((name) => name.startsWith('runtime-package-backup-'))
    expect(backups).toHaveLength(1)
    await expect(readVersion(path.join(path.dirname(profileScope), backups[0]!), 'dsh-llm-deepseek')).resolves.toBe('0.1.0-rc.6')
  })

  it('keeps profile copies that match the bundled version or have no bundled counterpart', async () => {
    const { profileScope, bundledScope } = await setup()
    await plantPackage(profileScope, 'dsh-llm-deepseek', '0.1.1-rc.2')
    await plantPackage(bundledScope, 'dsh-llm-deepseek', '0.1.1-rc.2')
    await plantPackage(profileScope, 'dsh-profile-only-plugin', '9.9.9')

    const removed = await pruneShadowedRuntimePackages(profileScope, bundledScope, () => {})

    expect(removed).toEqual([])
    await expect(readVersion(profileScope, 'dsh-llm-deepseek')).resolves.toBe('0.1.1-rc.2')
    await expect(readVersion(profileScope, 'dsh-profile-only-plugin')).resolves.toBe('9.9.9')
  })

  it('ignores a missing or unreadable profile scope directory', async () => {
    const { bundledScope } = await setup()
    const missing = path.join(root, 'nope', '@deepseek-ai')
    await expect(pruneShadowedRuntimePackages(missing, bundledScope, () => {})).resolves.toEqual([])
  })

  it('keeps profile copies whose manifest cannot be read', async () => {
    const { profileScope, bundledScope } = await setup()
    const broken = path.join(profileScope, 'dsh-llm-deepseek')
    await mkdir(broken, { recursive: true })
    await writeFile(path.join(broken, 'package.json'), 'not json')
    await plantPackage(bundledScope, 'dsh-llm-deepseek', '0.1.1-rc.2')

    const removed = await pruneShadowedRuntimePackages(profileScope, bundledScope, () => {})

    expect(removed).toEqual([])
  })
})

async function readVersion(scope: string, name: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(path.join(scope, name, 'package.json'), 'utf8')) as { version?: string }
    return manifest.version
  } catch {
    return undefined
  }
}
