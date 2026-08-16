/** Redacted provider settings sent to the webview. API keys never travel back. */
export interface ConnectionProviderView {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly apiKeyConfigured: boolean
  readonly credentialWritable: boolean
  readonly removable: boolean
}

export interface ConnectionSettingsState {
  readonly writable: boolean
  readonly providers: readonly ConnectionProviderView[]
}

export interface ConnectionSettingsInput {
  readonly provider: string
  readonly name: string
  readonly baseUrl: string
  /** Write-only. Blank means keep the currently stored credential. */
  readonly apiKey: string
}

export type ConnectionTestStatus = 'success' | 'unreachable' | 'unsupported'

export interface ConnectionTestResult {
  readonly status: ConnectionTestStatus
  readonly detail?: string
  readonly modelCount?: number
}

export const NEW_PROVIDER = '__new__'

