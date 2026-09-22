import type { JsonValue as DshJsonValue } from '@deepseek-ai/dsh-util-values'
import type { SettingsPathOpView as DshSettingsPathOpView } from '@deepseek-ai/dsh-settings/types'
/**
 * Adapts the upstream DSH settings/credentials/LLM control plane to the
 * extension's deliberately small DeepSeek-source form.
 *
 * The wire-shape mapping helpers live in `./connection-settings/mapping.ts`
 * and the connect-time healing passes in `./connection-settings/migrations.ts`;
 * this class only owns state and the lifecycle.
 */
import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'
import type { ConfigurationService } from '../config/configuration.js'
import {
  DEEPSEEK_OFFICIAL_BASE_URL,
  DEEPSEEK_OFFICIAL_PROVIDER,
  isDeepSeekOfficialBaseUrl,
  isLegacyOfficialRoot,
  providerKeyEnv,
  providerRoute,
} from '../domain/provider.js'
import type {
  ConnectionSettingsInput,
  ConnectionSettingsState,
} from '../domain/connection-settings.js'
import type { CredentialStore } from '../security/credential-store.js'
import {
  DEEPSEEK_SETTINGS_NS,
  PI_AI_SETTINGS_NS,
  credentialRef,
  credentialRefForProfile,
  deepSeekRelayProfile,
  normalizeInput,
  providerView,
  KEYLESS_AUTHORIZATION,
  relayModels,
  valueAt,
  type ProviderControlClient,
} from './connection-settings/mapping.js'
import { runMigrations } from './connection-settings/migrations.js'

export { DEEPSEEK_SETTINGS_NS, PI_AI_SETTINGS_NS } from './connection-settings/mapping.js'
export type { ProviderControlClient } from './connection-settings/mapping.js'
export { runMigrations } from './connection-settings/migrations.js'
export type { MigrationContext } from './connection-settings/migrations.js'

type Listener = () => void

const EMPTY_STATE: ConnectionSettingsState = {
  writable: false,
  providers: [{
    id: DEEPSEEK_OFFICIAL_PROVIDER,
    name: 'DeepSeek Official',
    baseUrl: DEEPSEEK_OFFICIAL_BASE_URL,
    models: [],
    modelContextWindows: {},
    apiKeyConfigured: false,
    credentialWritable: false,
    removable: false,
  }],
}

export class ConnectionSettingsService {
  private client: ProviderControlClient | undefined
  private stateValue: ConnectionSettingsState = EMPTY_STATE
  private readonly listeners = new Set<Listener>()

  constructor(
    private readonly configuration: ConfigurationService,
    private readonly legacyCredentials: CredentialStore,
  ) {}

  get state(): ConnectionSettingsState {
    return this.stateValue
  }

  get connected(): boolean {
    return this.client !== undefined
  }

  hasConfiguredProvider(): boolean {
    return this.stateValue.providers.some((provider) => provider.apiKeyConfigured)
  }

  onDidChange(listener: Listener): { dispose(): void } {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  /** Binds one live Gateway client and imports settings written by older builds. */
  async connect(client: ProviderControlClient): Promise<void> {
    this.client = client
    await runMigrations({
      client,
      configuration: this.configuration,
      legacyCredentials: this.legacyCredentials,
    })
    await this.refresh()
  }

  disconnect(): void {
    this.client = undefined
  }

  async refresh(): Promise<ConnectionSettingsState> {
    const client = this.requireClient()
    const [configurable, described, live] = await Promise.all([
      client.llmListConfigurableProviders(),
      client.settingsDescribe(),
      client.llmListProviders(),
    ])
    const liveIds = new Set(live.map((provider) => provider.id))
    const namespaces = new Map(described.namespaces.map((namespace) => [namespace.ns, namespace]))
    const entries = configurable.filter((entry) => (
      (entry.provider === DEEPSEEK_OFFICIAL_PROVIDER || liveIds.has(entry.provider) || entry.declared === true)
      && (entry.settingsNs === DEEPSEEK_SETTINGS_NS || entry.settingsNs === PI_AI_SETTINGS_NS)
    ))
    const references = [...new Set(entries.map((entry) => credentialRef(entry, namespaces.get(entry.settingsNs))))] as string[]
    const credentials: Record<string, { readonly configured: boolean; readonly writable: boolean }> = references.length === 0
      ? {}
      : await client.credentialsDescribe(references)
    const providers = entries.map((entry) => providerView(
      entry,
      namespaces.get(entry.settingsNs),
      credentials[credentialRef(entry, namespaces.get(entry.settingsNs))],
    ))
    providers.sort((left, right) => {
      if (left.id === DEEPSEEK_OFFICIAL_PROVIDER) return -1
      if (right.id === DEEPSEEK_OFFICIAL_PROVIDER) return 1
      return left.name.localeCompare(right.name)
    })
    this.setState({ writable: described.writable, providers })
    return this.stateValue
  }

  /** Persists a normalized provider profile and optional credentials; returns the provider id. */
  async apply(input: ConnectionSettingsInput): Promise<string> {
    const normalized = normalizeInput(input)
    if (normalized.provider === DEEPSEEK_OFFICIAL_PROVIDER) {
      await this.applyOfficial(normalized.baseUrl, normalized.apiKey)
      await this.refresh()
      return DEEPSEEK_OFFICIAL_PROVIDER
    }

    const route = normalized.provider === '__new__'
      ? providerRoute(normalized.name)
      : normalized.provider
    if (route === DEEPSEEK_OFFICIAL_PROVIDER) throw new Error('This provider name is reserved. Choose another name.')
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(route)) {
      throw new Error('The provider name cannot be converted to a valid provider ID.')
    }
    const existing = this.stateValue.providers.find((provider) => provider.id === route)
    if (input.provider === '__new__' && existing !== undefined) throw new Error('A provider with this name already exists.')
    const client = this.requireClient()
    const namespace = await this.namespace(PI_AI_SETTINGS_NS)
    const oldProfile = valueAt(namespace.value, ['providers', route])
    const keyRef = existing === undefined ? providerKeyEnv(route) : credentialRefForProfile(oldProfile, route)
    // A new provider submitted with a blank key is deliberately keyless: omit
    // `apiKeyEnv` so the pi-ai adapter resolves it as unauthenticated instead
    // of failing every request on an unset credential ref (MISSING_CREDENTIAL).
    const profile = deepSeekRelayProfile(
      normalized.name,
      normalized.baseUrl,
      normalized.apiKey === '' ? undefined : keyRef,
      normalized.models,
      normalized.modelContextWindows,
      normalized.api,
    ) as unknown as DshJsonValue
    const ops: SettingsPathOpView[] = existing === undefined
      ? [{ op: 'set', path: ['providers', route], value: profile }]
      : [
          { op: 'set', path: ['providers', route, 'displayName'], value: normalized.name },
          { op: 'set', path: ['providers', route, 'baseURL'], value: normalized.baseUrl },
          { op: 'set', path: ['providers', route, 'models'], value: relayModels(normalized.models, input.modelContextWindows === undefined ? undefined : normalized.modelContextWindows, valueAt(oldProfile, ['models'])) as unknown as DshJsonValue },
          ...(normalized.apiKey === '' ? [] : [{ op: 'set' as const, path: ['providers', route, 'apiKeyEnv'], value: keyRef }]),
        ]
    if (existing && normalized.api !== undefined && normalized.api !== valueAt(oldProfile, ['api'])) {
      ops.push({ op: 'set', path: ['providers', route, 'api'], value: normalized.api })
    }
    if (normalized.apiKey !== '' && valueAt(oldProfile, ['headers', 'authorization']) === KEYLESS_AUTHORIZATION) {
      ops.push({ op: 'unset', path: ['providers', route, 'headers', 'authorization'] })
    }
    await client.settingsMutate(PI_AI_SETTINGS_NS, ops as DshSettingsPathOpView[], namespace.revision)
    if (normalized.apiKey !== '') await client.credentialsSet(keyRef, normalized.apiKey)
    await this.refresh()
    return route
  }

