import { describe, expect, it, vi } from 'vitest'
import type { Model } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import {
  KEYLESS_AUTHORIZATION,
  deepSeekRelayProfile,
} from '../src/services/connection-settings/mapping.js'

/**
 * Regression for the P1 keyless-provider fix. A provider saved with a blank
 * API key produces a profile with no `apiKeyEnv` but an `authorization` header.
 * pi-ai's openai-completions transport (`getClientApiKey`) throws
 * `No API key for provider` when it is given neither an apiKey nor an
 * `authorization` header — so omitting `apiKeyEnv` alone would still break every
 * completion. This drives the transport against the exact profile the service
 * writes, feeding it a local mock endpoint, and asserts the request reaches the
 * endpoint unauthenticated instead of failing credential resolution.
 */

/** The wire profile `deepSeekRelayProfile` writes: model rows, routing and compat. */
interface RelayProfile {
  readonly baseURL: string
  readonly models: readonly Record<string, unknown>[]
  readonly compat: Record<string, unknown>
  readonly headers?: Record<string, string>
}

/** The minimal pi-ai model a keyless relay profile resolves to. */
function modelFor(profile: RelayProfile): Model<'openai-completions'> {
  const first = profile.models[0]!
  return {
    id: String(first.id),
    name: String(first.id),
    api: 'openai-completions',
    provider: 'local-llama',
    baseUrl: profile.baseURL,
    input: ['text'],
    maxTokens: (first.maxTokens as number) ?? 1024,
    contextWindow: (first.contextWindow as number) ?? 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: profile.compat,
    reasoning: false,
  } as unknown as Model<'openai-completions'>
}

/** A loopback OpenAI-compatible streaming response: one chunk, then [DONE]. */
function mockEndpoint() {
  const calls: string[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const response = new Response([
      'data: {"id":"1","object":"chat.completion.chunk","created":1700000000,"model":"llama-3.1-8b","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}',
      '',
      'data: {"id":"1","object":"chat.completion.chunk","created":1700000000,"model":"llama-3.1-8b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    return response
  })
  return { fetch, calls }
}

interface DoneEvent { reason: string; message: unknown }
async function consume(stream: unknown): Promise<DoneEvent | undefined> {
  const iterator = stream as AsyncIterable<unknown>
  let done: DoneEvent | undefined
  for await (const event of iterator) {
    const ev = event as { type: string; reason?: string; message?: unknown; error?: { errorMessage?: string } }
    if (ev.type === 'error') throw new Error(ev.error?.errorMessage ?? 'stream errored')
    if (ev.type === 'done') { done = { reason: ev.reason ?? 'unknown', message: ev.message }; break }
  }
  return done
}

describe('keyless relay transport', () => {
  it('streams to a keyless endpoint with no credential and no apiKey', async () => {
    const profile = deepSeekRelayProfile(
      'Local Llama',
      'http://127.0.0.1:8080/v1',
      undefined, // keyless
      ['llama-3.1-8b'],
    ) as RelayProfile
    // Sanity: the profile is what the service writes for a blank-key provider.
    expect(profile).not.toHaveProperty('apiKeyEnv')
    expect(profile).toHaveProperty('headers', { authorization: KEYLESS_AUTHORIZATION })

    const baseURL = profile.baseURL
    const { fetch, calls } = mockEndpoint()
    const model = modelFor(profile)

    const stream = streamSimple(
      model,
      { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] },
      // Mirror dsh's keyless path: no apiKey, profile headers as options headers.
      { headers: profile.headers!, fetch },
    )
    const done = await consume(stream)
    expect(done?.reason).toBe('stop')

    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe(`${baseURL}/chat/completions`)
  })

  it('omits the placeholder header and credentials when a key is present', () => {
    const profile = deepSeekRelayProfile(
      'PackyCode',
      'https://relay.example.com/v1',
      'PROVIDER_PACKYCODE_API_KEY',
      ['deepseek-v4-flash'],
    )
    expect(profile).toHaveProperty('apiKeyEnv', 'PROVIDER_PACKYCODE_API_KEY')
    expect(profile).not.toHaveProperty('headers')
  })
})
