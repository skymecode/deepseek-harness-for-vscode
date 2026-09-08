import type { TurnDurationView } from '../../domain/turn-duration.js'
import type { MessageArguments, WebviewMessageKey } from '../localization.js'
import { formatWorkDuration } from './format.js'

type Translator = (key: WebviewMessageKey, args?: MessageArguments) => string

export interface WorkDurationComponent {
  /** Timing only. The shared transcript indicator owns all pending activity. */
  update(container: HTMLElement, duration: TurnDurationView | undefined): void
}

/**
 * Owns a single timer for every running message. Updating only footer text
 * preserves expanded tool/reasoning state and the conversation scroll offset.
 */
export function createWorkDurationComponent(options: {
  readonly document: Document
  readonly translate: Translator
}): WorkDurationComponent {
  const running = new Map<HTMLElement, TurnDurationView>()
  let ticker: ReturnType<typeof setInterval> | undefined

  const refresh = (element: HTMLElement, duration: TurnDurationView): void => {
    const elapsed = Math.max(0, (duration.endedAt ?? Date.now()) - duration.startedAt)
    element.textContent = options.translate('workedFor', { duration: formatWorkDuration(elapsed) })
  }

  const stopTickerWhenIdle = (): void => {
    if (running.size !== 0 || ticker === undefined) return
    clearInterval(ticker)
    ticker = undefined
  }

  const tick = (): void => {
    for (const [element, duration] of running) {
      if (!element.isConnected) {
        running.delete(element)
        continue
      }
      refresh(element, duration)
    }
    stopTickerWhenIdle()
  }

  const ensureTicker = (): void => {
    ticker ??= setInterval(tick, 1_000)
  }

  return {
    update(container, duration) {
      const current = Array.from(container.children).find((child) => child.classList.contains('work-duration'))
      const element = current instanceof HTMLElement ? current : undefined

      if (duration === undefined) {
        if (element !== undefined) {
          running.delete(element)
          element.remove()
          stopTickerWhenIdle()
        }
        return
      }

      const footer = element ?? options.document.createElement('div')
      if (element === undefined) {
        footer.className = 'work-duration'
        container.append(footer)
      }
      refresh(footer, duration)
      if (duration.endedAt === undefined) {
        running.set(footer, duration)
        ensureTicker()
      } else {
        running.delete(footer)
        stopTickerWhenIdle()
      }
    },
  }
}
