import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createWebviewTranslator, localizeWebviewMessages } from '../src/webview/localization.js'
import { retryStatusText, activityPhrases } from '../src/webview/processing-indicator/labels.js'

const english = createWebviewTranslator({ language: 'en', messages: localizeWebviewMessages((text) => text) })
const bundle = JSON.parse(readFileSync(new URL('../l10n/bundle.l10n.zh-cn.json', import.meta.url), 'utf8')) as Record<string, string>
const chinese = createWebviewTranslator({ language: 'zh-cn', messages: localizeWebviewMessages((text) => bundle[text] ?? text) })
const retry = { provider: 'deepseek-official', mode: 'normal' as const, attempt: 2, maxRetries: 5, started: false, code: 'TIMEOUT', delayMs: 2500 }

describe('transcript activity copy', () => {
  it('provides a localized rotating phrase set without changing language at runtime', () => {
    expect(activityPhrases(english)).toEqual(['Working…', 'Pondering…', 'Percolating…', 'Mulling it over…'])
    expect(activityPhrases(chinese)).toEqual(['正在工作…', '思索中…', '酝酿中…', '推敲中…'])
  })

  it('keeps the failure reason, attempt and delay readable in both languages', () => {
    expect(retryStatusText(retry, english)).toBe('Retrying model request timed out (2/5)… · retry in 3s')
    const localized = retryStatusText(retry, chinese)
    expect(localized).toContain('2/5')
    expect(localized).toContain(bundle['model request timed out'])
    expect(localized).not.toContain('Retrying')
  })

  it('drops backoff once a request starts and respects unlimited retry mode', () => {
    expect(retryStatusText({ ...retry, started: true }, english)).not.toContain('retry in')
    expect(retryStatusText({ ...retry, mode: 'always', delayMs: 0 }, english)).toBe('Retrying model request timed out…')
    expect(retryStatusText({ ...retry, code: 'UNKNOWN' }, english)).toContain('model request failed')
  })
})
