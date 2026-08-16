export const DEEPSEEK_OFFICIAL_PROVIDER = 'deepseek-official'
export const DEEPSEEK_OFFICIAL_BASE_URL = 'https://api.deepseek.com'

export interface CustomProvider {
  readonly name: string
  readonly baseUrl: string
  readonly apiKey: string
}

/** Stable kebab-case route id derived from a user-entered provider name. */
export function providerRoute(name: string): string {
  const normalized = name.trim().toLowerCase()
  const slug = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug === '' ? `custom-${stableHash(normalized)}` : slug
}

/** The environment variable that carries a provider's key into the runtime. */
export function providerKeyEnv(name: string): string {
  return `PROVIDER_${providerRoute(name).toUpperCase().replace(/-/g, '_')}_API_KEY`
}

/**
 * Protects the selected route, and conservatively protects every route while
 * an active session's model selection is still loading.
 */
export function isProviderRouteInUse(
  route: string,
  activeProvider: string | undefined,
  hasActiveSession = activeProvider !== undefined,
): boolean {
  return hasActiveSession && (activeProvider === undefined || route === activeProvider)
}

/** True only for the public DeepSeek endpoint, including an optional path. */
export function isDeepSeekOfficialBaseUrl(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return true
  try {
    return new URL(value).hostname.toLowerCase() === 'api.deepseek.com'
  } catch {
    return false
  }
}

/** Small deterministic browser-safe hash for provider names without ASCII. */
function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}
