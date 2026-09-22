import type { LlmResolvedModelInfo as DshLlmResolvedModelInfo } from '@deepseek-ai/dsh-llm/types'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Host Connection surface consumed for the launch-token exchange. Typed
 * structurally so the plugin bundle carries no runtime dependency on
 * dsh-client-connection.
 */
interface GatewayConnectionService {
  authenticatedUrl(baseUrl: string): string
  authorizeIndex(req: IncomingMessage, res: ServerResponse): boolean
}

interface GatewayIndexRoute {
  readonly kind: 'exact'
  readonly path: string
  handler(req: IncomingMessage, res: ServerResponse): void
}

/** Minimal Cordis context used by the extension-owned Gateway runtime plugin. */
interface GatewayPluginContext {
  readonly webServer: {
    readonly port: number
    register(route: GatewayIndexRoute): unknown
  }
  provide(name: 'webRuntime', value: GatewayRuntimeValues): void
  get(name: string): unknown
}

interface GatewayRuntimeConfig {
  readonly printUrl?: boolean
}

export interface GatewayRuntimeValues {
  readonly lanAddresses: readonly string[]
  readonly trustedHosts: readonly string[]
}

/** Stable Cordis plugin metadata consumed by the DSH profile loader. */
export const name = 'vscode-gateway-runtime'
export const inject = ['webServer']

/** Canonical loopback endpoint used only by the native extension client. */
export function gatewayUrl(port: number): string {
  return `http://127.0.0.1:${String(port)}`
}

/**
 * Provides the bind-dependent value required by dsh-client-connection without
 * mounting dsh-host-frontend-static. Unmatched HTTP routes therefore remain
 * owned by dsh-host-webserver and return 404 instead of serving the DSH SPA.
 *
 * The Connection host fences every /api route behind its signed browser
 * cookie, and the only token-for-cookie exchange ships with the disabled
 * frontend static host. Once the plugin tree has settled we mount that
 * exchange ourselves on GET / and announce the launch-token URL, so the
 * native client can mint the cookie its calls need.
 */
export function apply(ctx: GatewayPluginContext, config: GatewayRuntimeConfig = {}): void {
  ctx.provide('webRuntime', { lanAddresses: [], trustedHosts: [] })
  if (config.printUrl === false) return

  const announce = (): void => {
    const base = gatewayUrl(ctx.webServer.port)
    const connection = ctx.get('connection') as GatewayConnectionService | undefined
    if (connection === undefined) {
      // The client-connection plugin provides `connection` asynchronously, so
      // it can be missing right after the loader settles. Since dsh 0.1.2
      // every /api route sits behind the signed cookie this service owns,
      // announcing a token-less URL would make every client call 401 and the
      // workbench would silently open a blank session. Wait for it.
      let attempts = 0
      const wait = (): void => {
        const service = ctx.get('connection') as GatewayConnectionService | undefined
        if (service !== undefined) {
          announceAuthenticated(ctx, service, base)
          return
        }
        attempts += 1
        if (attempts >= 20) {
          process.stdout.write('dsh gateway-auth-unavailable: connection service never appeared\n')
          return
        }
        setTimeout(wait, 100)
      }
      wait()
      return
    }
    announceAuthenticated(ctx, connection, base)
  }
  const settled = (ctx.get('loader') as { await(): Promise<unknown> } | undefined)?.await()
  if (settled === undefined) announce()
  else void settled.then(announce, () => undefined)
}

function announceAuthenticated(
  ctx: GatewayPluginContext,
  connection: GatewayConnectionService,
  base: string,
): void {
  // session/modelCatalog omits capabilities. Forward the official LLM service's
  // resolved metadata without inventing a second capability catalog.
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/vscode.models',
    handler: (req, res) => {
      if (!connection.authorizeIndex(req, res)) return
      const provider = new URL(req.url ?? '/', base).searchParams.get('provider')
      const llm = ctx.get('llm') as {
        listModels(provider: string): Promise<readonly { id: string }[]>
        resolveModelInfo(provider: string, model: string): Promise<DshLlmResolvedModelInfo>
      } | undefined
      if (!provider || !llm) { res.writeHead(400); res.end(); return }
      void llm.listModels(provider).then(async (models) => {
        const resolved = await Promise.allSettled(models.map((model) => llm.resolveModelInfo(provider, model.id)))
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify(resolved.flatMap((result) => {
          if (result.status !== 'fulfilled') return []
          const { id, inputModalities, context, reasoning, defaultMaxTokens } = result.value
          return [{ id, inputModalities, context, reasoning, defaultMaxTokens }]
        })))
      }).catch(() => { res.writeHead(502); res.end() })
    },
  })
  ctx.webServer.register({
    kind: 'exact',
    path: '/',
    handler: (req, res) => {
      if (!connection.authorizeIndex(req, res)) return
      res.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh gateway\n')
    },
  })
  process.stdout.write(`dsh gateway: ${connection.authenticatedUrl(base)}\n`)
}
