import { describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => ({ l10n: { t: (value: string) => value } }))

import { handleWorkbenchMessage } from '../src/ui/workbench/view-messages.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('sendPrompt pin snapshot timing', () => {
  it('snapshots pin generations before the first @file await', async () => {
    const order: string[] = []
    const attachmentStarted = deferred<void>()
    const attachmentGate = deferred<readonly never[]>()
    let revision = 1

    const snapshotPins = vi.fn((ids: readonly string[]) => {
      order.push(`snapshot:${revision}`)
      return ids.map((id) => ({ id, revision }))
    })
    const clearPinnedSelections = vi.fn((refs?: readonly { id: string; revision: number }[]) => {
      order.push(`clear:${(refs ?? []).map((ref) => ref.revision).join(',')}`)
    })
    const sendPrompt = vi.fn(async () => { order.push('send') })
    const workspaceFiles = {
      attachments: vi.fn(async () => {
        order.push('attachments:start')
        attachmentStarted.resolve()
        await attachmentGate.promise
        order.push('attachments:end')
        return []
      }),
    }

    const work = handleWorkbenchMessage({
      review: {} as never,
      gateway: { sendPrompt } as never,
      actions: {} as never,
      configuration: { get: () => ({ autoAttachSelection: false }) } as never,
      pluginCenter: {} as never,
      editorSelection: {
        attachment: () => ({ kind: 'selection', file: 'a.ts', text: 'A' }),
        current: () => undefined,
      } as never,
      workspaceFiles: workspaceFiles as never,
      postToHosts: vi.fn(),
      publishState: async () => undefined,
      pinSelection: vi.fn(),
      unpinSelection: vi.fn(),
      snapshotPins,
      clearPinnedSelections,
    }, {
      type: 'sendPrompt',
      text: 'explain',
      context: { selectionIds: ['a'] },
    })

    await attachmentStarted.promise
    // The user repins A while the @file is still being read.
    revision = 2
    attachmentGate.resolve([])
    await work

    expect(order).toEqual(['snapshot:1', 'attachments:start', 'attachments:end', 'send', 'clear:1'])
    expect(clearPinnedSelections).toHaveBeenCalledWith([{ id: 'a', revision: 1 }])
  })
})
