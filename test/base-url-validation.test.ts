import { describe, expect, it } from 'vitest'
import { validateBaseUrl } from '../src/domain/base-url.js'

describe('validateBaseUrl', () => {
  it('accepts a valid https URL', () => {
    expect(validateBaseUrl('https://api.deepseek.com')).toEqual({ valid: true })
  })

  it('accepts a valid http URL with a port and path', () => {
    expect(validateBaseUrl('http://localhost:11434/v1')).toEqual({ valid: true })
  })

  it('accepts an empty value to mean the Harness default', () => {
    expect(validateBaseUrl('')).toEqual({ valid: true })
    expect(validateBaseUrl('   ')).toEqual({ valid: true })
  })

  it('rejects a value without a scheme', () => {
    expect(validateBaseUrl('api.deepseek.com')).toEqual({ valid: false, reason: 'invalid' })
  })

  it('rejects a malformed value', () => {
    expect(validateBaseUrl('not a url')).toEqual({ valid: false, reason: 'invalid' })
  })

  it('rejects a non-http(s) scheme', () => {
    expect(validateBaseUrl('ftp://api.deepseek.com')).toEqual({ valid: false, reason: 'scheme' })
  })

  it('rejects an http(s) URL without a hostname', () => {
    expect(validateBaseUrl('https://')).toEqual({ valid: false, reason: 'invalid' })
  })
})
