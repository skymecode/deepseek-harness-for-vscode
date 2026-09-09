import { migrateSharedHistory, type SharedHistoryRequest } from './migration.js'

// All arguments are extension-owned paths, passed as one JSON argv (no shell).
try {
  const request = JSON.parse(process.argv[2] ?? '') as SharedHistoryRequest
  if (typeof request.destinationHome !== 'string' || !Array.isArray(request.sourceHomes) || !request.sourceHomes.every((path) => typeof path === 'string')) throw new Error('Invalid history migration request.')
  const report = await migrateSharedHistory(request)
  process.stdout.write(JSON.stringify({ type: 'shared-history-ready', report }) + '\n')
} catch (error) {
  // Do not echo transcript bodies, credentials or untrusted parser payloads.
  process.stderr.write(`Shared history migration failed (${error instanceof Error ? error.name : 'unknown error'}); original histories are retained.\n`)
  process.stdout.write(JSON.stringify({ type: 'shared-history-error', name: error instanceof Error ? error.name : 'Error' }) + '\n')
  process.exitCode = 1
}
