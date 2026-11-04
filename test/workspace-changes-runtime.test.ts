import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { SessionPromptRequest } from '../src/gateway/domain-api.js'
import { bootSmokeRuntime } from './helpers/runtime-smoke.js'

const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', ['-C', cwd, ...args], { windowsHide: true })

describe.runIf(process.env.DSH_RUNTIME_SMOKE === '1')('official workspace changes end to end', () => {
  it.each([true, false])('records native shell/file edits with git=%s and expires them on Host restart', async repository => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-changes-runtime-'))
    // Non-repository captures under the OS temp directory are deliberately excluded by DSH.
    const workspace = await mkdtemp(join(homedir(), '.dsh-changes-fixture-'))
    const shell = process.platform === 'win32'
      ? { name: 'pwsh', input: { command: "[IO.File]::WriteAllText((Join-Path $PWD.Path 'shell.txt'), \"shell-after`n\")", description: 'Modify the synthetic shell fixture' } }
      : { name: 'bash', input: { command: "printf 'shell-after\\n' > shell.txt", description: 'Modify the synthetic shell fixture' } }
    const writes = (file: string, content: string) => ({ name: 'write', input: { file_path: join(workspace, file), content } })
    const reads = (file: string) => ({ name: 'read', input: { file_path: join(workspace, file) } })
    const calls = [shell, reads('tool.txt'), writes('tool.txt', 'intermediate\n'), reads('tool.txt'), writes('tool.txt', 'tool-after\n'),
      reads('unchanged.txt'), writes('unchanged.txt', 'temporary\n'), reads('unchanged.txt'), writes('unchanged.txt', 'original\n'),
      writes('ignored.txt', 'captured\n'), writes('binary.dat', 'binary\0after'), writes('large.txt', 'large\n'.repeat(300))]
    let step = 0
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: unknown[] }
      const tool = body.tools?.length ? calls[step++] : undefined
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      event('message_start', { message: { id: randomUUID(), type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], usage: { input_tokens: 5, output_tokens: 0 } } })
      event('content_block_start', { index: 0, content_block: tool ? { type: 'tool_use', id: `change-${step}`, name: tool.name, input: {} } : { type: 'text', text: '' } })
      event('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text: 'Changes finished.' } })
      event('content_block_stop', { index: 0 })
      event('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } })
      event('message_stop', {})
      response.end()
    })
    let runtime: Awaited<ReturnType<typeof bootSmokeRuntime>> | undefined
    try {
      await Promise.all(Object.entries({ 'shell.txt': 'shell-before\n', 'tool.txt': 'tool-before\n', 'unchanged.txt': 'original\n', 'dirty.txt': 'committed\n', '.gitignore': 'ignored.txt\n' }).map(([path, contents]) => writeFile(join(workspace, path), contents)))
      if (repository) {
        await git(workspace, 'init')
        await git(workspace, 'config', 'core.autocrlf', 'false')
        await git(workspace, 'add', '.')
        await git(workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture')
      }
      await writeFile(join(workspace, 'dirty.txt'), 'pre-existing user edit\n')
      const indexBefore = repository ? await readFile(join(workspace, '.git/index')) : undefined
      await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
      const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/anthropic`
      const options = { home, protocol: 'messages' as const, permissionMode: 'danger-full-access' as const,
        prepare: async () => '\n- id: workspace-changes\n  config:\n    maxFileBytes: 1024\n',
      }
      runtime = await bootSmokeRuntime(endpoint, options)
      const { client } = runtime
      const { sessionId } = await client.sessionCreate({ cwd: workspace, agentPreset: 'standard' })
      let seq: number | undefined
      const failures: unknown[] = []
      for await (const frame of client.sessionFollow({ address: { kind: 'session', sessionId } }, AbortSignal.timeout(30_000))) {
        if (frame.type === 'snapshot') await client.sessionPrompt({ sessionId, requestId: randomUUID() as SessionPromptRequest['requestId'], mode: 'queue', content: [{ type: 'text', text: 'Edit only the synthetic fixtures.' }] })
        if (frame.type !== 'event') continue
        const data = frame.event.data as { error?: unknown }
        if (frame.event.type === 'tool/result' && data.error) failures.push(data.error)
        if (frame.event.type === 'workspace/changes') seq = frame.event.seq
        if (frame.event.type === 'turn/end') break
      }
      expect(failures).toEqual([])
      expect(seq).toBeDefined()
      const summary = await client.changesSummary(String(sessionId), seq!)
      const paths = summary?.files.map(file => file.path).sort()
      expect(paths).toEqual(['binary.dat', 'ignored.txt', 'large.txt', 'tool.txt', ...(repository ? ['shell.txt'] : [])].sort())
      expect(summary?.files.find(file => file.path === 'tool.txt')).toMatchObject({ added: 1, deleted: 1 })
      expect(summary?.files.find(file => file.path === 'binary.dat')?.binary).toBe(true)
      const toolIndex = summary!.files.findIndex(file => file.path === 'tool.txt')
      const diff = await client.changesDiff(String(sessionId), seq!, toolIndex)
      expect(diff).toMatchObject({ kind: 'text', hunks: [{ lines: ['-tool-before', '+tool-after'] }] })
      if (repository) {
        expect(await client.changesDiff(String(sessionId), seq!, summary!.files.findIndex(file => file.path === 'shell.txt'))).toMatchObject({ kind: 'text', hunks: [{ lines: ['-shell-before', '+shell-after'] }] })
        expect(await readFile(join(workspace, '.git/index'))).toEqual(indexBefore)
      }
      expect(await client.changesDiff(String(sessionId), seq!, summary!.files.findIndex(file => file.path === 'large.txt'))).toMatchObject({ kind: 'oversized' })
      await writeFile(join(workspace, 'tool.txt'), 'changed after turn\n')
      expect(await client.changesDiff(String(sessionId), seq!, toolIndex)).toEqual(diff)
      expect(await readFile(join(workspace, 'dirty.txt'), 'utf8')).toBe('pre-existing user edit\n')
      const unauthorized = await fetch(new URL(`/api/changes.summary?sessionId=${sessionId}&seq=${seq}`, runtime.url))
      expect(unauthorized.status).toBe(401)
      await runtime.close()
      runtime = await bootSmokeRuntime(endpoint, options)
      expect(await runtime.client.changesSummary(String(sessionId), seq!)).toBeUndefined()
      expect(await runtime.client.changesDiff(String(sessionId), seq!, toolIndex)).toBeUndefined()
    } finally {
      await runtime?.close()
      server.closeAllConnections()
      await new Promise<void>(done => server.close(() => done()))
      await Promise.all([home, workspace].map(path => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 })))
    }
  }, 90_000)
})
