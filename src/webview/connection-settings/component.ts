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
  update(state: ConnectionSettingsState, selectedProvider: string, activeProvider?: string): void
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
  const baseUrl = required<HTMLInputElement>(document, 'settings-base-url')
  const baseUrlError = required<HTMLElement>(document, 'settings-base-url-error')
  const apiKey = required<HTMLInputElement>(document, 'settings-api-key')
  const openNative = required<HTMLButtonElement>(document, 'settings-open-native')
  const apply = required<HTMLButtonElement>(document, 'settings-apply')
  const remove = required<HTMLButtonElement>(document, 'settings-delete')
  const test = required<HTMLButtonElement>(document, 'settings-test')
  const testResult = required<HTMLElement>(document, 'settings-test-result')

  let state: ConnectionSettingsState = { writable: false, providers: [] }
  let defaultProvider = DEEPSEEK_OFFICIAL_PROVIDER
  let activeProvider: string | undefined

  const selected = (): ConnectionProviderView | undefined => state.providers.find((item) => item.id === providerSelect.value)
  const input = (): Record<string, unknown> => ({
    provider: providerSelect.value,
    name: name.value,
    baseUrl: baseUrl.value,
    apiKey: apiKey.value,
  })

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
    name.value = provider?.name ?? ''
    name.disabled = !state.writable || (!creating && provider === undefined)
    baseUrl.value = provider?.baseUrl ?? (official ? 'https://api.deepseek.com' : '')
    // The built-in route is intentionally tied to the native DeepSeek adapter.
    // Every relay endpoint must be added as a custom pi-ai provider.
    baseUrl.disabled = !state.writable || official
    apiKey.value = ''
    apiKey.disabled = !state.writable || (provider !== undefined && !provider.credentialWritable)
    apiKey.placeholder = provider?.apiKeyConfigured === true ? t('apiKeyKeepPlaceholder') : t('apiKeyPlaceholder')
    apply.disabled = !state.writable
    test.classList.toggle('hidden', official)
    baseUrl.classList.remove('invalid')
    baseUrlError.classList.add('hidden')
    resetTest()
  }

  const renderProviders = (): void => {
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
    providerSelect.value = state.providers.some((provider) => provider.id === defaultProvider)
      ? defaultProvider
      : DEEPSEEK_OFFICIAL_PROVIDER
    renderFields()
  }

  providerSelect.addEventListener('change', renderFields)
  name.addEventListener('input', resetTest)
  baseUrl.addEventListener('input', () => {
    validateUrl()
    resetTest()
  })
  apiKey.addEventListener('input', resetTest)
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
      renderProviders()
      panel.classList.remove('hidden')
      baseUrl.focus()
    },
    close: () => panel.classList.add('hidden'),
    update: (next, selectedProvider, currentProvider) => {
      state = next
      defaultProvider = selectedProvider
      activeProvider = currentProvider
      if (!panel.classList.contains('hidden')) renderProviders()
      else if (selected() !== undefined) remove.disabled = selected()!.id === activeProvider
    },
    renderTestResult: (result) => {
      test.disabled = false
      test.textContent = t('testConnection')
      testResult.classList.remove('hidden', 'success', 'error', 'warn')
      if (result.status === 'success') {
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
