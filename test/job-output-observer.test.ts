import { expect, it, vi } from 'vitest'
import type { JobFollowFrame, JobFollowRequest, JobView } from '@deepseek-ai/dsh-api-job-controller/types'
import { JobOutputObserver } from '../src/gateway/job-output-observer.js'

const request = { sessionId: 'session-1', jobId: 'bash-1' } as JobFollowRequest
const job = { id: request.jobId, kind: 'bash', label: 'test', status: 'running', startedAt: 0, output: { total: 6, earliest: 0 } } as JobView

it('resumes from native byte offsets after transport loss and stops at terminal status', async () => {
  const seen: JobFollowRequest[] = []
  const client = { async *jobFollow(input: JobFollowRequest): AsyncGenerator<JobFollowFrame> {
    seen.push(input)
    yield { type: 'opened', job, from: input.from ?? 0 }
    if (seen.length === 1) {
      yield { type: 'output', chunks: [{ at: 0, text: '你好' }], next: 6 }
      throw new Error('socket lost')
    }
    yield { type: 'output', chunks: [{ at: 6, text: ' done' }], next: 11 }
    yield { type: 'status', job: { ...job, status: 'completed' } }
  } }
  const observer = new JobOutputObserver(vi.fn(), 1)
  observer.start(client, request)
  await vi.waitFor(() => expect(observer.viewFor('session-1', 'bash-1')?.outputState).toBe('finished'))
  expect(seen).toEqual([request, { ...request, from: 6 }])
  expect(observer.viewFor('session-1', 'bash-1')).toMatchObject({ outputText: '你好 done', outputLossy: false })
  observer.stop()
})

it('ignores buffered frames from the old session after switching', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const old = { async *jobFollow(): AsyncGenerator<JobFollowFrame> {
    await pending
    yield { type: 'output', chunks: [{ at: 0, text: 'old private output' }], next: 18 }
  } }
  const next = { async *jobFollow(): AsyncGenerator<JobFollowFrame> { yield { type: 'status', job } } }
  const observer = new JobOutputObserver(vi.fn(), 1)
  observer.start(old, request)
  observer.start(next, { ...request, sessionId: 'session-2' as NonNullable<JobFollowRequest['sessionId']> })
  release()
  await vi.waitFor(() => expect(observer.viewFor('session-2', 'bash-1')?.outputState).toBe('finished'))
  expect(observer.viewFor('session-1', 'bash-1')).toBeUndefined()
  expect(observer.viewFor('session-2', 'bash-1')?.outputText).toBe('')
  observer.stop()
})

it('bounds output, signals retained gaps, and does not retry a removed job', async () => {
  const follow = vi.fn(async function* (): AsyncGenerator<JobFollowFrame> {
    yield { type: 'opened', job, from: 500 }
    yield { type: 'output', chunks: [{ at: 500, text: 'x'.repeat(200_050) }], next: 200_550 }
    throw Object.assign(new Error('Job removed'), { code: 'job/not-found' })
  })
  const observer = new JobOutputObserver(vi.fn(), 1)
  observer.start({ jobFollow: follow }, request)
  await vi.waitFor(() => expect(observer.viewFor('session-1', 'bash-1')?.outputState).toBe('error'))
  expect(observer.viewFor('session-1', 'bash-1')?.outputText.length).toBe(200_000)
  expect(observer.viewFor('session-1', 'bash-1')?.outputLossy).toBe(true)
  expect(follow).toHaveBeenCalledTimes(1)
  observer.stop()
})
