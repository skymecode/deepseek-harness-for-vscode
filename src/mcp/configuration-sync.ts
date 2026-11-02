import type { McpServerConfiguration } from '../config/mcp.js'

export interface McpConfigurationState {
  readonly raw: string
  readonly servers: readonly McpServerConfiguration[]
  readonly error?: string
}

/** Coalesces UI/settings changes through the gateway's idle mutation gate. */
export class McpConfigurationSync {
  private signature: string
  private pending: Promise<void> = Promise.resolve()

  constructor(private readonly read: () => McpConfigurationState, private readonly reload: () => Promise<void>) {
    this.signature = JSON.stringify(read().servers)
  }

  sync(): Promise<void> {
    const state = this.read()
    if (state.error) return Promise.reject(new Error(state.error))
    const signature = JSON.stringify(state.servers)
    if (signature === this.signature) return this.pending
    this.signature = signature
    const task = this.pending.catch(() => undefined).then(() => this.reload())
    this.pending = task.catch(error => {
      if (this.signature === signature) this.signature = ''
      throw error
    })
    return this.pending
  }
}
