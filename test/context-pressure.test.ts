import { describe, expect, it } from 'vitest'

import { contextUsage, projectionContextPressure } from '../src/domain/context-pressure.js'
import { percentageLabel } from '../src/webview/context-meter/component.js'

describe('context pressure', () => {
  it('prefers projected tokens so compaction changes occupancy immediately', () => {
    const pressure = projectionContextPressure({
      contextWindow: 1_000_000,
      pressureTokens: 420_000,
      projectedTokens: 180_000,
    })

    expect(pressure).toEqual({
      contextWindow: 1_000_000,
      pressureTokens: 420_000,
      projectedTokens: 180_000,
    })
    expect(pressure === undefined ? undefined : contextUsage(pressure)).toEqual({
      usedTokens: 180_000,
      contextWindow: 1_000_000,
      percent: 18,
    })
  })

  it('falls back to the latest provider pressure and clamps overflow to 100%', () => {
    const pressure = projectionContextPressure({ contextWindow: 100_000, pressureTokens: 120_000 })
    expect(pressure === undefined ? undefined : contextUsage(pressure).percent).toBe(100)
  })

  it('rejects invalid context projections', () => {
    expect(projectionContextPressure(undefined)).toBeUndefined()
    expect(projectionContextPressure({ contextWindow: 0 })).toBeUndefined()
    expect(projectionContextPressure({ contextWindow: 100, projectedTokens: -1 })).toBeUndefined()
  })

  it('keeps small non-zero usage visible', () => {
    expect(percentageLabel(0, 0)).toBe('0')
    expect(percentageLabel(0.4, 4_000)).toBe('<1')
    expect(percentageLabel(72.6, 726_000)).toBe('73')
  })

  it('updates occupancy percent when switching to a model with a smaller context window', () => {
    const defaultPressure = projectionContextPressure({
      contextWindow: 262_144,
      projectedTokens: 29_700,
    })
    expect(contextUsage(defaultPressure!).percent).toBeCloseTo(11.33, 1)

    // User switches to a 32k model (e.g. gemma-4-12b:32k)
    const gemmaPressure = { ...defaultPressure!, contextWindow: 32_768 }
    const gemmaUsage = contextUsage(gemmaPressure)
    expect(gemmaUsage.usedTokens).toBe(29_700)
    expect(gemmaUsage.contextWindow).toBe(32_768)
    expect(gemmaUsage.percent).toBeCloseTo(90.63, 1)
    expect(percentageLabel(gemmaUsage.percent, gemmaUsage.usedTokens)).toBe('91')
  })
})
