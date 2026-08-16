import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionSettingsInput, ConnectionTestResult } from '../domain/connection-settings.js'
import { validateBaseUrl } from '../domain/base-url.js'
import { DEEPSEEK_OFFICIAL_PROVIDER } from '../domain/provider.js'
import { PI_AI_SETTINGS_NS } from './connection-settings-service.js'

type ProviderControlClient = Pick<IApiClient, 'llm'>

/** Uses DSH's upstream GET /models discovery path; it never creates a completion. */
export class ConnectionTestService {
  constructor(private readonly client: () => ProviderControlClient) {}

  async test(input: ConnectionSettingsInput): Promise<ConnectionTestResult> {
    if (input.provider === DEEPSEEK_OFFICIAL_PROVIDER) {
      return { status: 'unsupported', detail: 'DeepSeek Official is validated when the first request is sent.' }
    }
    const baseURL = input.baseUrl.trim()
    if (!validateBaseUrl(baseURL).valid) {
      return { status: 'unreachable', detail: 'The Base URL must be a valid http(s) URL.' }
    }
    try {
      const response = await this.client().llm.discoverModels({
        settingsNs: PI_AI_SETTINGS_NS,
        ...(input.provider === '__new__' ? {} : { provider: input.provider }),
        baseURL,
        api: 'openai-completions',
        ...(input.apiKey.trim() === '' ? {} : { apiKey: input.apiKey.trim() }),
      })
      if (!response.result.ok) return { status: 'unreachable', detail: response.result.error.message }
      if (response.result.value.models.length === 0) {
        return { status: 'unreachable', detail: 'The endpoint returned an empty model catalog.' }
      }
      return { status: 'success', modelCount: response.result.value.models.length }
    } catch (cause) {
      return { status: 'unreachable', detail: cause instanceof Error ? cause.message : String(cause) }
    }
  }
}
