import type { ChatBlock, ChatItem } from '../../domain/workbench-state.js'
import { createSequentialActivityDots } from '../activity-indicator/component.js'
import { applyIcon, icon } from '../icons.js'
import { nextStreamText, shouldRebuildStreamFrame, STREAMING_REBUILD_CHAR_THRESHOLD, STREAMING_REBUILD_MIN_INTERVAL_MS } from './model.js'

type StreamingMessage = Pick<ChatItem, 'status' | 'blocks' | 'streamKey'>

interface StreamState {
  rendered: string
  target: string
  frame: number | undefined
  /** Authoritative adapter-reported reasoning tokens, once the usage chunk lands. */
  tokens?: number
  /** Monotonic live estimate so the counter only grows while streaming. */
  labelTokens?: number
  /** Whether the reasoning content keeps auto-scrolling to its own bottom. */
  follow?: boolean
  /** Text handed to the last full markdown rebuild ('' before the first). */
  lastRendered: string
  /** Timestamp of the last full markdown rebuild. */
  lastRenderAt: number
}

/** Rough live token estimate for streamed reasoning text (≈4 chars/token). */
function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.trim().length / 4))
}

/** Owns reasoning disclosure state and smooth incremental assistant text. */
export class StreamingMessageComponent {
  private readonly streams = new WeakMap<HTMLElement, StreamState>()
  private readonly blockSignatures = new WeakMap<HTMLElement, string>()

  constructor(private readonly options: {
    readonly document: Document
    readonly reasoningLabel: () => string
    /** "Thinking… · 1,234 tokens" once a running reasoning block has text or usage. */
    readonly thinkingLabel: (tokens?: number) => string
    /** "Thought for 12s · 342 tokens" style label once a reasoning block has known timing. */
    readonly reasoningDoneLabel: (elapsedMs: number, tokens?: number) => string
    readonly renderMarkdown: (target: HTMLElement, source: string) => void
    readonly onStreamFrame: () => void
  }) {}

  render(body: HTMLElement, item: StreamingMessage): void {
    const running = item.status === 'running'
    for (const [index, block] of (item.blocks ?? []).entries()) {
      body.append(this.createBlock(block, index, running, item.streamKey))
    }
    if (running) body.append(createSequentialActivityDots(this.options.document))
  }

