import type { JobFollowFrame, JobFollowRequest } from '@deepseek-ai/dsh-api-job-controller/types'

export interface JobOutputView {
  readonly outputText: string
  readonly outputLossy: boolean
  readonly outputState: 'loading' | 'streaming' | 'reconnecting' | 'finished' | 'error'
  readonly outputError?: string
}

interface Observation {
  readonly sessionId: string
  readonly jobId: string
  readonly abort: AbortController
  next?: number
  view: JobOutputView
}

/** One demand-driven observer; DSH owns output offsets and job lifecycle. */
export class JobOutputObserver {
  private current: Observation | undefined

  constructor(private readonly changed: () => void, private readonly retryMs = 800) {}

  viewFor(sessionId: string, jobId: string): JobOutputView | undefined {
    const value = this.current
    return value?.sessionId === sessionId && value.jobId === jobId ? value.view : undefined
  }

  stop(): void {
    this.current?.abort.abort()
    this.current = undefined
  }

  start(client: { jobFollow(request: JobFollowRequest, signal: AbortSignal): AsyncIterable<JobFollowFrame> }, request: JobFollowRequest): void {
    this.stop()
    const current: Observation = {
      sessionId: String(request.sessionId), jobId: String(request.jobId), abort: new AbortController(),
      view: { outputText: '', outputLossy: false, outputState: 'loading' },
    }
    this.current = current
    this.changed()
    void this.run(client, request, current)
  }

  private async run(client: { jobFollow(request: JobFollowRequest, signal: AbortSignal): AsyncIterable<JobFollowFrame> }, request: JobFollowRequest, current: Observation): Promise<void> {
    const signal = current.abort.signal
    while (!signal.aborted) {
      try {
        for await (const frame of client.jobFollow({ ...request, ...(current.next === undefined ? {} : { from: current.next }) }, signal)) {
          if (signal.aborted || this.current !== current) return
          if (frame.type === 'opened') {
            const lost = current.next === undefined ? frame.from > 0 : frame.from > current.next
            current.next = frame.from
            current.view = { ...current.view, outputState: 'streaming', outputLossy: current.view.outputLossy || lost }
          } else if (frame.type === 'output') {
            const combined = current.view.outputText + frame.chunks.map(chunk => chunk.text).join('')
            const text = combined.slice(-200_000)
            current.next = frame.next
            current.view = { outputText: text, outputState: 'streaming', outputLossy: current.view.outputLossy || frame.lossy === true
              || frame.chunks.some(chunk => chunk.gapBefore === true) || text.length < combined.length }
          } else {
            current.view = { ...current.view, outputState: 'finished' }
            this.changed()
            return
          }
          this.changed()
        }
      } catch (cause) {
        if (signal.aborted || this.current !== current) return
        if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'job/not-found') {
          current.view = { ...current.view, outputState: 'error', outputError: cause instanceof Error ? cause.message : 'job/not-found' }
          this.changed()
          return
        }
      }
      if (signal.aborted || this.current !== current) return
      current.view = { ...current.view, outputState: 'reconnecting' }
      this.changed()
      await pauseJobStream(signal, this.retryMs)
    }
  }
}

/** A stream-local retry must not change the whole gateway's connection state. */
export async function pauseJobStream(signal: AbortSignal, ms = 800): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>(resolve => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}
