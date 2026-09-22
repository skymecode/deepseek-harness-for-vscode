import type {
  ConnectionProviderView,
  ConnectionSettingsState,
  ConnectionTestResult,
} from '../../domain/connection-settings.js'
import { validateBaseUrl } from '../../domain/base-url.js'
import { DEEPSEEK_OFFICIAL_PROVIDER } from '../../domain/provider.js'

interface ConnectionSettingsComponentOptions {
  readonly document: Document
  readonly translate: (key: string, values?: Record<string, string | number>) => string
  readonly post: (type: string, data?: Record<string, unknown>) => void
  readonly onOpen?: () => void
}

export interface ConnectionSettingsComponent {
  open(): void
  close(): void
  update(state: ConnectionSettingsState, selectedProvider: string, activeProvider?: string, experimentalAutoEffort?: boolean): void
  renderTestResult(result: ConnectionTestResult): void
}

/** Connection settings behavior kept out of the webview entrypoint. */
export function createConnectionSettingsComponent(options: ConnectionSettingsComponentOptions): ConnectionSettingsComponent {
  const { document, translate: t, post } = options
  const panel = required<HTMLElement>(document, 'settings-panel')
  const closeButton = required<HTMLButtonElement>(document, 'settings-close')
  const providerSelect = required<HTMLSelectElement>(document, 'settings-provider')
  const name = required<HTMLInputElement>(document, 'settings-name')
  const nameField = required<HTMLElement>(document, 'settings-name-field')
  const protocol = document.getElementById('settings-api') as HTMLSelectElement | null
  const baseUrl = required<HTMLInputElement>(document, 'settings-base-url')
  const baseUrlError = required<HTMLElement>(document, 'settings-base-url-error')
  const apiKey = required<HTMLInputElement>(document, 'settings-api-key')
  const models = required<HTMLInputElement>(document, 'settings-models')
  const modelsField = required<HTMLElement>(document, 'settings-models-field')
  const experimentalAutoEffort = required<HTMLInputElement>(document, 'settings-experimental-auto-effort')
  const openNative = required<HTMLButtonElement>(document, 'settings-open-native')
  const apply = required<HTMLButtonElement>(document, 'settings-apply')
  const remove = required<HTMLButtonElement>(document, 'settings-delete')
  const test = required<HTMLButtonElement>(document, 'settings-test')
  const testResult = required<HTMLElement>(document, 'settings-test-result')

  let state: ConnectionSettingsState = { writable: false, providers: [] }
  let defaultProvider = DEEPSEEK_OFFICIAL_PROVIDER
  let activeProvider: string | undefined
  let confirmingRemove = false
  // Streaming pushes arrive up to every frame while a turn runs. Rebuilding
  // the open panel on each one wipes in-flight edits (the API key field is
  // cleared on every renderFields) and makes the provider select flicker, so
  // updates only repaint when the underlying provider data actually changed.
  let updateSignature = ''

  const selected = (): ConnectionProviderView | undefined => state.providers.find((item) => item.id === providerSelect.value)
  const input = (): Record<string, unknown> => {
    const parsed = parseModelsField(models.value)
    return {
      provider: providerSelect.value,
      name: name.value,
      baseUrl: baseUrl.value,
      api: protocol?.value ?? selected()?.api,
      apiKey: apiKey.value,
      models: parsed.ids,
      modelContextWindows: parsed.contextWindows,
    }
  }

  const resetTest = (): void => {
    test.disabled = false
    test.textContent = t('testConnection')
    testResult.textContent = ''
    testResult.classList.add('hidden')
    testResult.classList.remove('success', 'error', 'warn')
  }

  const validateUrl = (): boolean => {
    const result = validateBaseUrl(baseUrl.value)
    const invalid = !result.valid
    baseUrl.classList.toggle('invalid', invalid)
    baseUrlError.classList.toggle('hidden', !invalid)
    if (invalid) baseUrlError.textContent = result.reason === 'scheme' ? t('baseUrlInvalidScheme') : t('baseUrlInvalid')
    return !invalid
  }

  const renderFields = (): void => {
    const provider = selected()
    const official = providerSelect.value === DEEPSEEK_OFFICIAL_PROVIDER
    const creating = providerSelect.value === '__new__'
    nameField.classList.toggle('hidden', official)
    remove.classList.toggle('hidden', official || creating || provider?.removable !== true)
    remove.disabled = provider === undefined || provider.id === activeProvider
    confirmingRemove = false
    remove.textContent = t('remove')
    remove.classList.remove('danger')
    name.value = provider?.name ?? ''
    name.disabled = !state.writable || (!creating && provider === undefined)
    if (protocol) {
      document.getElementById('settings-api-field')?.classList.toggle('hidden', official)
      const api = provider?.api ?? 'openai-completions'
      if (!Array.from(protocol.options).some((option) => option.value === api)) {
        const option = document.createElement('option'); option.value = api; option.textContent = api; protocol.append(option)
      }
      protocol.value = api
      protocol.disabled = !state.writable || official
    }
    baseUrl.value = provider?.baseUrl ?? (official ? 'https://api.deepseek.com/anthropic' : '')
    // The built-in route is intentionally tied to the native DeepSeek adapter.
    // Every relay endpoint must be added as a custom pi-ai provider.
    baseUrl.disabled = !state.writable || official
    apiKey.value = ''
    apiKey.disabled = !state.writable || (provider !== undefined && !provider.credentialWritable)
    apiKey.placeholder = provider?.apiKeyConfigured === true ? t('apiKeyKeepPlaceholder') : t('apiKeyPlaceholder')
    // Third-party endpoints are addressed by their own model ids, which the
    // user must be able to enter (e.g. a Volcengine Ark model or endpoint).
    modelsField.classList.toggle('hidden', official)
    models.disabled = !state.writable || official
    models.value = (provider?.models.length ?? 0) > 0
      ? formatModelsField(provider!.models, provider!.modelContextWindows)
      : ''
    apply.disabled = !state.writable
    test.classList.toggle('hidden', official)
    baseUrl.classList.remove('invalid')
    baseUrlError.classList.add('hidden')
    resetTest()
  }

  const renderProviders = (keepSelected = false): void => {
    const currentSelected = providerSelect.value
    const fragment = document.createDocumentFragment()
    for (const provider of state.providers) {
      const option = document.createElement('option')
      option.value = provider.id
      option.textContent = provider.name
      fragment.append(option)
    }
    const add = document.createElement('option')
    add.value = '__new__'
    add.textContent = t('addProvider')
    fragment.append(add)
    providerSelect.replaceChildren(fragment)
    if (keepSelected && (currentSelected === '__new__' || state.providers.some((provider) => provider.id === currentSelected))) {
      providerSelect.value = currentSelected
    } else {
      providerSelect.value = state.providers.some((provider) => provider.id === defaultProvider)
        ? defaultProvider
        : DEEPSEEK_OFFICIAL_PROVIDER
    }
    renderFields()
  }

  providerSelect.addEventListener('change', renderFields)
  name.addEventListener('input', resetTest)
  baseUrl.addEventListener('input', () => {
    validateUrl()
    resetTest()
  })
  apiKey.addEventListener('input', resetTest)
  protocol?.addEventListener('change', resetTest)
  experimentalAutoEffort.addEventListener('change', () => {
    post('setExperimentalAutoEffort', { value: experimentalAutoEffort.checked })
  })
  closeButton.addEventListener('click', () => panel.classList.add('hidden'))
  openNative.addEventListener('click', () => post('openSettings'))
  test.addEventListener('click', () => {
    if (!validateUrl()) return
    test.disabled = true
    test.textContent = t('testingConnection')
    testResult.classList.add('hidden')
    post('testConnection', input())
  })
  remove.addEventListener('click', () => {
    const provider = selected()
    if (provider === undefined || remove.disabled) return
    if (!confirmingRemove) {
      confirmingRemove = true
      remove.textContent = t('confirmRemove')
      remove.classList.add('danger')
      return
    }
    confirmingRemove = false
    post('removeProvider', { provider: provider.id })
    panel.classList.add('hidden')
  })
  apply.addEventListener('click', () => {
    if (!validateUrl()) return
    if (providerSelect.value !== DEEPSEEK_OFFICIAL_PROVIDER && name.value.trim() === '') return
    post('applySettings', input())
    panel.classList.add('hidden')
  })
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || panel.classList.contains('hidden')) return
    event.preventDefault()
    panel.classList.add('hidden')
  })
  return {
    open: () => {
      options.onOpen?.()
      // Force one rebuild on open: the signature gate above skips pushes whose
      // data did not change, so the panel may hold stale fields after an edit
      // was applied elsewhere (native settings, apply from another window).
      updateSignature = ''
      renderProviders()
      panel.classList.remove('hidden')
      baseUrl.focus()
    },
    close: () => panel.classList.add('hidden'),
    update: (next, selectedProvider, currentProvider, isExperimentalAutoEffort) => {
      if (typeof isExperimentalAutoEffort === 'boolean') {
        experimentalAutoEffort.checked = isExperimentalAutoEffort
      }
      const nextSignature = JSON.stringify([next, selectedProvider, currentProvider])
      if (nextSignature === updateSignature) return
      updateSignature = nextSignature
      state = next
      defaultProvider = selectedProvider
      activeProvider = currentProvider
      if (!panel.classList.contains('hidden')) renderProviders(true)
      else if (selected() !== undefined) remove.disabled = selected()!.id === activeProvider
    },
    renderTestResult: (result) => {
      // A late test answer mutates fields (adopted model ids, reset button
      // label); the next data push must repaint despite the signature gate.
      updateSignature = ''
      test.disabled = false
      test.textContent = t('testConnection')
      testResult.classList.remove('hidden', 'success', 'error', 'warn')
      if (result.status === 'success') {
        // Adopt the endpoint's advertised model ids into the form so the user
        // doesn't have to type them by hand; they can still edit afterwards.
        if (result.models !== undefined && result.models.length > 0 && !models.disabled) {
          models.value = result.models.map((model) => model.contextWindow === undefined
            ? model.id
            : `${model.id}:${formatContextWindow(model.contextWindow)}`).join(', ')
        }
        testResult.textContent = t('connectionModelsFound', { count: result.modelCount ?? 0 })
        testResult.classList.add('success')
      } else if (result.status === 'unsupported') {
        testResult.textContent = result.detail || t('connectionTestUnsupported')
        testResult.classList.add('warn')
      } else {
        testResult.textContent = result.detail || t('connectionUnreachable')
        testResult.classList.add('error')
      }
    },
  }
}

