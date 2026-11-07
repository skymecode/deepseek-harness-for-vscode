import type { SharedHistoryReport } from '../runtime/shared-history/migration.js'

export interface HistorySourceView {
  readonly root: string
  readonly status: 'preparing' | 'shared' | 'shared-incomplete' | 'unavailable'
  readonly report?: SharedHistoryReport
  readonly migrationError?: string
}
