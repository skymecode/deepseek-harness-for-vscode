import type { SharedHistoryReport, SharedHistoryRequest } from './migration.js'
import { runHistoryMigration } from './runner.js'

export interface PreparedSharedHistory {
  readonly compression: 'zstd' | 'none'
  readonly report?: SharedHistoryReport
  readonly migrationError?: string
}

/** The selected data source never depends on whether every legacy record can be imported. */
export async function prepareSharedHistory(command: string, worker: string, request: SharedHistoryRequest, signal?: AbortSignal,
  run = runHistoryMigration): Promise<PreparedSharedHistory> {
  const validate = (): Promise<SharedHistoryReport> => run(command, worker, { destinationHome: request.destinationHome, sourceHomes: [] }, signal)
  const baseline = await validate()
  if (request.sourceHomes.length === 0) return { compression: baseline.compression, report: baseline }
  try {
    const report = await run(command, worker, request, signal)
    return { compression: report.compression, report }
  } catch (error) {
    if (signal?.aborted) throw error
    // A worker crash/timeout can follow partial imports. Revalidate the target,
    // retain originals, and keep reading the canonical store instead of forking data.
    const checked = await validate()
    return { compression: checked.compression, migrationError: error instanceof Error ? error.message : 'Legacy history migration failed.' }
  }
}
