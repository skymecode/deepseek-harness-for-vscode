import * as vscode from 'vscode'

const API_KEY_SECRET = 'deepseekHarness.apiKey'

/** Legacy-key bridge used only until the live Harness credential service connects. */
export class CredentialStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getApiKey(): Promise<string | undefined> {
    const configured = vscode.workspace.getConfiguration('deepseekHarness')
      .get<string>('apiKey', '').trim()
    if (configured !== '') return configured

    const legacy = await this.secrets.get(API_KEY_SECRET)
    return legacy === undefined || legacy.trim() === '' ? undefined : legacy.trim()
  }

  async setApiKey(value: string): Promise<void> {
    await this.secrets.store(API_KEY_SECRET, value)
    // Remove any plaintext copy left by an older build.
    await vscode.workspace.getConfiguration('deepseekHarness')
      .update('apiKey', undefined, vscode.ConfigurationTarget.Global)
  }

  async clearApiKey(): Promise<void> {
    await vscode.workspace.getConfiguration('deepseekHarness')
      .update('apiKey', undefined, vscode.ConfigurationTarget.Global)
    await this.secrets.delete(API_KEY_SECRET)
  }
}
