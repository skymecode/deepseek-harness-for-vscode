import type { ActiveSessionView } from '../../domain/workbench-state.js'
import type { MessageArguments, WebviewMessageKey } from '../localization.js'

type Translate = (key: WebviewMessageKey, args?: MessageArguments) => string

/** Ambient copy describes working, never claims a tool action actually happened. */
export function activityPhrases(translate: Translate): readonly string[] {
  const keys = ['activityWorking', 'activityPondering', 'activityPercolating', 'activityMulling'] as const
  return keys.map((key) => translate(key))
}

/** Real request failures always replace decorative copy, with the full retry detail. */
export function retryStatusText(retry: NonNullable<ActiveSessionView['retry']>, translate: Translate): string {
  const reasons: Record<string, WebviewMessageKey> = {
    TIMEOUT: 'retryReasonTimeout', TRANSPORT: 'retryReasonTransport', SERVER: 'retryReasonServer',
    RATE_LIMIT: 'retryReasonRateLimit', EMPTY_RESPONSE: 'retryReasonEmptyResponse',
  }
  const reason = translate(reasons[retry.code ?? ''] ?? 'retryReasonGeneric')
  const attempt = retry.mode === 'always'
    ? translate('retryingAlways', { reason })
    : translate('retryingWithAttempt', { reason, attempt: retry.attempt, max: retry.maxRetries ?? retry.attempt })
  if (retry.started || retry.delayMs === undefined || retry.delayMs <= 0) return attempt
  const seconds = Math.max(1, Math.round(retry.delayMs / 1000))
  return `${attempt} · ${translate('retryInSeconds', { seconds })}`
}
