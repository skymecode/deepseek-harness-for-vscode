import { spawn } from 'node:child_process'
import type { SharedHistoryReport, SharedHistoryRequest } from './migration.js'

/** Launch the migration with the VSIX's own Node; never require a globally installed DSH or Node. */
export async function runHistoryMigration(command: string, worker: string, request: SharedHistoryRequest, signal?: AbortSignal): Promise<SharedHistoryReport> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [worker, JSON.stringify(request)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error !== undefined) { child.kill(); reject(error); return }
      try {
        const response = JSON.parse(output.trim()) as { type: string; report: SharedHistoryReport }
        if (response.type !== 'shared-history-ready' || !['zstd', 'none'].includes(response.report.compression) || (response.report.preferredSessionId !== undefined && typeof response.report.preferredSessionId !== 'string') || !(['copied', 'advanced', 'forked', 'skipped', 'deferred'] as const).every((key) => Number.isSafeInteger(response.report[key]) && response.report[key] >= 0)) throw new Error('Invalid migration result.')
        resolve(response.report)
      } catch { reject(new Error('Invalid shared-history migration response.')) }
    }
    const abort = (): void => finish(new Error('Shared-history migration cancelled.'))
    const timer = setTimeout(() => finish(new Error('Shared-history migration timed out; original histories were preserved.')), 120_000)
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (output.length > 16_384) finish(new Error('Unexpected shared-history migration output.'))
    })
    // Drain stderr but do not echo possibly sensitive parser payloads into the UI.
    child.stderr.resume()
    child.once('error', (error) => finish(error))
    child.once('exit', (code) => {
      let name = 'Error'
      try {
        const failure = JSON.parse(output.trim())
        if (failure.type === 'shared-history-error' && typeof failure.name === 'string' && /^[A-Za-z0-9_]{1,80}$/u.test(failure.name)) name = failure.name
      } catch { /* A crashed worker may not have produced a structured result. */ }
      finish(code === 0 ? undefined : new Error(`Shared-history migration failed (${name}, code=${code}); original histories were preserved.`))
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
