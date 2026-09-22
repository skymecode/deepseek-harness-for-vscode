import type { SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent/client'
import type { SessionSummary, SubagentListEntry } from './gateway-wire.js'

/** Durable discovery plus live session status; neither is guessed from tool text. */
export function subagentCatalogRows(entries: readonly SubagentCatalogEntry[], summaries: ReadonlyMap<string, SessionSummary> = new Map()): SubagentListEntry[] {
  return entries.map(entry => {
    if (entry.mode === 'unknown') return { kind: 'diagnostic', id: entry.id, reason: 'unavailable' }
    const summary = summaries.get(String(entry.id))
    const descendants = summary?.projections?.values.subagentCatalog
    const common = {
      kind: 'child' as const, id: entry.id,
      activity: summary?.running === true ? 'running' as const : 'inactive' as const,
      hasChildren: Array.isArray(descendants) && descendants.length > 0,
    }
    return entry.mode === 'continuable'
      ? { ...common, mode: entry.mode, label: entry.label }
      : { ...common, mode: entry.mode, ...(entry.label === undefined ? {} : { label: entry.label }) }
  })
}
