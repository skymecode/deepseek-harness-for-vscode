import { describe, expect, it } from 'vitest'
import { sharedHistoryHome } from '../src/runtime/shared-history/paths.js'
import { canonicalJson, compareHistories } from '../src/runtime/shared-history/compare.js'

describe('shared history path contract', () => {
  it.each([
    ['win32', 'C:\\Users\\Alice', 'C:\\Users\\Alice\\.dsh'],
    ['darwin', '/Users/alice', '/Users/alice/.dsh'],
    ['linux', '/home/alice', '/home/alice/.dsh'],
  ] as const)('uses the official default home on %s without a global CLI', (platform, home, expected) => {
    expect(sharedHistoryHome('', {}, home, platform)).toBe(expected)
  })
  it('honors explicit settings, environment overrides, home expansion and blank overrides', () => {
    expect(sharedHistoryHome('/custom', { DSH_HOME: '/env' }, '/home/u', 'linux')).toBe('/custom')
    expect(sharedHistoryHome('', { DSH_HOME: '/env' }, '/home/u', 'linux')).toBe('/env')
    expect(sharedHistoryHome('~/private dsh', {}, '/home/u', 'linux')).toBe('/home/u/private dsh')
    expect(sharedHistoryHome('', { DSH_HOME: '   ' }, '/home/u', 'linux')).toBe('/home/u/.dsh')
    expect(() => sharedHistoryHome('relative', {}, '/home/u', 'linux')).toThrow('absolute')
  })
})

describe('append-only history comparison', () => {
  const a = { seq: 0, type: 'user/message', data: { text: 'hi' } }
  const b = { seq: 1, type: 'assistant/message', data: { text: 'answer' } }
  it('distinguishes identical, fast-forward, newer-target and diverged logs', () => {
    expect(compareHistories([a], [{ data: a.data, type: a.type, seq: a.seq }])).toBe('equal')
    expect(compareHistories([a, b], [a])).toBe('source-ahead')
    expect(compareHistories([a], [a, b])).toBe('target-ahead')
    expect(compareHistories([a, b], [a, { ...b, data: { text: 'other branch' } }])).toBe('diverged')
    expect(canonicalJson({ z: 1, a: [2, 3] })).toBe('{"a":[2,3],"z":1}')
  })
})
