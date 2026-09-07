import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { renderOverlay } from '../../src/runtime/runtime-overlay.js'
import { NodeGatewayClient } from '../../src/gateway/node-gateway-client.js'

/** Isolated real Harness, with a loopback-only fake model and no user keys. */
export async function bootSmokeRuntime(modelBaseUrl: string) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vscode-smoke-'))
  const extensionRoot = resolve(process.env.DSH_SMOKE_EXTENSION_ROOT ?? '.')
  const gatewayPlugin = process.env.DSH_SMOKE_EXTENSION_ROOT === undefined
    ? join(home, 'gateway-runtime.mjs') : join(extensionRoot, 'dist/runtime/gateway-runtime.mjs')
  if (process.env.DSH_SMOKE_EXTENSION_ROOT === undefined) {
    await build({ entryPoints: ['src/runtime/gateway-runtime-plugin.ts'], outfile: gatewayPlugin, bundle: true, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent' })
  }
  const overlay = renderOverlay({
    model: 'deepseek-v4-flash', provider: 'deepseek-official', reasoningEffort: 'high',
    agentPreset: 'minimal', permissionMode: 'read-only', webSearch: false,
    autoAttachSelection: false, experimentalAutoEffort: false, worktreeAutoMerge: 'never',
  }, gatewayPlugin).replace('reasoningEffort: high', `reasoningEffort: high\n    apiKeyEnv: DSH_SMOKE_API_KEY\n    baseURL: ${JSON.stringify(modelBaseUrl)}`)
  const patch = join(home, 'vscode.patch.yml')
  await writeFile(patch, overlay)
  // Do not inherit any provider secrets or user DSH profile overrides.
  const env: NodeJS.ProcessEnv = { DSH_HOME: home, DSH_CWD: home, DSH_TELEMETRY_DISABLED: '1', DSH_SMOKE_API_KEY: 'smoke-only' }
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  const child = spawn(join(extensionRoot, 'node_modules/node/bin', process.platform === 'win32' ? 'node.exe' : 'node'), [
    join(extensionRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0',
  ], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostics = ''
  let closed = false
  const exit = new Promise<void>((resolveExit) => child.once('exit', () => { closed = true; resolveExit() }))
  const close = async (): Promise<void> => {
    if (!closed) {
      child.kill('SIGTERM')
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5_000)
      await exit
      clearTimeout(deadline)
    }
    // Only this test's mkdtemp directory is removed; real Harness homes are untouched.
    await rm(home, { recursive: true, force: true })
  }
  try {
    const url = await new Promise<string>((resolveUrl, reject) => {
      const timer = setTimeout(() => reject(new Error(`Gateway startup timed out: ${diagnostics}`)), 30_000)
      const receive = (data: Buffer): void => {
        diagnostics += data.toString()
        const match = /dsh gateway: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/u.exec(diagnostics)
        if (match?.[1] !== undefined) { clearTimeout(timer); resolveUrl(match[1]) }
      }
      child.stdout.on('data', receive)
      child.stderr.on('data', receive)
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Gateway exited (${code}): ${diagnostics}`)) })
    })
    return { client: new NodeGatewayClient(url), home, url, close }
  } catch (error) {
    await close()
    throw error
  }
}
