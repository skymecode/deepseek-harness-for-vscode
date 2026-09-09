import { execFile } from 'node:child_process'
import { mkdir, readFile, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { DEFAULT_BUILTIN_PLUGINS } from '../../src/plugins/default-plugins.js'

/** Load the exact shipped archives in an isolated profile, without npm downloads or user plugins. */
export async function prepareVendoredSmokePlugins(home: string, extensionRoot: string): Promise<string> {
  // Plugins resolve their peer imports against the VSIX, just like the real profile loader.
  // Removing the temporary home only removes this link, never the bundled target.
  await symlink(join(extensionRoot, 'node_modules'), join(home, 'node_modules'), 'junction')
  const rows: string[] = []
  for (const plugin of DEFAULT_BUILTIN_PLUGINS) {
    if (plugin.vendoredTarball === undefined) continue
    const directory = join(home, 'vendored', plugin.installedName.replace(/[^a-z0-9-]/giu, '-'))
    await mkdir(directory, { recursive: true })
    await promisify(execFile)('tar', ['-xzf', join(extensionRoot, plugin.vendoredTarball), '-C', directory, '--strip-components=1'])
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { main: string }
    if (plugin.installedName === 'dsh-chat-import') {
      // This plugin's ordinary runtime dependency is installed by pnpm in real
      // profiles. The smoke test uses a pinned dev dependency to remain offline.
      await mkdir(join(directory, 'node_modules'), { recursive: true })
      await symlink(dirname(dirname(createRequire(import.meta.url).resolve('fzstd'))), join(directory, 'node_modules', 'fzstd'), 'junction')
    }
    rows.push(`    - id: smoke-${rows.length}\n      name: ${JSON.stringify(pathToFileURL(join(directory, manifest.main)).href)}`)
  }
  return `\n- insert:\n${rows.join('\n')}\n`
}
