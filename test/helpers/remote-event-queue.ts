import type { RemoteEvent } from '../../src/gateway/remote-event-protocol.js'

/** Manually driven stream for deterministic disconnect/replay lifecycle tests. */
export class RemoteEventQueue {
  private readonly frames: RemoteEvent[] = []
  private wake: (() => void) | undefined
  private ended = false
  private error: Error | undefined

  push(...frames: RemoteEvent[]): void {
    this.frames.push(...frames)
    this.wake?.()
  }

  close(error?: Error): void {
    this.ended = true
    this.error = error
    this.wake?.()
  }

  async *read(): AsyncGenerator<RemoteEvent> {
    while (true) {
      const frame = this.frames.shift()
      if (frame !== undefined) yield frame
      else if (this.error !== undefined) throw this.error
      else if (this.ended) return
      else await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }
}
