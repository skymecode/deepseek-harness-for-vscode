import { expandAssistantStream, type AssistantStreamRecord, type TimedStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { SessionAssistantStreamBaseline, SessionAssistantStreamFrame } from '@deepseek-ai/dsh-api-session-controller/types'
import type { HistoryEntry, PresentationChunkEvent } from './gateway-wire.js'

interface Attempt {
  readonly id: string
  readonly startedAfterSeq: number
  readonly turn: number
  readonly step: number
  readonly entries: HistoryEntry[]
  nextIndex: number
}

/**
 * Process-local V2 stream state. Durable seqs and stream revisions are separate
 * clocks: mixing them corrupts pagination and drops deltas after reconnects.
 */
export class AssistantStreamState {
  private revision = 0
  private attempt: Attempt | undefined

  reset(baseline?: SessionAssistantStreamBaseline): void {
    this.attempt = undefined
    this.revision = baseline?.revision ?? 0
    const active = baseline?.activeAttempt
    if (active === undefined) return
    const chunks = expandAssistantStream(active.stream as unknown as AssistantStreamRecord[])
    if (chunks.length !== active.nextIndex) throw new Error('Assistant stream baseline index mismatch.')
    this.attempt = {
      id: String(active.attemptId),
      startedAfterSeq: active.startedAfterSeq,
      turn: active.turn,
      step: active.step,
      nextIndex: active.nextIndex,
      entries: chunks.map((chunk) => presentationChunk(active.startedAfterSeq + 0.5, active.turn, active.step, chunk)),
    }
  }

  accept(frame: SessionAssistantStreamFrame): void {
    // A fresh attached Agent starts its own revision clock at one.
    if (frame.type === 'start' && frame.revision === 1 && String(frame.attemptId) !== this.attempt?.id) this.reset()
    if (frame.revision <= this.revision) return
    if (frame.revision !== this.revision + 1) throw new Error('Assistant stream revision gap; reopen follow for a baseline.')
    this.revision = frame.revision
    if (frame.type === 'start') {
      this.attempt = { id: String(frame.attemptId), startedAfterSeq: frame.startedAfterSeq, turn: frame.turn, step: frame.step, nextIndex: 0, entries: [] }
      return
    }
    const attempt = this.attempt
    // The durable settlement can arrive before the process-local end marker.
    if (frame.type === 'end' && attempt === undefined) return
    if (attempt === undefined || attempt.id !== String(frame.attemptId) || attempt.nextIndex !== frame.index) {
      throw new Error('Assistant stream attempt/index mismatch; reopen follow for a baseline.')
    }
    if (frame.type === 'end') {
      // Keep a committed prefix until its durable message arrives, preventing
      // a one-frame disappearance if transport order changes. Abandoned
      // attempts have no durable message and must disappear immediately.
      if (frame.outcome.kind === 'abandoned') this.attempt = undefined
      return
    }
    const chunks = expandAssistantStream([{ type: 'chunk', time: frame.time, chunk: frame.chunk } as AssistantStreamRecord])
    for (const chunk of chunks) attempt.entries.push(presentationChunk(attempt.startedAfterSeq + 0.5, attempt.turn, attempt.step, chunk))
    attempt.nextIndex += 1
  }

  settle(event: HistoryEntry['event']): void {
    const attempt = this.attempt
    if (attempt === undefined) return
    if ((event.type === 'assistant/message' || event.type === 'assistant/attempt')
      && event.data.turn === attempt.turn && event.data.step === attempt.step
      && event.seq > attempt.startedAfterSeq) this.attempt = undefined
    if (event.type === 'turn/end' && event.data.turn === attempt.turn) this.attempt = undefined
  }

  entries(): readonly HistoryEntry[] {
    return this.attempt?.entries ?? []
  }
}

const embeddedStreams = new WeakMap<object, readonly HistoryEntry[]>()

/** Decode embedded timing once per durable message, only for UI projection. */
export function presentationHistory(history: readonly HistoryEntry[], live: readonly HistoryEntry[] = []): HistoryEntry[] {
  const result: HistoryEntry[] = []
  for (const entry of history) {
    const event = entry.event
    if (event.type === 'assistant/message' && event.data.stream !== undefined) {
      let chunks = embeddedStreams.get(event)
      if (chunks === undefined) {
        chunks = expandAssistantStream(event.data.stream).map((chunk) => presentationChunk(event.seq, event.data.turn, event.data.step, chunk))
        embeddedStreams.set(event, chunks)
      }
      for (const chunk of chunks) result.push(chunk)
    }
    result.push(entry)
  }
  for (const chunk of live) result.push(chunk)
  return result
}

function presentationChunk(seq: number, turn: number, step: number, value: TimedStreamChunk): { readonly event: PresentationChunkEvent } {
  return { event: { type: 'assistant/chunk', seq, time: value.time, data: { turn, step, chunk: value.chunk } } }
}
