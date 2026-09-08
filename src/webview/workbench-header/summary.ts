import type { ActiveSessionView } from '../../domain/workbench-state.js'
import type { MessageArguments, WebviewMessageKey } from '../localization.js'
import { formatTokenCount } from '../token-format.js'

export type HeaderTranslator = (key: WebviewMessageKey, args?: MessageArguments) => string

/** Pure text projection for the hover summary and the accessible overflow panel. */
export function headerSummary(active: ActiveSessionView | undefined, t: HeaderTranslator): { stats: string; usage: string } {
  const tokens = active?.tokenUsage
  const total = tokens === undefined ? 0 : tokens.uncachedInputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens
  const stats = active?.stats
  const statsText = stats === undefined ? '' : [
    `${stats.turns} ${stats.turns === 1 ? t('sessionStatsTurn') : t('sessionStatsTurns')}`,
    durationText(stats.durationMs, t),
    ...(total > 0 ? [`${formatTokenCount(total)} ${t('sessionStatsTokenShort')}`] : []),
    ...(stats.windowScoped ? [t('sessionStatsWindowScoped')] : []),
  ].join(' · ')
  const input = tokens === undefined ? 0 : tokens.uncachedInputTokens + tokens.cacheReadTokens
  const output = tokens?.outputTokens ?? 0
  return { stats: statsText, usage: input === 0 && output === 0 ? '' : `↑${formatTokenCount(input)} / ↓${formatTokenCount(output)}` }
}

function durationText(ms: number, t: HeaderTranslator): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}${t('durationSecondShort')}`
  const minutes = Math.floor(seconds / 60)
  return seconds % 60 === 0 ? `${minutes}${t('durationMinuteShort')}` : `${minutes}${t('durationMinuteShort')} ${seconds % 60}${t('durationSecondShort')}`
}
