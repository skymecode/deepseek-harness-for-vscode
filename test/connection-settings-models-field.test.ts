import { describe, expect, it } from 'vitest'
import { parseModelsField } from '../src/webview/connection-settings/component.js'

describe('parseModelsField', () => {
  it('parses bare ids with no context window', () => {
    expect(parseModelsField('deepseek-v4-flash, deepseek-v4-pro')).toEqual({
      ids: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      contextWindows: {},
    })
  })

  it('parses an id:contextSize suffix in raw tokens', () => {
    expect(parseModelsField('gemma-4-12b-heretic:32768')).toEqual({
      ids: ['gemma-4-12b-heretic'],
      contextWindows: { 'gemma-4-12b-heretic': 32_768 },
    })
  })

  it('accepts k/m shorthand suffixes', () => {
    expect(parseModelsField('model-a:32k, model-b:1m, model-c:8K')).toEqual({
      ids: ['model-a', 'model-b', 'model-c'],
      contextWindows: { 'model-a': 32_768, 'model-b': 1_048_576, 'model-c': 8_192 },
    })
  })

  it('mixes ids with and without an explicit size', () => {
    expect(parseModelsField('gpt-oss-20b, gemma-4-12b-heretic:32k')).toEqual({
      ids: ['gpt-oss-20b', 'gemma-4-12b-heretic'],
      contextWindows: { 'gemma-4-12b-heretic': 32_768 },
    })
  })

  it('keeps a colon-qualified id intact when the suffix is not a valid size', () => {
    // `gpt-oss:20b` is an Ollama model name with a tag, not a context size.
    expect(parseModelsField('gpt-oss:20b')).toEqual({
      ids: ['gpt-oss:20b'],
      contextWindows: {},
    })
    expect(parseModelsField('model-a:not-a-number, model-b:0')).toEqual({
      ids: ['model-a:not-a-number', 'model-b:0'],
      contextWindows: {},
    })
  })

  it('deduplicates repeated ids and keeps the latest size override', () => {
    expect(parseModelsField('model-a, model-a:32k')).toEqual({
      ids: ['model-a'],
      contextWindows: { 'model-a': 32_768 },
    })
    // A bare repeat does not discard a size an earlier occurrence set.
    expect(parseModelsField('model-a:32k, model-a')).toEqual({
      ids: ['model-a'],
      contextWindows: { 'model-a': 32_768 },
    })
    expect(parseModelsField('model-a:32k, model-a:16k')).toEqual({
      ids: ['model-a'],
      contextWindows: { 'model-a': 16_384 },
    })
  })

  it('rejects sizes whose scaled token count overflows to non-finite', () => {
    // 350 digits exceed the largest double, so the `m` multiplier overflows to Infinity.
    const oversized = '9'.repeat(350)
    expect(parseModelsField(`model-a:${oversized}m`)).toEqual({
      ids: [`model-a:${oversized}m`],
      contextWindows: {},
    })
  })

  it('rejects values that stay finite on parse but overflow after a k/m multiplier', () => {
    // A 303-digit raw token count parses to a finite double (~2e302, still
    // below Number.MAX_VALUE), but applying a `k`/`m` multiplier pushes the
    // scaled total to Infinity. The size must be dropped and the original
    // token preserved intact as the id (no suffix interpretation).
    const huge = '1' + '0'.repeat(306)
    expect(parseModelsField(`model-a:${huge}m`)).toEqual({
      ids: [`model-a:${huge}m`],
      contextWindows: {},
    })
    expect(parseModelsField(`model-a:${huge}k`)).toEqual({
      ids: [`model-a:${huge}k`],
      contextWindows: {},
    })
  })

  it('splits on commas, spaces, and full-width commas alike', () => {
    expect(parseModelsField('model-a:32k model-b:64k，model-c')).toEqual({
      ids: ['model-a', 'model-b', 'model-c'],
      contextWindows: { 'model-a': 32_768, 'model-b': 65_536 },
    })
  })
})
