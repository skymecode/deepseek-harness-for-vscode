import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import { pnpmWrapper } from '../../src/runtime/bundled-runtime.js'
import { renderOverlay } from '../../src/runtime/runtime-overlay.js'
import { NodeGatewayClient } from '../../src/gateway/node-gateway-client.js'

interface SmokeOptions {
  readonly home?: string
  readonly historyHome?: string
  readonly officialUi?: boolean
  readonly permissionMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Messages uses the native DeepSeek adapter; the legacy smoke fixtures use pi-ai Chat Completions. */
  readonly protocol?: 'messages' | 'chat-completions'
  /** Seed only this test's temporary home; return extra trusted profile rows if needed. */
  readonly prepare?: (home: string, extensionRoot: string) => Promise<string | void>
}

/** Isolated real Harness, with a loopback-only fake model and no user keys. */
export async function bootSmokeRuntime(modelBaseUrl: string, options: SmokeOptions = {}) {
  const home = options.home ?? await mkdtemp(join(tmpdir(), 'dsh-vscode-smoke-'))
  const extensionRoot = resolve(process.env.DSH_SMOKE_EXTENSION_ROOT ?? '.')
  const gatewayPlugin = process.env.DSH_SMOKE_EXTENSION_ROOT === undefined
    ? join(home, 'gateway-runtime.mjs') : join(extensionRoot, 'dist/runtime/gateway-runtime.mjs')
  if (process.env.DSH_SMOKE_EXTENSION_ROOT === undefined) {
    await build({ entryPoints: ['src/runtime/gateway-runtime-plugin.ts'], outfile: gatewayPlugin, bundle: true, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent' })
  }
  let extraOverlay: string | void
  try { extraOverlay = await options.prepare?.(home, extensionRoot) }
  catch (error) { if (options.home === undefined) await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); throw error }
  const messages = options.officialUi === true || options.protocol === 'messages'
  let overlay = messages ? renderOverlay({
    model: 'deepseek-flash', provider: 'deepseek-official', reasoningEffort: 'high',
    agentPreset: 'minimal', permissionMode: options.permissionMode ?? 'read-only', webSearch: false,
    autoAttachSelection: false, experimentalAutoEffort: false, worktreeAutoMerge: 'never',
  }, gatewayPlugin, options.historyHome).replace('reasoningEffort: high', `reasoningEffort: high\n    apiKeyEnv: DSH_SMOKE_API_KEY\n    baseURL: ${JSON.stringify(modelBaseUrl)}`) : renderOverlay({
    model: 'deepseek-v4-flash', provider: 'smoke', reasoningEffort: 'high',
    agentPreset: 'minimal', permissionMode: options.permissionMode ?? 'read-only', webSearch: false,
    autoAttachSelection: false, experimentalAutoEffort: false, worktreeAutoMerge: 'never',
  }, gatewayPlugin, options.historyHome).replace('provider: "deepseek-official"', 'provider: "smoke"')
  if (!messages) {
    const baseURL = modelBaseUrl.replace(/\/+$/u, '')
    overlay += `\n- id: llm-pi-ai\n  config:\n    providers:\n      smoke:\n        displayName: Smoke\n        api: openai-completions\n        apiKeyEnv: DSH_SMOKE_API_KEY\n        baseURL: ${JSON.stringify(baseURL)}\n        models:\n          - id: deepseek-v4-flash\n            reasoningEfforts:\n              off: null\n              high: high\n              max: max\n`
  }
  const patch = join(home, 'vscode.patch.yml')
  await writeFile(patch, overlay + (extraOverlay ?? ''))
  const moduleBackups: { packageName: string; original: string; backup: string }[] = []
  // Do not inherit any provider secrets or user DSH profile overrides.
  const env: NodeJS.ProcessEnv = { DSH_HOME: home, DSH_CWD: home, DSH_TELEMETRY_DISABLED: '1', DSH_SMOKE_API_KEY: 'smoke-only' }
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  const node = join(extensionRoot, 'node_modules/node/bin', process.platform === 'win32' ? 'node.exe' : 'node')
  const tooling = join(home, 'runtime-bin')
  await mkdir(tooling, { recursive: true })
  const wrapper = pnpmWrapper(process.platform, { node, pnpm: join(extensionRoot, 'node_modules/pnpm/bin/pnpm.mjs') })
  await writeFile(join(tooling, wrapper.filename), wrapper.content)
  if (wrapper.executable) await chmod(join(tooling, wrapper.filename), 0o755)
  env.DSH_BUNDLED_NODE = node
  env.DSH_BUNDLED_PNPM = join(extensionRoot, 'node_modules/pnpm/bin/pnpm.mjs')
  env.PATH = [tooling, dirname(node), env.PATH].filter(Boolean).join(delimiter)
  const child = spawn(node, [
    join(extensionRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', ...(options.officialUi === true ? ['--no-open'] : []),
  ], { cwd: home, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostics = ''
  let closed = false
  const exit = new Promise<void>((resolveExit) => child.once('exit', () => { closed = true; resolveExit() }))
  const close = async (): Promise<void> => {
    if (!closed) {
      if (process.platform === 'win32' && child.pid) {
        await promisify(execFile)('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }).catch(() => undefined)
      } else child.kill('SIGTERM')
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5_000)
      await exit
      clearTimeout(deadline)
    }
    // Only this test's mkdtemp directory is removed; real Harness homes are untouched.
    if (options.home === undefined) await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 })
  }
  try {
    const url = await new Promise<string>((resolveUrl, reject) => {
      const timer = setTimeout(() => reject(new Error(`Gateway startup timed out: ${diagnostics}`)), 30_000)
      const receive = (data: Buffer): void => {
        diagnostics += data.toString()
        const match = /dsh (?:gateway|web): (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/u.exec(diagnostics)
        if (match?.[1] !== undefined) { clearTimeout(timer); resolveUrl(match[1]) }
      }
      child.stdout.on('data', receive)
      child.stderr.on('data', receive)
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Gateway exited (${code}): ${diagnostics}`)) })
    })
    return { client: new NodeGatewayClient(url), home, url, close, moduleBackups }
  } catch (error) {
    await close()
    throw error
  }
}
