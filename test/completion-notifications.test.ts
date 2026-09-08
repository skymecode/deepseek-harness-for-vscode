import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeNotification } from '../src/notifications/types.js'

const { settings } = vi.hoisted(() => ({ settings: new Map<string, boolean>() }))
vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: (key: string, fallback: boolean) => settings.get(key) ?? fallback }) },
  l10n: { t: (value: string) => value },
}))
import { CompletionNotifications } from '../src/notifications/completion-notifications.js'

beforeEach(() => settings.clear())
const flush = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)) }

describe('completion notification policy', () => {
  it('defaults to a private, silent OS notification with no conversation content', async () => {
    const show = vi.fn().mockResolvedValue(undefined)
    const service = new CompletionNotifications({ appendLine: vi.fn() }, { show })
    service.complete({ title: 'private project', failed: false })
    await flush()
    expect(show.mock.calls[0]?.[0]).toEqual({ title: 'DeepSeek Harness', message: 'The turn has finished. Return to DeepSeek Harness to view the reply.', sound: false })
    service.dispose()
  })

  it('reads settings live; supports opt-out, safe titles, sound and generic failure text', async () => {
    const show = vi.fn().mockResolvedValue(undefined)
    const service = new CompletionNotifications({ appendLine: vi.fn() }, { show })
    settings.set('enabled', false)
    service.complete({ title: 'hidden', failed: false })
    await flush()
    expect(show).not.toHaveBeenCalled()
    settings.set('enabled', true)
    settings.set('includeConversationTitle', true)
    settings.set('sound', true)
    service.complete({ title: '\u0000hello\u202E\nworld' + 'a'.repeat(200), failed: true })
    await flush()
    const notification = show.mock.calls[0]?.[0] as NativeNotification
    expect(notification.sound).toBe(true)
    expect(notification.message).toContain('The turn failed.')
    expect(notification.message.split('\n')[0]).toHaveLength(100)
    expect(notification.message).not.toContain('\u202E')
    service.dispose()
  })

  it('serializes concurrent completions and survives an OS denial without an in-window fallback', async () => {
    const show = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined)
    const appendLine = vi.fn()
    const service = new CompletionNotifications({ appendLine }, { show })
    service.complete({ title: 'a', failed: false })
    service.complete({ title: 'b', failed: false })
    await flush()
    expect(show).toHaveBeenCalledTimes(2)
    expect(appendLine).toHaveBeenCalledWith('[notifications] denied')
    service.dispose()
  })

  it('cancels pending work on disposal', async () => {
    const show = vi.fn().mockResolvedValue(undefined)
    const service = new CompletionNotifications({ appendLine: vi.fn() }, { show })
    service.complete({ title: 'a', failed: false })
    service.dispose()
    await flush()
    expect(show).not.toHaveBeenCalled()
  })

  it('allows an explicit test with notifications disabled', async () => {
    settings.set('enabled', false)
    const show = vi.fn().mockResolvedValue(undefined)
    const service = new CompletionNotifications({ appendLine: vi.fn() }, { show })
    await service.test()
    expect(show.mock.calls[0]?.[0].message).toContain('System notifications are ready')
    service.dispose()
  })
})
