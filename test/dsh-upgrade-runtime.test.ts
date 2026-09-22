import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { SessionPromptRequest } from '../src/gateway/domain-api.js'
import { bootSmokeRuntime } from './helpers/runtime-smoke.js'

describe.runIf(process.env.DSH_RUNTIME_SMOKE === '1')('DSH 0.1.7 official contracts', () => {
  it('installs, toggles and removes a local bundle through the running official plugin manager', async () => {
    const name = 'dsh-vscode-upgrade-fixture'
    let fixture = ''
    let importer = ''
    const runtime = await bootSmokeRuntime('http://127.0.0.1:1', { prepare: async (home, extensionRoot) => {
      importer = join(extensionRoot, 'vendor/plugins/dsh-chat-import-0.6.2.tgz')
      fixture = join(home, 'fixture-bundle')
      await mkdir(fixture)
      await writeFile(join(fixture, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: './index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
      await writeFile(join(fixture, 'index.js'), 'export function apply(ctx) { ctx.provide("vscodeUpgradeFixture", true) }\n')
      await writeFile(join(fixture, 'cordis.patch.yml'), `- op: insert\n  value:\n    id: vscode-upgrade-fixture\n    name: ${name}\n`)
    } })
    try {
      const client = runtime.client
      const installed = await client.pluginInstall(fixture, randomUUID())
      expect(installed, JSON.stringify(installed)).toMatchObject({ application: 'applied' })
      expect((await client.pluginListBundles()).some((bundle) => bundle.name === name)).toBe(true)
      expect(await client.pluginSetEnabled(name, false)).toMatchObject({ application: 'applied' })
      expect(await client.pluginSetEnabled(name, true)).toMatchObject({ application: 'applied' })
      expect(await client.pluginRemove(name)).toMatchObject({ application: 'applied' })
      expect((await client.pluginListBundles()).some((bundle) => bundle.name === name)).toBe(false)
      const imported = await client.pluginInstall(importer, randomUUID())
      expect(imported, JSON.stringify(imported)).toMatchObject({ application: 'applied' })
      expect((await client.discoverImportSessions({ path: fixture })).sessions).toEqual([])
    } finally { await runtime.close() }
  }, 120_000)

  it('uses Messages, disables extra reporting, restores archives and stages files with official receipts', async () => {
    const bodies: Record<string, unknown>[] = []
    const paths: string[] = []
    let workspace = ''
    let toolCalled = false
    const server = createServer(async (request, response) => {
      paths.push(request.url ?? '')
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
      bodies.push(body)
      const tools = (body.tools ?? []) as { name: string }[]
      const call = tools.length > 0 && !toolCalled
      if (call) toolCalled = true
      else if (tools.length > 0) await writeFile(join(workspace, 'example.txt'), 'after\n')
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = (type: string, value: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`)
      event('message_start', { message: { id: 'upgrade', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, usage: { input_tokens: 4, output_tokens: 0 } } })
      if (call) {
        const name = process.platform === 'win32' ? 'pwsh' : 'bash'
        const command = process.platform === 'win32' ? 'Get-Content -LiteralPath example.txt' : 'cat example.txt'
        event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'read-fixture', name, input: {} } })
        event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command, description: 'Read the synthetic fixture' }) } })
      } else {
        event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Messages passed.' } })
      }
      event('content_block_stop', { index: 0 })
      event('message_delta', { delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } })
      event('message_stop', {})
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const runtime = await bootSmokeRuntime(`http://127.0.0.1:${(server.address() as AddressInfo).port}/anthropic`, { protocol: 'messages', permissionMode: 'danger-full-access', prepare: async (home) => {
      workspace = join(home, 'workspace')
      await mkdir(workspace)
      await writeFile(join(workspace, 'example.txt'), 'before\n')
      await promisify(execFile)('git', ['init', workspace], { windowsHide: true })
      await promisify(execFile)('git', ['-C', workspace, 'add', 'example.txt'], { windowsHide: true })
      await promisify(execFile)('git', ['-C', workspace, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-m', 'fixture'], { windowsHide: true })
    } })
    try {
      const client = runtime.client
      const metadata = await client.modelCapabilities('deepseek-official')
      expect(metadata.find((model) => model.id === 'deepseek-flash')?.context?.contextWindow).toBeGreaterThan(0)
      await client.ensureLegacyCodePreset()
      // 0.1.7 removes the old preset-copy endpoint; legacy sessions retain
      // their recorded preset, while new sessions use a declared preset.
      expect((await client.agentPresetList()).presets.some((preset) => preset.id === 'minimal' && !preset.broken)).toBe(true)
      const legacy = await client.sessionCreate({ cwd: workspace, agentPreset: 'minimal' })
      expect(legacy.sessionId).toBeDefined()
      const plugins = await client.pluginListPlugins()
      expect(plugins.length).toBeGreaterThan(0)
      expect(Array.isArray(await client.pluginListBundles())).toBe(true)
      const created = await client.sessionCreate({ cwd: workspace, agentPreset: 'minimal' })
      const sessionId = created.sessionId
      const archived = await client.workspaceArchiveSession({ sessionId })
      expect(archived.archivedSessionIds).toContain(sessionId)
      const restored = await client.workspaceUnarchiveSession({ sessionId })
      expect(restored.archivedSessionIds).not.toContain(sessionId)
      const file = await client.uploadFile(String(sessionId), { name: 'note.txt', data: Buffer.from('Synthetic upload.').toString('base64') })
      expect(file.receiptId).toEqual(expect.any(String))
      expect(file.file).toBeDefined()
      const seen: string[] = []
      let changesSeq: number | undefined
      let ended = false
      for await (const frame of client.sessionFollow({ address: { kind: 'session', sessionId } }, AbortSignal.timeout(20_000))) {
        if (frame.type === 'snapshot') {
          await client.sessionPrompt({ requestId: randomUUID() as SessionPromptRequest['requestId'], sessionId, mode: 'queue', content: [{ type: 'text', text: 'Say Messages passed.' }, { type: 'file', receiptId: file.receiptId }] })
        } else if (frame.type === 'event') {
          seen.push(JSON.stringify(frame.event))
          if (String(frame.event.type) === 'workspace/changes') changesSeq = frame.event.seq
          if (frame.event.type === 'turn/end') ended = true
          if (ended && changesSeq !== undefined) break
        }
      }
      expect(changesSeq, JSON.stringify({ paths, tools: (bodies[0]?.tools as { name: string }[] | undefined)?.map((tool) => tool.name), events: seen.map((value) => JSON.parse(value) as { type: string; data: unknown }).filter((event) => ['tool/call', 'tool/result', 'turn/end'].includes(event.type)) })).toBeDefined()
      const summary = await client.changesSummary(String(sessionId), changesSeq!)
      const fileIndex = summary?.files.findIndex((entry) => entry.path === 'example.txt')
      expect(fileIndex).toBeGreaterThanOrEqual(0)
      const diff = await client.changesDiff(String(sessionId), changesSeq!, fileIndex!)
      expect(diff).toMatchObject({ kind: 'text', hunks: [{ lines: ['-before', '+after'] }] })
      expect(seen.join('\n')).toContain('Messages passed.')
      expect(paths.some((path) => path.endsWith('/v1/messages'))).toBe(true)
      expect(bodies.length).toBeGreaterThan(0)
      for (const body of bodies) {
        expect(JSON.stringify(body)).not.toContain('dsh_session_log')
        expect(JSON.stringify(body)).not.toContain('dsh_plugin_packages')
        expect(JSON.stringify(body)).not.toContain('smoke-only')
      }
      const unauthenticated = await fetch(new URL('/api/vscode.models?provider=deepseek-official', runtime.url))
      expect(unauthenticated.status).toBe(401)
    } finally {
      await runtime.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 45_000)
})
