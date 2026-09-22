import type { JsonValue as DshJsonValue } from '@deepseek-ai/dsh-util-values'
/**
 * One-shot settings/healing passes run at connect time, in order, before the
 * first refresh. Each migration is idempotent — re-running it on an
 * already-updated profile is a no-op — and each grows the wire state written
 * by older builds toward the shape this extension reads today.
 */
import type { SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'
import type { ConfigurationService } from '../../config/configuration.js'
import { DEEPSEEK_OFFICIAL_PROVIDER, isDeepSeekOfficialBaseUrl, isLegacyOfficialRoot, providerRoute } from '../../domain/provider.js'
import type { CredentialStore } from '../../security/credential-store.js'
import {
  DEEPSEEK_SETTINGS_NS,
  PI_AI_SETTINGS_NS,
  credentialRefForProfile,
  deepSeekRelayProfile,
  importedRelay,
  valueAt,
  type ProviderControlClient,
} from './mapping.js'

/** Everything a migration needs from the live service. */
export interface MigrationContext {
  readonly client: ProviderControlClient
  readonly configuration: ConfigurationService
  readonly legacyCredentials: CredentialStore
}

/** Runs the full migration chain; the service calls this before connecting. */
export async function runMigrations(context: MigrationContext): Promise<void> {
  await migrateLegacySettings(context)
  await migrateOfficialDefaults(context)
}

/**
 * Imports settings written by older extension builds: pre-relay providers
 * (extension settings + secrets) and an optionally relay-flagged legacy base
 * URL are pushed into the harness namespaces, then the plaintext copies are
 * removed so DSH remains the single authority.
 */
async function migrateLegacySettings(context: MigrationContext): Promise<void> {
  const { client, configuration, legacyCredentials } = context
  const described = await client.settingsDescribe()
  if (!described.writable) return
  const piAi = described.namespaces.find((item) => item.ns === PI_AI_SETTINGS_NS)
  const deepSeek = described.namespaces.find((item) => item.ns === DEEPSEEK_SETTINGS_NS)
  const legacyKey = await legacyCredentials.getApiKey()
  const legacyBaseUrl = configuration.getLegacyBaseUrl()
  const legacyRelay = legacyBaseUrl !== undefined && !isDeepSeekOfficialBaseUrl(legacyBaseUrl)
    ? importedRelay(legacyBaseUrl, legacyKey)
    : undefined

  if (piAi !== undefined) {
    const legacyProviders = [
      ...configuration.getLegacyProviders(),
      ...(legacyRelay === undefined ? [] : [legacyRelay.provider]),
    ]
    const ops: SettingsPathOpView[] = []
    const pendingCredentials: { ref: string; value: string }[] = []
    const candidates = legacyProviders.map((provider) => {
      const route = providerRoute(provider.name)
      const existing = valueAt(piAi.value, ['providers', route])
      const ref = credentialRefForProfile(existing, route)
      return { provider, route, existing, ref }
    })
    const refs = [...new Set(candidates.map((candidate) => candidate.ref))]
    const credentialState = refs.length === 0
      ? {}
      : await client.credentialsDescribe(refs)
    for (const candidate of candidates) {
      if (candidate.existing === undefined) {
        ops.push({
          op: 'set',
          path: ['providers', candidate.route],
          value: deepSeekRelayProfile(candidate.provider.name, candidate.provider.baseUrl, candidate.ref) as DshJsonValue,
        })
      }
      const credentialInfo = credentialState[candidate.ref]
      if (candidate.provider.apiKey.trim() !== '' && credentialInfo?.configured !== true) {
        pendingCredentials.push({ ref: candidate.ref, value: candidate.provider.apiKey })
      }
    }
    if (ops.length > 0) {
      await client.settingsMutate(PI_AI_SETTINGS_NS, ops, piAi.revision)
    }
    for (const credential of pendingCredentials) {
      await client.credentialsSet(credential.ref, credential.value)
    }
  } else if (legacyRelay !== undefined) {
    throw new Error('Harness cannot migrate the legacy relay because llm-pi-ai is unavailable.')
  }

  if (legacyRelay === undefined && legacyKey !== undefined && legacyKey.trim() !== '') {
    const status = await client.credentialsDescribe(['DEEPSEEK_API_KEY'])
    if (status['DEEPSEEK_API_KEY']?.configured !== true) {
      await client.credentialsSet('DEEPSEEK_API_KEY', legacyKey.trim())
    }
  }
  if (deepSeek !== undefined && legacyBaseUrl !== undefined && legacyRelay === undefined && !isLegacyOfficialRoot(legacyBaseUrl) && valueAt(deepSeek.user, ['baseURL']) === undefined) {
    await client.settingsMutate(DEEPSEEK_SETTINGS_NS, [{ op: 'set', path: ['baseURL'], value: legacyBaseUrl }], deepSeek.revision)
  }
  if (legacyRelay !== undefined && configuration.get().provider === DEEPSEEK_OFFICIAL_PROVIDER) {
    await configuration.setProvider(legacyRelay.route)
  }
  // Migration is complete only after every upstream write above succeeded.
  // Remove plaintext legacy copies so DSH remains the single authority.
  if (configuration.getLegacyProviders().length > 0) await configuration.clearLegacyProviders()
  if (legacyKey !== undefined && legacyKey.trim() !== '') await legacyCredentials.clearApiKey()
  if (legacyBaseUrl !== undefined) await configuration.clearLegacyBaseUrl()
}

/** Adopt Messages defaults without touching explicitly selected custom protocols. */
async function migrateOfficialDefaults({ client }: MigrationContext): Promise<void> {
  const described = await client.settingsDescribe()
  if (!described.writable) return
  const official = described.namespaces.find((item) => item.ns === DEEPSEEK_SETTINGS_NS)
  if (official && isLegacyOfficialRoot(valueAt(official.user, ['baseURL']))
    && valueAt(official.user, ['protocol']) !== 'chat-completions') {
    await client.settingsMutate(DEEPSEEK_SETTINGS_NS, [{ op: 'unset', path: ['baseURL'] }], official.revision)
  }
  const piAi = described.namespaces.find((item) => item.ns === PI_AI_SETTINGS_NS)
  const profiles = valueAt(piAi?.user, ['providers'])
  if (!piAi || !profiles || typeof profiles !== 'object') return
  const ops: SettingsPathOpView[] = []
  for (const [route, profile] of Object.entries(profiles)) {
    if (valueAt(profile, ['compat', 'thinkingFormat']) !== 'deepseek') continue
    if (valueAt(profile, ['compat', 'requiresReasoningContentOnAssistantMessages']) !== undefined) continue
    ops.push({ op: 'set', path: ['providers', route, 'compat', 'requiresReasoningContentOnAssistantMessages'], value: true })
  }
  if (ops.length) await client.settingsMutate(PI_AI_SETTINGS_NS, ops, piAi.revision)
}