  patch(body: HTMLElement, item: StreamingMessage): boolean {
    const blocks = item.blocks ?? []
    const renderedBlocks = Array.from(body.children).filter((child) => !child.classList.contains('streaming-indicator'))
    const running = item.status === 'running'
    const indicator = Array.from(body.children).find((child) => child.classList.contains('streaming-indicator'))
    // Reconcile at block granularity: appending text or removing a trailing
    // placeholder must never replace an earlier native <details> element.
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]
      if (block === undefined) continue
      const rendered = renderedBlocks[index]
      if (!(rendered instanceof HTMLElement)) {
        body.insertBefore(this.createBlock(block, index, running, item.streamKey), indicator ?? null)
        continue
      }
      const signature = this.blockSignature(block, running, item.streamKey)
      if (this.blockSignatures.get(rendered) === signature) continue
      if (this.patchBlock(rendered, block, running, item.streamKey)) {
        this.blockSignatures.set(rendered, signature)
      } else {
        this.dispose(rendered)
        rendered.replaceWith(this.createBlock(block, index, running, item.streamKey))
      }
    }
    for (const stale of renderedBlocks.slice(blocks.length)) {
      if (stale instanceof HTMLElement) this.dispose(stale)
      stale.remove()
    }
    if (running && indicator === undefined) body.append(createSequentialActivityDots(this.options.document))
    else if (!running) indicator?.remove()
    return true
  }

  /** Cancel detached streams on replacement or session switch. */
  dispose(root: HTMLElement): void {
    this.finishStream(root)
    for (const target of Array.from(root.querySelectorAll<HTMLElement>('.reasoning-content, .content-block'))) this.finishStream(target)
  }

  private createBlock(block: ChatBlock, index: number, running: boolean, streamKey?: string): HTMLElement {
    const element = this.renderBlock(block, index, running, streamKey)
    this.blockSignatures.set(element, this.blockSignature(block, running, streamKey))
    return element
  }

  private blockSignature(block: ChatBlock, messageRunning: boolean, streamKey?: string): string {
    // A finished block is independent of whether a later block is streaming.
    return JSON.stringify([block, messageRunning && block.streaming === true, streamKey])
  }

  private renderBlock(block: ChatBlock, index: number, messageRunning: boolean, streamKey?: string): HTMLElement {
    const running = messageRunning && block.streaming === true
    if (block.kind === 'reasoning') {
      const details = this.options.document.createElement('details')
      details.className = `reasoning-block${running ? ' running' : ''}`
      details.dataset.disclosureKey = `reasoning-${index}`
      // Stable identity `<turn>:<step>#<blockIndex>`: shared by the running
      // partial bubble and the finalized message that replaces it, so the
      // transcript can carry this block's reader expand/collapse intent
      // across the id handoff (text prefixes cannot — the text grows until
      // the step finalizes).
      if (streamKey !== undefined) details.dataset.streamKey = `${streamKey}#${index}`
      // Like the DSH Web UI, the thinking block stays collapsed by default;
      // the summary row carries a one-line live preview while it streams, and
      // the reader expands it explicitly if they want the full reasoning.
      details.dataset.autoOpen = 'false'
      details.open = false
      const summary = this.options.document.createElement('summary')
      summary.append(this.reasoningDot(), this.label(running, block), this.reasoningPreview(block.text), this.chevron())
      const content = this.options.document.createElement('div')
      content.className = `reasoning-content markdown-body${running ? ' streaming-content' : ''}`
      this.renderContent(content, block, running)
      details.append(summary, content)
      return details
    }
    const content = this.options.document.createElement('div')
    content.className = `content-block ${block.kind}${block.kind === 'text' ? ' markdown-body' : ''}${running ? ' streaming-content' : ''}`
    this.renderContent(content, block, running)
    return content
  }

  private patchBlock(rendered: HTMLElement, block: ChatBlock, messageRunning: boolean, streamKey?: string): boolean {
    const running = messageRunning && block.streaming === true
    if (block.kind === 'reasoning') {
      if (!(rendered instanceof HTMLDetailsElement) || !rendered.classList.contains('reasoning-block')) return false
      const content = rendered.querySelector<HTMLElement>('.reasoning-content')
      const label = rendered.querySelector<HTMLElement>('.reasoning-label')
      if (content === null || label === null) return false
      rendered.classList.toggle('running', running)
      // Keep the identity current only for elements that predate the key
      // (older bubbles without one). Never rewrite an existing streamKey:
      // the `#<blockIndex>` suffix must stay stable across streaming frames,
      // otherwise the reader's expand/collapse intent (keyed by streamKey in
      // messages.ts) is lost and the reasoning card snaps shut mid-stream.
      if (streamKey !== undefined && (rendered.dataset.streamKey === undefined || rendered.dataset.streamKey === '')) {
        const children = rendered.parentElement?.children ?? []
        rendered.dataset.streamKey = `${streamKey}#${Array.from(children).indexOf(rendered)}`
      }
      // The disclosure stays whatever the reader set it to: no per-frame
      // force-close (which made an explicit expand snap back instantly).
      // Initial render starts collapsed; the summary row keeps the live
      // one-line preview while streaming.
      setLabel(label, this.labelText(running, block))
      const summary = rendered.querySelector<HTMLElement>('.reasoning-summary')
      if (summary !== null) {
        const value = this.reasoningPreviewText(block.text)
        setText(summary, value)
        if (summary.title !== value) summary.title = value
      }
      content.classList.toggle('streaming-content', running)
      this.renderContent(content, block, running)
      return true
    }
    if (!rendered.classList.contains('content-block') || !rendered.classList.contains(block.kind)) return false
    rendered.classList.toggle('streaming-content', running)
    this.renderContent(rendered, block, running)
    return true
  }

  private renderContent(target: HTMLElement, block: ChatBlock, running: boolean): void {
    if (block.kind === 'image') {
      this.finishStream(target)
      target.textContent = block.text
    } else if (running) {
      this.stream(target, block.text, block.reasoningTokens)
    } else {
      this.finishStream(target)
      this.options.renderMarkdown(target, block.text)
    }
  }

  private stream(target: HTMLElement, text: string, tokens?: number): void {
    let state = this.streams.get(target)
    if (state === undefined) {
      target.textContent = ''
      state = { rendered: '', target: text, frame: undefined, follow: true, lastRendered: '', lastRenderAt: 0, ...(tokens === undefined ? {} : { tokens }) }
      this.streams.set(target, state)
      // The reasoning content auto-follows its own stream, but an intentional
      // scroll-up inside the card must win: once the reader moves off the
      // bottom the card stops being yanked down, and resumes only after they
      // scroll back to its very bottom.
      if (target.classList.contains('reasoning-content') && target.dataset.followBound === undefined) {
        target.dataset.followBound = 'true'
        target.addEventListener('scroll', () => {
          const current = this.streams.get(target)
          if (current === undefined) return
          const atBottom = target.scrollHeight - target.scrollTop - target.clientHeight <= 4
          if (atBottom) current.follow = true
          else if (current.follow !== false) current.follow = false
        }, { passive: true })
      }
    } else {
      state.target = text
      if (tokens !== undefined) state.tokens = tokens
    }
    if (state.frame === undefined && state.rendered !== state.target) this.schedule(target, state)
  }

  private schedule(target: HTMLElement, state: StreamState): void {
    state.frame = requestAnimationFrame(() => {
      state.frame = undefined
      if (!target.isConnected) return
      state.rendered = nextStreamText(state.rendered, state.target)
      // Full-block markdown rebuilds (markdown-it + DOMPurify + innerHTML) are
      // expensive and scale with the accumulated text. Rebuilding on every rAF
      // frame makes long replies janky on the webview's main thread. The first
      // visible frame renders immediately; subsequent frames are throttled by
      // accumulated text and elapsed time, and the final frame always rebuilds
      // so the stream lands exactly on its target.
      const now = Date.now()
      if (shouldRebuildStreamFrame(
        { rendered: state.rendered, target: state.target, lastRendered: state.lastRendered, lastRenderAt: state.lastRenderAt },
        now,
        STREAMING_REBUILD_MIN_INTERVAL_MS,
        STREAMING_REBUILD_CHAR_THRESHOLD,
      )) {
        this.options.renderMarkdown(target, state.rendered)
        state.lastRendered = state.rendered
        state.lastRenderAt = now
      }
      if (target.classList.contains('reasoning-content')) {
        if (state.follow !== false) target.scrollTop = target.scrollHeight
        this.updateStreamingLabel(target, state)
      }
      this.options.onStreamFrame()
      if (state.rendered !== state.target) this.schedule(target, state)
    })
  }

  /** Keeps the "Thinking… · N tokens" label ticking while reasoning streams. */
  private updateStreamingLabel(target: HTMLElement, state: StreamState): void {
    const label = target.closest('.reasoning-block')?.querySelector('.reasoning-label')
    if (!(label instanceof HTMLElement)) return
    if (state.tokens !== undefined) {
      setLabel(label, this.options.thinkingLabel(state.tokens))
      return
    }
    const estimate = estimateTokens(state.target)
    if (estimate <= (state.labelTokens ?? 0)) return
    state.labelTokens = estimate
    setLabel(label, this.options.thinkingLabel(estimate))
  }

  private finishStream(target: HTMLElement): void {
    const state = this.streams.get(target)
    if (state?.frame !== undefined) cancelAnimationFrame(state.frame)
    this.streams.delete(target)
  }

  private reasoningPreview(text: string): HTMLElement {
    const preview = this.options.document.createElement('span')
    preview.className = 'reasoning-summary'
    const value = this.reasoningPreviewText(text)
    preview.textContent = value
    preview.title = value
    return preview
  }

  /**
   * One-line live preview of the *newest* thought text. The DSH reasoning
   * stream usually opens with a fixed lead-in (the user message echo) that
   * never changes, so previewing the first line looks frozen; taking the tail
   * makes the row visibly stream with every new thought fragment.
   */
  private reasoningPreviewText(text: string): string {
    const single = text.replace(/\s+/g, ' ').trim()
    if (single === '') return ''
    const MAX = 100
    return single.length > MAX ? `…${single.slice(-MAX)}` : single
  }

  private reasoningDot(): HTMLElement {
    const dot = this.options.document.createElement('span')
    dot.className = 'reasoning-dot'
    applyIcon(dot, icon('bulb', 16))
    return dot
  }

  private label(running: boolean, block?: ChatBlock): HTMLElement {
    const label = this.options.document.createElement('span')
    label.className = 'reasoning-label'
    setLabel(label, this.labelText(running, block))
    return label
  }

  private labelText(running: boolean, block?: ChatBlock): string {
    if (running) return this.options.thinkingLabel(this.liveTokens(block))
    if (block?.duration !== undefined) {
      const elapsed = Math.max(0, (block.duration.endedAt ?? Date.now()) - block.duration.startedAt)
      return this.options.reasoningDoneLabel(elapsed, block.reasoningTokens)
    }
    return this.options.reasoningLabel()
  }

  /** Adapter-reported count when known, else a live estimate from the streamed text. */
  private liveTokens(block: ChatBlock | undefined): number | undefined {
    if (block === undefined || block.kind !== 'reasoning') return undefined
    if (block.reasoningTokens !== undefined) return block.reasoningTokens
    if (block.text.trim() === '') return undefined
    return estimateTokens(block.text)
  }

  private chevron(): HTMLElement {
    const chevron = this.options.document.createElement('span')
    chevron.className = 'reasoning-chevron'
    applyIcon(chevron, icon('chevron', 14))
    chevron.setAttribute('aria-hidden', 'true')
    return chevron
  }
}

/** Avoid replacing text nodes on unchanged summaries while a sibling streams. */
function setText(target: HTMLElement, value: string): void {
  if (target.textContent !== value) target.textContent = value
}

/** Narrow cards may ellipsize the label; retain the complete timing/usage. */
function setLabel(target: HTMLElement, value: string): void {
  setText(target, value)
  if (target.title !== value) target.title = value
}
