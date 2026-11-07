import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { expect, it, vi } from 'vitest'
import { registerSessionManagement } from '../src/runtime/session-management.js'

it('uses the native log-backed title instead of a stale cache, without resuming', async () => {
  const dispose = vi.fn()
  const query = { observeSession: vi.fn().mockResolvedValue({ cursor: 10, header: { id: 's', cwd: '/repo', agentPreset: 'standard' }, projections: { values: { title: 'stale folder label' } }, [Symbol.dispose]: dispose }),
    readTitle: vi.fn().mockResolvedValue({ title: 'Official title', eventSeq: 5 }) }
  const controller = { resolveAgent: vi.fn() }
  let handler!: (req: IncomingMessage, res: ServerResponse) => void
  registerSessionManagement({ get: key => key === 'sessionQuery' ? query : controller,
    webServer: { register: route => { handler = route.handler } } }, { authorizeIndex: () => true })
  let finish!: (text: string) => void
  const result = new Promise<string>(resolve => { finish = resolve })
  const response = Object.assign(new EventEmitter(), { destroyed: false, writeHead: vi.fn(), end: finish })
  handler({ url: '/api/vscode.session?sessionId=s', method: 'GET', headers: {} } as IncomingMessage, response as unknown as ServerResponse)
  expect(JSON.parse(await result)).toMatchObject({ value: { projectCwd: '/repo', projections: { title: 'Official title' } } })
  expect(query.readTitle).toHaveBeenCalled()
  expect(controller.resolveAgent).not.toHaveBeenCalled()
})