  async remove(provider: string): Promise<void> {
    if (provider === DEEPSEEK_OFFICIAL_PROVIDER) throw new Error('The built-in provider cannot be removed.')
    const target = this.stateValue.providers.find((item) => item.id === provider)
    if (target === undefined || !target.removable) throw new Error('This provider is not removable.')
    const client = this.requireClient()
    const namespace = await this.namespace(PI_AI_SETTINGS_NS)
    const ref = credentialRefForProfile(valueAt(namespace.value, ['providers', provider]), provider)
    // Delete the profile first: if this write fails on a stale revision, the
    // credential is still intact, so the user never loses a key for a provider
    // that still exists. A credential unset that fails afterwards leaves only
    // an invisible orphan key, which is safe.
    await client.settingsMutate(PI_AI_SETTINGS_NS, [{ op: 'unset', path: ['providers', provider] }], namespace.revision)
    const credential = (await client.credentialsDescribe([ref]))[ref]
    if (credential?.configured === true && credential.writable) await client.credentialsUnset(ref)
    await this.refresh()
  }

  async setOfficialApiKey(value: string): Promise<void> {
    const normalized = value.trim()
    if (normalized === '') throw new Error('The API Key cannot be empty.')
    await this.requireClient().credentialsSet('DEEPSEEK_API_KEY', normalized)
    await this.refresh()
  }

  async clearOfficialApiKey(): Promise<void> {
    await this.requireClient().credentialsUnset('DEEPSEEK_API_KEY')
    await this.refresh()
  }

  private async applyOfficial(baseUrl: string, apiKey: string): Promise<void> {
    const client = this.requireClient()
    if (!isDeepSeekOfficialBaseUrl(baseUrl)) {
      throw new Error('Third-party endpoints must be added as a custom provider.')
    }
    const namespace = await this.namespace(DEEPSEEK_SETTINGS_NS)
    const normalizedBase = baseUrl === DEEPSEEK_OFFICIAL_BASE_URL || isLegacyOfficialRoot(baseUrl) ? '' : baseUrl
    const ops: SettingsPathOpView[] = normalizedBase === ''
      ? [{ op: 'unset', path: ['baseURL'] }]
      : [{ op: 'set', path: ['baseURL'], value: normalizedBase }]
    await client.settingsMutate(DEEPSEEK_SETTINGS_NS, ops, namespace.revision)
    if (apiKey !== '') await client.credentialsSet('DEEPSEEK_API_KEY', apiKey)
  }

  private async namespace(ns: string): Promise<SettingsNamespaceView> {
    const described = await this.requireClient().settingsDescribe()
    const namespace = described.namespaces.find((item) => item.ns === ns)
    if (namespace === undefined) throw new Error(`Harness settings namespace "${ns}" is unavailable.`)
    if (!described.writable) throw new Error('Harness settings are read-only.')
    return namespace
  }

  private requireClient(): ProviderControlClient {
    if (this.client === undefined) throw new Error('Harness Gateway is not connected.')
    return this.client
  }

  private setState(state: ConnectionSettingsState): void {
    this.stateValue = state
    for (const listener of this.listeners) listener()
  }
}
