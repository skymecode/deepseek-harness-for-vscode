import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import * as vscode from 'vscode'
import type { BundledRuntimeResolver } from '../runtime/bundled-runtime.js'
import { harnessHomePath } from '../runtime/harness-home.js'
import { prepareModuleFallback } from '../runtime/prepare-module-fallback.js'
import { DEFAULT_BUILTIN_PLUGINS } from './default-plugins.js'
import { isNpmPackageName, normalizePluginSpec } from './plugin-spec.js'
import { RoutingSuiteInstaller } from './routing-suite/installer.js'
import { ROUTING_SUITE_MANIFEST } from './routing-suite/manifest.js'
import type { InstalledDshPlugin } from './types.js'

const PROFILE = 'web'
const DEFAULT_PLUGINS_SEED_FILE = 'default-plugins-seeded.json'
const DEFAULT_PLUGINS_SEED_VERSION = 2
const MAX_ERROR_OUTPUT = 12_000

/** Manages the exact `web` profile booted by this extension through DSH's CLI. */
export class DshPluginManager {
  private readonly routingSuite: RoutingSuiteInstaller

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly resolver: BundledRuntimeResolver,
    private readonly output: vscode.OutputChannel,
  ) {
    this.routingSuite = new RoutingSuiteInstaller(this.harnessHome(), {
      installPackage: async (spec) => { await this.run(['add', spec]) },
      removePackage: async (name) => { await this.run(['remove', name]) },
    })
  }

  async listInstalled(): Promise<readonly InstalledDshPlugin[]> {
    const profileDir = this.profileDirectory()
    const profile = await readJson(path.join(profileDir, 'package.json'))
    if (!isRecord(profile)) return []
    const dependencies = stringRecord(profile.dependencies)
    const dsh = isRecord(profile.dsh) ? profile.dsh : undefined
    const profileConfig = dsh !== undefined && isRecord(dsh.profile) ? dsh.profile : undefined
    const bundles = profileConfig !== undefined && Array.isArray(profileConfig.bundles)
      ? profileConfig.bundles.filter((value): value is string => typeof value === 'string')
      : []
    const installed = await Promise.all(bundles.map(async (name): Promise<InstalledDshPlugin | undefined> => {
      const source = dependencies[name]
      if (source === undefined || !isNpmPackageName(name)) return undefined
      const manifest = await readJson(path.join(profileDir, 'node_modules', ...name.split('/'), 'package.json'))
      if (!isRecord(manifest)) return { name, version: source, source, includesWebClient: false }
      const repositoryUrl = repositoryOf(manifest.repository)
      const manifestDsh = isRecord(manifest.dsh) ? manifest.dsh : undefined
      return {
        name,
        version: typeof manifest.version === 'string' ? manifest.version : source,
        source,
        ...(typeof manifest.description === 'string' ? { description: manifest.description } : {}),
        ...(repositoryUrl === undefined ? {} : { repositoryUrl }),
        includesWebClient: manifestDsh !== undefined && isRecord(manifestDsh.client),
      }
    }))
    const defaultNames = new Set(DEFAULT_BUILTIN_PLUGINS.map((plugin) => plugin.installedName))
    const resolved = installed
      .filter((item): item is InstalledDshPlugin => item !== undefined)
      .map((item) => defaultNames.has(item.name) ? { ...item, source: 'built-in' } : item)
    const suite = await this.routingSuite.status(dependencies)
    if (suite !== undefined) {
      const withoutManagedInjector = resolved.filter((item) => item.name !== suite.injectorName)
      withoutManagedInjector.push({
        name: ROUTING_SUITE_MANIFEST.installedName,
        version: suite.version,
        source: 'built-in managed suite',
        description: 'Super Injector with Router Standard and Router Spec presets.',
        repositoryUrl: ROUTING_SUITE_MANIFEST.repositoryUrl,
        includesWebClient: true,
      })
      return withoutManagedInjector.sort((left, right) => left.name.localeCompare(right.name))
    }
    return resolved.sort((left, right) => left.name.localeCompare(right.name))
  }

  /** Installs missing default plugins, including newly added built-ins after a seed bump. */
  async ensureDefaultPlugins(): Promise<void> {
    if (await this.defaultPluginsSeedVersion() >= DEFAULT_PLUGINS_SEED_VERSION) return
    const installed = await this.listInstalled()
    const installedNames = new Set(installed.map((item) => item.name))
    for (const plugin of DEFAULT_BUILTIN_PLUGINS) {
      if (installedNames.has(plugin.installedName) || (plugin.npmPackage !== undefined && installedNames.has(plugin.npmPackage))) continue
      // The managed routing suite already provides the Super Injector.
      if (plugin.installedName === ROUTING_SUITE_MANIFEST.injector.name && installedNames.has(ROUTING_SUITE_MANIFEST.installedName)) continue
      if (plugin.vendoredTarball !== undefined) {
        await this.installVendored(plugin.vendoredTarball)
      } else {
        await this.install(plugin.installSpec)
      }
    }
    await this.markDefaultPluginsSeeded()
  }

  /** Marker-only check (no process spawn): whether default seeding is still pending. */
  async hasPendingDefaultPluginsSeed(): Promise<boolean> {
    return await this.defaultPluginsSeedVersion() < DEFAULT_PLUGINS_SEED_VERSION
  }

  /**
   * Installs a plugin bundled inside the VSIX from a local tarball, so a
   * first run never waits on GitHub/npm downloads. pnpm resolves relative
   * tarball arguments against the process working directory, so the pnpm
   * invocation is spawned with cwd inside the profile and handed a
   * space-free "./vendor/..." spec (the extension's spec guard rejects
   * whitespace, and the harness home on macOS contains spaces). pnpm records
   * the resolved absolute file path, which lives inside the profile and
   * therefore survives extension updates.
   */
  private async installVendored(vendoredTarball: string): Promise<void> {
    const source = path.join(this.context.extensionUri.fsPath, vendoredTarball)
    const profileDir = path.join(this.harnessHome(), 'profiles', PROFILE)
    const vendorDir = path.join(profileDir, 'vendor')
    await mkdir(vendorDir, { recursive: true })
    const filename = path.basename(source)
    await copyFile(source, path.join(vendorDir, filename))
    await this.run(['add', './vendor/' + filename], profileDir)
  }

  async install(value: string): Promise<readonly InstalledDshPlugin[]> {
    if (this.routingSuite.matches(value)) {
      const dependencies = await this.profileDependencies()
      await this.routingSuite.install(dependencies[ROUTING_SUITE_MANIFEST.injector.name] !== undefined)
      return await this.listInstalled()
    }
    let spec: string
    try {
      spec = normalizePluginSpec(value)
    } catch {
      throw new Error(vscode.l10n.t('Invalid DSH plugin package specification.'))
    }
    await this.run(['add', spec])
    return await this.listInstalled()
  }

  async remove(name: string): Promise<readonly InstalledDshPlugin[]> {
    if (name === ROUTING_SUITE_MANIFEST.installedName) {
      await this.routingSuite.remove()
      return await this.listInstalled()
    }
    if (!isNpmPackageName(name)) throw new Error(vscode.l10n.t('Invalid DSH plugin package name.'))
    const installed = await this.listInstalled()
    if (!installed.some((item) => item.name === name)) throw new Error(vscode.l10n.t('DSH plugin is not installed: {0}', name))
    await this.run(['remove', name])
    return await this.listInstalled()
  }

  private async run(pnpmArguments: readonly string[], cwd = workspaceDirectory()): Promise<void> {
    const launch = await this.resolver.resolve()
    const args = [...launch.args, 'plugin', '--profile', PROFILE, ...pnpmArguments]
    const env = { ...launch.environment, DSH_HOME: this.harnessHome() }
    await prepareModuleFallback(env.DSH_HOME, this.context.asAbsolutePath(path.join('node_modules', '@deepseek-ai', 'dsh', 'package.json')), this.output)
    this.output.appendLine(`[plugin] dsh plugin --profile ${PROFILE} ${pnpmArguments.map(diagnosticArgument).join(' ')}`)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(launch.command, args, {
        cwd,
        env,
        windowsHide: true,
      })
      let diagnostics = ''
      const collect = (chunk: Buffer | string): void => {
        const content = String(chunk)
        this.output.append(content)
        diagnostics = (diagnostics + content).slice(-MAX_ERROR_OUTPUT)
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        if (code === 0) resolve()
        else reject(new Error(vscode.l10n.t('DSH plugin command failed (code={code}, signal={signal}): {detail}', {
          code: String(code),
          signal: String(signal),
          detail: lastMeaningfulLines(diagnostics),
        })))
      })
    })
  }

  private harnessHome(): string {
    return harnessHomePath(this.context)
  }

  private profileDirectory(): string {
    return path.join(this.harnessHome(), 'profiles', PROFILE)
  }

  private async profileDependencies(): Promise<Record<string, string>> {
    const profile = await readJson(path.join(this.profileDirectory(), 'package.json'))
    return isRecord(profile) ? stringRecord(profile.dependencies) : {}
  }

  private async defaultPluginsSeedVersion(): Promise<number> {
    const raw = await readJson(path.join(this.harnessHome(), DEFAULT_PLUGINS_SEED_FILE))
    if (!isRecord(raw)) return 0
    return typeof raw.version === 'number' ? raw.version : 1
  }

  private async markDefaultPluginsSeeded(): Promise<void> {
    await writeFile(
      path.join(this.harnessHome(), DEFAULT_PLUGINS_SEED_FILE),
      `${JSON.stringify({ version: DEFAULT_PLUGINS_SEED_VERSION })}\n`,
      'utf8',
    )
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function repositoryOf(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value : isRecord(value) && typeof value.url === 'string' ? value.url : undefined
  if (raw === undefined) return undefined
  const normalized = raw.replace(/^git\+/u, '').replace(/\.git$/u, '')
  try {
    const url = new URL(normalized)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function lastMeaningfulLines(value: string): string {
  const lines = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  return lines.slice(-8).join('\n') || 'No diagnostic output.'
}

/** Avoids persisting credentials embedded in custom tarball URLs to logs. */
function diagnosticArgument(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return value
    url.username = ''
    url.password = ''
    url.search = ''
    return url.toString()
  } catch {
    return value
  }
}

function workspaceDirectory(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
