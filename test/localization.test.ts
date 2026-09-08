import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { AGENT_PRESET_OPTIONS, MODEL_OPTIONS, REASONING_OPTIONS } from '../src/domain/options.js'
import { ENGLISH_WORKBENCH_LABELS } from '../src/domain/workbench-state.js'
import {
  createWebviewTranslator,
  ENGLISH_WEBVIEW_MESSAGES,
  localizeWebviewMessages,
} from '../src/webview/localization.js'

const root = process.cwd()
const manifest = readJson('package.json')
const englishManifest = readStringJson('package.nls.json')
const chineseManifest = readStringJson('package.nls.zh-cn.json')
const chineseBundle = readStringJson('l10n/bundle.l10n.zh-cn.json')

describe('extension localization', () => {
  it('provides English and Simplified Chinese values for every manifest placeholder', () => {
    const keys = manifestPlaceholders(manifest)

    expect(keys.size).toBeGreaterThan(0)
    for (const key of keys) {
      expect(englishManifest[key], `missing English package.nls key: ${key}`).toBeTypeOf('string')
      expect(chineseManifest[key], `missing Chinese package.nls key: ${key}`).toBeTypeOf('string')
    }
  })

  it('provides a Simplified Chinese translation for every Webview message', () => {
    for (const message of Object.values(ENGLISH_WEBVIEW_MESSAGES)) {
      expect(chineseBundle[message], `missing Chinese Webview message: ${message}`).toBeTypeOf('string')
    }
  })

  it('provides Simplified Chinese translations for host and fallback catalog messages', () => {
    const sourceFiles = [
      'src/extension.ts',
      'src/notifications/completion-notifications.ts',
      'src/gateway/harness-gateway-service.ts',
      'src/plugins/plugin-manager.ts',
      'src/plugins/plugin-center-controller.ts',
      'src/runtime/bundled-runtime.ts',
      'src/runtime/web-runtime.ts',
      'src/ui/workbench-view-provider.ts',
      'src/import/session-import-service.ts',
    ]
    const hostMessages = sourceFiles.flatMap((path) => extractL10nMessages(readFileSync(`${root}/${path}`, 'utf8')))
    const catalogMessages = [
      ...Object.values(ENGLISH_WORKBENCH_LABELS),
      ...[...MODEL_OPTIONS, ...REASONING_OPTIONS, ...AGENT_PRESET_OPTIONS]
        .flatMap((option) => [option.label, option.description]),
    ]

    for (const message of [...hostMessages, ...catalogMessages]) {
      expect(chineseBundle[message], `missing Chinese host message: ${message}`).toBeTypeOf('string')
    }
  })

  it('formats localized Webview placeholders without changing unknown placeholders', () => {
    const messages = localizeWebviewMessages((message) => chineseBundle[message] ?? message)
    const translate = createWebviewTranslator({ language: 'zh-cn', messages })

    expect(translate('approvalRequired', { tool: 'bash' })).toBe('需要批准：bash')
    expect(translate('minutesAgo', { count: 3 })).toBe('3 分钟前')
    expect(translate('copyCode')).toContain('{language}')
  })
})

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${root}/${path}`, 'utf8')) as Record<string, unknown>
}

function readStringJson(path: string): Record<string, string> {
  return JSON.parse(readFileSync(`${root}/${path}`, 'utf8')) as Record<string, string>
}

function manifestPlaceholders(value: unknown, keys = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    const match = /^%([^%]+)%$/u.exec(value)
    if (match?.[1] !== undefined) keys.add(match[1])
  } else if (Array.isArray(value)) {
    for (const item of value) manifestPlaceholders(item, keys)
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) manifestPlaceholders(item, keys)
  }
  return keys
}

function extractL10nMessages(source: string): string[] {
  return [...source.matchAll(/vscode\.l10n\.t\(\s*(['"])(.*?)\1/gsu)].map((match) => match[2] ?? '')
}
