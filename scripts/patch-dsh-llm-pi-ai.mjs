import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const packageJsonPath = require.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json')
const packageRoot = dirname(packageJsonPath)
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))

const SUPPORTED_VERSIONS = ['0.1.6-alpha.2', '0.1.7-alpha.1']

if (!SUPPORTED_VERSIONS.includes(packageJson.version)) {
  throw new Error(
    `Unsupported @deepseek-ai/dsh-llm-pi-ai version ${packageJson.version}; `
      + 'review whether the connection probing patch are still required.',
  )
}

async function patchFile(relativePath, replacements) {
  const path = join(packageRoot, relativePath)
  let source = await readFile(path, 'utf8')
  let changed = false

  for (const { candidates, label } of replacements) {
    if (candidates.some(({ after }) => source.includes(after))) continue
    const matches = candidates.filter(({ before }) => source.split(before).length - 1 === 1)
    if (matches.length !== 1) {
      throw new Error(
        `Cannot apply ${label} to ${relativePath}: expected one matching source block across `
          + `${candidates.length} candidate(s), found ${matches.length}.`,
      )
    }
    source = source.replace(matches[0].before, matches[0].after)
    changed = true
  }

  if (changed) await writeFile(path, source, 'utf8')
  return changed
}

// Official pi-ai now provides requiresReasoningContentOnAssistantMessages.
// The extension only retains endpoint probing: upstream provider discovery
// returns cached models without testing a supplied endpoint, and no public
// API can probe with a saved write-only credential otherwise.
const runtimeChanged = await patchFile('lib/index.js', [
  {
    label: 'explicit endpoint connection probe',
    candidates: [{
      before: `\tif (request.provider !== void 0) {
\t\tconst installed = catalogModels(request.provider);`,
      after: `\t// A provider-only discovery is a catalog lookup. Supplying baseURL is an
\t// explicit connection probe: reach the endpoint and let storedApiKey resolve
\t// the route's write-only credential instead of returning a cached catalog.
\tif (request.provider !== void 0 && request.baseURL === void 0) {
\t\tconst installed = catalogModels(request.provider);`,
    }],
  },
])

if (runtimeChanged) {
  process.stdout.write('Patched @deepseek-ai/dsh-llm-pi-ai explicit endpoint connection probing.\n')
}
