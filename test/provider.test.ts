import { describe, expect, it } from 'vitest'
import {
  isDeepSeekOfficialBaseUrl,
  isProviderRouteInUse,
  providerKeyEnv,
  providerRoute,
} from '../src/domain/provider.js'

describe('provider helpers', () => {
  it('recognizes only the official DeepSeek API host', () => {
    expect(isDeepSeekOfficialBaseUrl(undefined)).toBe(true)
    expect(isDeepSeekOfficialBaseUrl('https://api.deepseek.com')).toBe(true)
    expect(isDeepSeekOfficialBaseUrl('https://api.deepseek.com/v1')).toBe(true)
    expect(isDeepSeekOfficialBaseUrl('https://relay.example.com/v1')).toBe(false)
    expect(isDeepSeekOfficialBaseUrl('not a URL')).toBe(false)
  })

  it('derives matching route and credential names', () => {
    expect(providerRoute('My Relay')).toBe('my-relay')
    expect(providerKeyEnv('My Relay')).toBe('PROVIDER_MY_RELAY_API_KEY')
    expect(providerRoute('硅基流动')).toMatch(/^custom-[a-z0-9]+$/)
    expect(providerRoute('硅基流动')).not.toBe(providerRoute('火山方舟'))
  })

  it('blocks removal only for the provider selected by the active session', () => {
    expect(isProviderRouteInUse('relay-a', 'relay-a')).toBe(true)
    expect(isProviderRouteInUse('relay-a', 'relay-b')).toBe(false)
    expect(isProviderRouteInUse('relay-a', undefined)).toBe(false)
    expect(isProviderRouteInUse('relay-a', undefined, true)).toBe(true)
  })
})
