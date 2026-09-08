import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
import { spawn } from 'node:child_process'
import { runNotificationCommand } from '../src/notifications/native-notifier.js'

afterEach(() => { vi.useRealTimers(); vi.resetAllMocks() })

function processFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
    kill: vi.fn(),
  })
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
  const abort = new AbortController()
  const task = runNotificationCommand({ executable: '/system/notifier', args: ['fixed'], input: 'payload' }, abort.signal)
  return { child, abort, task }
}

describe('notification process lifetime', () => {
  it('never uses a shell or opens a Windows console; data is written to stdin', async () => {
    const { child, abort, task } = processFixture()
    expect(spawn).toHaveBeenCalledWith('/system/notifier', ['fixed'], {
      shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], signal: abort.signal,
    })
    expect(child.stdin.end).toHaveBeenCalledWith('payload')
    child.emit('close', 0)
    await expect(task).resolves.toBeUndefined()
  })

  it('handles spawn errors and nonzero exits', async () => {
    const first = processFixture()
    first.child.emit('error', new Error('ENOENT'))
    await expect(first.task).rejects.toThrow('ENOENT')
    const second = processFixture()
    // Early stdin closure must not become an uncaught EventEmitter error.
    second.child.stdin.emit('error', new Error('EPIPE'))
    second.child.emit('close', 1)
    await expect(second.task).rejects.toThrow('code 1')
  })

  it('kills a hung notifier after ten seconds', async () => {
    vi.useFakeTimers()
    const { child, task } = processFixture()
    const rejected = expect(task).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(10_000)
    await rejected
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('does not spawn a cancelled notification', async () => {
    const abort = new AbortController()
    abort.abort()
    await runNotificationCommand({ executable: '/system/notifier', args: [] }, abort.signal)
    expect(spawn).not.toHaveBeenCalled()
  })
})
