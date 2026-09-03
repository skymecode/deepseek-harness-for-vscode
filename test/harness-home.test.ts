import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => ({
  // Only harnessHomePath touches vscode; the pure migration under test does not.
}))

import { legacyDshSessionsRoot, migrateLegacySessions } from '../src/runtime/harness-home.js'

let tmpRoot: string | undefined

function makeTmp(): string {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'harness-home-test-'))
  return tmpRoot
}

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true })
    tmpRoot = undefined
  }
})

describe('migrateLegacySessions', () => {
  it('copies session dirs from the legacy root into the target root', () => {
    const root = makeTmp()
    const legacy = path.join(root, 'legacy-sessions')
    const target = path.join(root, 'target-sessions')
    const session = path.join(legacy, '--proj--', 'session-abc')
    mkdirSync(session, { recursive: true })
    writeFileSync(path.join(session, 'session.jsonl.zstd'), 'zstd-bytes')

    expect(migrateLegacySessions(legacy, target)).toEqual({ copied: 1, skipped: 0 })
    expect(readFileSync(path.join(target, '--proj--', 'session-abc', 'session.jsonl.zstd'), 'utf8')).toBe('zstd-bytes')
  })

  it('supports plaintext session.jsonl artifacts', () => {
    const root = makeTmp()
    const legacy = path.join(root, 'legacy-sessions')
    const target = path.join(root, 'target-sessions')
    const session = path.join(legacy, '--proj--', 'session-def')
    mkdirSync(session, { recursive: true })
    writeFileSync(path.join(session, 'session.jsonl'), '{"type":"session"}')

    expect(migrateLegacySessions(legacy, target)).toEqual({ copied: 1, skipped: 0 })
    expect(existsSync(path.join(target, '--proj--', 'session-def', 'session.jsonl'))).toBe(true)
  })

  it('is idempotent — a rerun only reports skips and never duplicates', () => {
    const root = makeTmp()
    const legacy = path.join(root, 'legacy-sessions')
    const target = path.join(root, 'target-sessions')
    const session = path.join(legacy, '--proj--', 'session-abc')
    mkdirSync(session, { recursive: true })
    writeFileSync(path.join(session, 'session.jsonl.zstd'), 'zstd-bytes')

    expect(migrateLegacySessions(legacy, target)).toEqual({ copied: 1, skipped: 0 })
    expect(migrateLegacySessions(legacy, target)).toEqual({ copied: 0, skipped: 1 })
    expect(existsSync(path.join(target, '--proj--', 'session-abc', 'session.jsonl.zstd'))).toBe(true)
  })

  it('skips directories without a session artifact', () => {
    const root = makeTmp()
    const legacy = path.join(root, 'legacy-sessions')
    const target = path.join(root, 'target-sessions')
    mkdirSync(path.join(legacy, '--proj--', 'not-a-session'), { recursive: true })
    writeFileSync(path.join(legacy, '--proj--', 'not-a-session', 'notes.txt'), 'nope')
    writeFileSync(path.join(legacy, '--proj--', 'stray-file'), 'nope')

    expect(migrateLegacySessions(legacy, target)).toEqual({ copied: 0, skipped: 0 })
    expect(existsSync(path.join(target, '--proj--', 'not-a-session'))).toBe(false)
  })

  it('does not overwrite an existing target session', () => {
    const root = makeTmp()
    const legacy = path.join(root, 'legacy-sessions')
    const target = path.join(root, 'target-sessions')
    const session = path.join(legacy, '--proj--', 'session-abc')
    mkdirSync(session, { recursive: true })
    writeFileSync(path.join(session, 'session.jsonl.zstd'), 'legacy')
    const existing = path.join(target, '--proj--', 'session-abc')
    mkdirSync(existing, { recursive: true })
    writeFileSync(path.join(existing, 'session.jsonl.zstd'), 'newer')

    expect(migrateLegacySessions(legacy, target)).toEqual({ copied: 0, skipped: 1 })
    expect(readFileSync(path.join(existing, 'session.jsonl.zstd'), 'utf8')).toBe('newer')
  })

  it('preserves file modes of copied artifacts', () => {
    const root = makeTmp()
    const legacy = path.join(root, 'legacy-sessions')
    const target = path.join(root, 'target-sessions')
    const session = path.join(legacy, '--proj--', 'session-abc')
    mkdirSync(session, { recursive: true })
    const artifact = path.join(session, 'session.jsonl.zstd')
    writeFileSync(artifact, 'zstd-bytes')
    chmodSync(artifact, 0o600)

    migrateLegacySessions(legacy, target)
    const stat = require('node:fs').statSync(path.join(target, '--proj--', 'session-abc', 'session.jsonl.zstd'))
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('is a no-op when the legacy root is missing', () => {
    const root = makeTmp()
    expect(migrateLegacySessions(path.join(root, 'missing'), path.join(root, 'target'))).toEqual({ copied: 0, skipped: 0 })
  })

  it('is a no-op when the legacy root is empty', () => {
    const root = makeTmp()
    const legacy = path.join(root, 'legacy-sessions')
    mkdirSync(legacy, { recursive: true })
    expect(migrateLegacySessions(legacy, path.join(root, 'target'))).toEqual({ copied: 0, skipped: 0 })
  })

  it('survives an unreadable legacy project dir without aborting the rest', () => {
    const root = makeTmp()
    const legacy = path.join(root, 'legacy-sessions')
    const target = path.join(root, 'target-sessions')
    const broken = path.join(legacy, '--broken--')
    mkdirSync(broken, { recursive: true })
    chmodSync(broken, 0o000)
    const good = path.join(legacy, '--proj--', 'session-abc')
    mkdirSync(good, { recursive: true })
    writeFileSync(path.join(good, 'session.jsonl.zstd'), 'zstd-bytes')

    try {
      const result = migrateLegacySessions(legacy, target)
      expect(result.copied).toBe(1)
      expect(existsSync(path.join(target, '--proj--', 'session-abc', 'session.jsonl.zstd'))).toBe(true)
    } finally {
      chmodSync(broken, 0o755)
    }
  })

  it('legacyDshSessionsRoot points under the user home', () => {
    expect(legacyDshSessionsRoot()).toMatch(/[\\/]\.dsh[\\/]sessions$/)
  })
})