function required<T extends HTMLElement>(document: Document, id: string): T {
  const element = document.getElementById(id)
  if (element === null) throw new Error(`Missing #${id}`)
  return element as T
}

/**
 * Parses the Model IDs field. Each comma/space-separated entry is either a
 * bare model id or `id:contextWindow`, where the size accepts a `k`/`m`
 * suffix (`32k` = 32768, `1m` = 1048576) for convenience since local
 * OpenAI-compatible endpoints rarely disclose their real context window.
 * The suffix is only interpreted when it is a valid size, so ids that
 * contain a colon (e.g. Ollama's `gpt-oss:20b`) stay intact. Repeated ids
 * are emitted once; a later occurrence's size overrides an earlier one.
 */
export function parseModelsField(value: string): { ids: string[]; contextWindows: Record<string, number> } {
  const ids: string[] = []
  const contextWindows: Record<string, number> = {}
  const seen = new Set<string>()
  for (const token of value.split(/[,，\s]+/u).map((item) => item.trim()).filter((item) => item !== '')) {
    let id = token
    let size: number | undefined
    const separator = token.lastIndexOf(':')
    if (separator > 0) {
      const candidate = parseContextWindow(token.slice(separator + 1).trim())
      if (candidate !== undefined) {
        id = token.slice(0, separator)
        size = candidate
      }
    }
    id = id.trim()
    if (id === '') continue
    if (!seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
    if (size !== undefined) contextWindows[id] = size
  }
  return { ids, contextWindows }
}

/** Parses a raw token count or a `k`/`m`-suffixed size into tokens; undefined when invalid. */
function parseContextWindow(raw: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/iu.exec(raw)
  if (match === null) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value)) return undefined
  const unit = match[2]?.toLowerCase()
  const multiplier = unit === 'k' ? 1024 : unit === 'm' ? 1024 * 1024 : 1
  const tokens = Math.round(value * multiplier)
  if (!Number.isFinite(tokens) || tokens <= 0) return undefined
  return tokens
}

/** Renders `k`-suffixed sizes for round values so the field stays compact. */
function formatContextWindow(tokens: number): string {
  if (tokens % (1024 * 1024) === 0) return `${tokens / (1024 * 1024)}m`
  if (tokens % 1024 === 0) return `${tokens / 1024}k`
  return String(tokens)
}

/** Renders ids with per-model sizes back into the Model IDs text field. */
function formatModelsField(ids: readonly string[], contextWindows: Readonly<Record<string, number>>): string {
  return ids.map((id) => {
    const size = contextWindows[id]
    return size === undefined ? id : `${id}:${formatContextWindow(size)}`
  }).join(', ')
}
