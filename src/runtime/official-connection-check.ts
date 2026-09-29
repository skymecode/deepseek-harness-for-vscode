import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials/types'
import type { SettingsForms } from '@deepseek-ai/dsh-settings'

/** Register a draft-only probe through DSH discovery; credentials stay in the Host. */
export function registerOfficialConnectionCheck(ctx: { get(name: string): unknown; on?(event: 'dispose', listener: () => Promise<void>): unknown }): void {
  const llm = ctx.get('llm') as LlmRuntime | undefined
  if (!llm) return
  const dispose = llm.registerModelDiscovery('vscode-deepseek-check', async (request, signal) => {
    const settings = ctx.get('settings') as SettingsForms | undefined
    const config = settings?.describe().find(entry => entry.ns === 'llm-deepseek')?.value as { apiKeyEnv?: string } | undefined
    const credentials = ctx.get('credentials') as CredentialProvider | undefined
    const key = request.apiKey?.trim() || (await credentials?.resolve((config?.apiKeyEnv ?? 'DEEPSEEK_API_KEY') as CredentialRef))?.value
    if (!key) throw new Error('Configure an API Key in Connection settings first.')
    // Never forward a supplied destination with the official credential. The
    // native pi-ai discovery performs GET /models, no generation or saving.
    return llm.discoverModels('llm-pi-ai', { baseURL: 'https://api.deepseek.com', api: 'openai-completions', apiKey: key }, signal)
  })
  ctx.on?.('dispose', async () => { dispose() })
}
