import { expect, it } from 'vitest'
import { SessionDrafts } from '../src/webview/session-drafts.js'

it('keeps unsent text with its original session and does not revive a sent draft', () => {
  const drafts = new SessionDrafts()
  expect(drafts.select('a', '')).toBe('')
  expect(drafts.select('a', 'typing')).toBeUndefined()
  expect(drafts.select('b', 'draft for a')).toBe('')
  expect(drafts.select('a', 'draft for b')).toBe('draft for a')
  expect(drafts.select('b', '')).toBe('draft for b')
  expect(drafts.select('a', '')).toBe('')
})
