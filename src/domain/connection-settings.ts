/** Redacted provider settings sent to the webview. API keys never travel back. */
export interface ConnectionProviderView {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly api?: string
  /** Model ids this provider's profile exposes; empty means the defaults. */
  readonly models: readonly string[]
  /**
   * Per-model context windows (tokens) the user explicitly set, keyed by
   * model id. Missing values are resolved by the official provider.
   */
  readonly modelContextWindows: Readonly<Record<string, number>>
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
  readonly api?: string
  /** Write-only. Blank means keep the currently stored credential. */
  readonly apiKey: string
  /**
   * Model ids the custom endpoint actually exposes. Only meaningful for
   * custom relay providers; the built-in official route ignores it. Empty
   * leaves discovery and defaults to the official provider.
   */
  readonly models: readonly string[]
  /**
   * User-specified context window (tokens), keyed by model id, for models
   * this provider exposes. Most local OpenAI-compatible servers (llama.cpp,
   * llama-swap, Ollama, …) do not disclose a model's real context size over
   * `/v1/models`, so the user sets it manually; it takes priority over the
   * official fallback for that id. Omitted input preserves existing declarations.
   */
  readonly modelContextWindows?: Readonly<Record<string, number>>
}

export type ConnectionTestStatus = 'success' | 'unreachable' | 'unsupported'

/** One advertised model the endpoint listed, with any disclosed capacity. */
export interface DiscoveredModel {
  readonly id: string
  readonly contextWindow?: number
  readonly maxTokens?: number
}

export interface ConnectionTestResult {
  readonly status: ConnectionTestStatus
  readonly detail?: string
  readonly modelCount?: number
  /** Models the endpoint advertised on success; the form adopts them verbatim. */
  readonly models?: readonly DiscoveredModel[]
}

export const NEW_PROVIDER = '__new__'
