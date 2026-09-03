import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const packageJsonPath = require.resolve('@deepseek-ai/dsh-session-projection-cache/package.json')
const packageRoot = dirname(packageJsonPath)
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))

const SUPPORTED_VERSIONS = ['0.1.2-alpha.4', '0.1.2-rc.1']

if (!SUPPORTED_VERSIONS.includes(packageJson.version)) {
  throw new Error(
    `Unsupported @deepseek-ai/dsh-session-projection-cache version ${packageJson.version}; `
      + 'review whether the legacy checkpoint-identity patch is still required.',
  )
}

// dsh 0.1.2-alpha.4 tightened the session_projcache record schema with two new
// identity fields (isSeeded / inheritedEventCount) without bumping the domain
// version, so per-record stores written by older builds fail validation and the
// whole plugin tree refuses to boot. Records written before session seeding are
// unseeded with an inherited count of 0 — dsh-session restores legacy headers the
// same way (isSeeded ?? false) — so default the two fields at the durable
// boundary. A legacy identity then matches the live header and the cache stays
// usable; worst case a stale row is discarded at read time, costing a tail replay.
const LEGACY_IDENTITY = '\tisSeeded: z$1.boolean(),\n'
  + '\tinheritedEventCount: z$1.number().int().nonnegative().transform(SessionLogOffset)'
const COMPAT_IDENTITY = '\tisSeeded: z$1.boolean().default(false),\n'
  + '\tinheritedEventCount: z$1.number().int().nonnegative().default(0).transform(SessionLogOffset)'
// 0.1.2-rc.1 fixed the schema upstream: both fields became optional and reads
// already fall back (isSeeded ?? false / inheritedEventCount ?? 0), so the
// patch is a no-op there. The marker below is the optional-form identity block.
const FIXED_IDENTITY = 'isSeeded: z$1.boolean().optional(),'

const path = join(packageRoot, 'lib/index.js')
let source = await readFile(path, 'utf8')

if (source.includes(FIXED_IDENTITY)) {
  // Upstream already made the fields optional (0.1.2-rc.1+): nothing to patch.
} else if (!source.includes(COMPAT_IDENTITY)) {
  if (source.split(LEGACY_IDENTITY).length - 1 !== 1) {
    throw new Error(
      'Cannot apply legacy checkpoint-identity patch to lib/index.js: '
        + 'expected exactly one checkpointIdentity source block.',
    )
  }
  source = source.replace(LEGACY_IDENTITY, COMPAT_IDENTITY)
  await writeFile(path, source, 'utf8')
  process.stdout.write('Patched @deepseek-ai/dsh-session-projection-cache legacy checkpoint identity.\n')
}
