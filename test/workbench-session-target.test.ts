import { expect, it, vi } from 'vitest'
vi.mock('vscode', () => ({ l10n: { t: (s: string) => s } }))
import { handleWorkbenchMessage, type WorkbenchMessageContext } from '../src/ui/workbench/view-messages.js'

it('acknowledges stale-session send rejection so the optimistic bubble is removed', async () => {
  const postToHosts = vi.fn()
  const ctx = { gateway: { openSessionId: () => 'b', selectionToken: () => ({ sessionId: 'b', generation: 2 }) }, postToHosts } as unknown as WorkbenchMessageContext
  await expect(handleWorkbenchMessage(ctx, { type: 'sendPrompt', sessionId: 'a', requestId: 'request-a', text: 'only for a' })).rejects.toThrow('selected session changed')
  expect(postToHosts).toHaveBeenCalledWith({ type: 'sendPromptFailed', requestId: 'request-a' })
})
