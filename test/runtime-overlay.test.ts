import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderOverlay } from '../src/runtime/runtime-overlay.js'

const require = createRequire(import.meta.url)
const { load } = require('js-yaml') as { load: (input: string) => unknown }

describe('Harness Web profile overlay', () => {
  it('projects only extension-owned runtime defaults', () => {
    const overlay = renderOverlay({
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      agentPreset: 'ptc',
      provider: 'packycode',
      permissionMode: 'workspace-write',
      webSearch: true,
      autoAttachSelection: true,
      experimentalAutoEffort: false,
      worktreeAutoMerge: 'never',
    }, '/extension/dist/runtime/gateway-runtime.mjs')
    expect(overlay).toContain('id: web-runtime')
    expect(overlay).toContain('disabled: true')
    expect(overlay).toContain('id: vscode-gateway-runtime')
    expect(overlay).toContain(`name: ${JSON.stringify(pathToFileURL('/extension/dist/runtime/gateway-runtime.mjs').href)}`)
    expect(overlay).toContain('reasoningEffort: max')
    expect(overlay).toContain('provider: "packycode"')
    expect(overlay).toContain('model: "deepseek-v4-pro"')
    expect(overlay).toContain('default: ptc')
    expect(overlay).toContain('id: agent-preset-registry')
    expect(overlay).not.toContain('id: agent-presets\n')
    expect(overlay).toContain('id: office-to-pdf')
    expect(overlay).toContain('id: ui-sidebar-documentpreview')
    expect(overlay).toContain('disabled: true')
    expect(overlay).toContain('defaultPreset: workspace-write')
    expect(overlay).not.toContain('llm-pi-ai')
    expect(overlay).not.toContain('web-search-deepseek')
    expect(() => load(overlay)).not.toThrow()
  })

  it('disables the web-search provider when webSearch is off', () => {
    const overlay = renderOverlay({
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      agentPreset: 'standard',
      provider: 'deepseek-official',
      permissionMode: 'workspace-write',
      webSearch: false,
      autoAttachSelection: true,
      experimentalAutoEffort: false,
      worktreeAutoMerge: 'never',
    }, '/extension/dist/runtime/gateway-runtime.mjs')
    const rows = load(overlay) as Array<{ id?: string; disabled?: boolean }>
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'web-search-deepseek', disabled: true }),
    ]))
    expect(() => load(overlay)).not.toThrow()
  })

  it('passes the off reasoning effort through and safely quotes provider ids', () => {
    const overlay = renderOverlay({
      model: 'deepseek-v4-flash',
      reasoningEffort: 'off',
      agentPreset: 'standard',
      provider: 'custom: route',
      permissionMode: 'read-only',
      webSearch: true,
      autoAttachSelection: false,
      experimentalAutoEffort: false,
      worktreeAutoMerge: 'never',
    }, 'C:\\Extensions\\DeepSeek Harness\\gateway-runtime.mjs')
    expect(overlay).toContain('reasoningEffort: off')
    expect(overlay).not.toContain('thinking:')
    expect(overlay).toContain('provider: "custom: route"')
    expect(overlay).toContain('defaultPreset: read-only')
    expect(() => load(overlay)).not.toThrow()
  })
  it('quotes malicious model text and disables both extra-request reporting plugins', () => {
    const model = 'x\n- id: session-log-deepseek\n  config:\n    enabled: true\n# !!js (() => globalThis.pwned = true)()'
    const parsed = load(renderOverlay({ model, provider: 'deepseek-official', reasoningEffort: 'high',
      agentPreset: 'minimal', permissionMode: 'read-only', webSearch: false, autoAttachSelection: false,
      experimentalAutoEffort: false, worktreeAutoMerge: 'never',
    }, '/extension/gateway.mjs')) as { id?: string; config?: Record<string, unknown> }[]
    expect(parsed.find((row) => row.id === 'agent-default-model')?.config?.model).toBe(model)
    for (const id of ['session-log-deepseek', 'plugin-package-inventory-deepseek']) {
      expect(parsed.filter((row) => row.id === id)).toHaveLength(1)
      expect(parsed.find((row) => row.id === id)?.config?.enabled).toBe(false)
    }
  })

})
