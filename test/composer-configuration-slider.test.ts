import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Window } from 'happy-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workbenchHtml } from '../src/ui/workbench/view-html.js'
import { createComposerConfigurationComponent } from '../src/webview/composer-configuration/component.js'
import type { ComposerConfigurationInput } from '../src/webview/composer-configuration/types.js'

vi.mock('vscode', () => ({
  env: { language: 'zh-cn' },
  l10n: { t: (text: string) => text },
  Uri: { joinPath: (_base: unknown, ...parts: string[]) => parts.join('/') },
}))

describe('composer configuration effort slider dragging UX', () => {
  let browser: Window
  let document: Document

  beforeEach(async () => {
    browser = new Window()
    document = browser.document as unknown as Document
    const html = workbenchHtml(
      { asWebviewUri: () => '', cspSource: '' } as unknown as Parameters<typeof workbenchHtml>[0],
      {} as Parameters<typeof workbenchHtml>[1],
    )
    const parsed = new browser.DOMParser().parseFromString(html, 'text/html')
    document.body.innerHTML = parsed.body.innerHTML
    const styles = document.createElement('style')
    styles.textContent = await readFile(resolve(import.meta.dirname, '../media/chat.css'), 'utf8')
    document.head.append(styles)
  })

  afterEach(() => {
    document.head.replaceChildren()
    document.body.replaceChildren()
  })

  it('keeps decorative ticks pointer-transparent and sizes the track fill to --effort-progress', async () => {
    const css = await readFile(resolve(import.meta.dirname, '../media/chat.css'), 'utf8')
    expect(css).toContain('0 0 / var(--effort-progress) 100% no-repeat')

    const onChange = vi.fn()
    const component = createComposerConfigurationComponent({
      document,
      translate: (key) => String(key),
      onChange,
    })
    component.update(createInput('max'))

    const tick = document.querySelector<HTMLElement>('.effort-tick')!
    expect(tick).not.toBeNull()
    expect(tick.tagName).toBe('SPAN')
    expect(browser.getComputedStyle(tick as unknown as Parameters<typeof browser.getComputedStyle>[0]).pointerEvents).toBe('none')
  })

  it('drags smoothly from the resting thumb over ticks without jumping, then snaps onto the nearest detent', () => {
    const frames: FrameRequestCallback[] = []
    ;(browser as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame = (cb) => {
      frames.push(cb)
      return frames.length
    }
    ;(browser as unknown as { cancelAnimationFrame: (id: number) => void }).cancelAnimationFrame = () => {}

    const onChange = vi.fn()
    const component = createComposerConfigurationComponent({
      document,
      translate: (key) => String(key),
      onChange,
    })
    component.update(createInput('max'))

    const control = document.getElementById('effort-control')!
    const row = document.querySelector<HTMLElement>('.effort-slider-row')!
    const valueLabel = document.getElementById('effort-value')!
    // 144px wide row => travel is 120px (from x=12 to x=132). Stops at 12, 52, 92, 132.
    row.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 144,
      bottom: 26,
      width: 144,
      height: 26,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    // Start by pressing on the resting thumb (slightly off-centre at x=136, +4px from 132)
    // directly over the rightmost tick landmark.
    const activeTick = document.querySelector<HTMLElement>('.effort-tick[aria-current="true"]')!
    activeTick.dispatchEvent(new browser.PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 136,
      pointerId: 1,
    }) as unknown as Event)

    // Preserves grab offset: does not jump before moving.
    expect(control.classList.contains('dragging')).toBe(true)
    expect(Number(control.style.getPropertyValue('--effort-position'))).toBeCloseTo(1, 4)

    // Slide smoothly to x=64 (with +4px grab offset => thumb centre at 60 => fraction = (60-12)/120 = 0.4).
    document.dispatchEvent(new browser.PointerEvent('pointermove', {
      bubbles: true,
      clientX: 64,
      pointerId: 1,
    }) as unknown as Event)
    frames.shift()?.(16)

    expect(Number(control.style.getPropertyValue('--effort-position'))).toBeCloseTo(0.4, 4)
    expect(control.style.getPropertyValue('--effort-progress')).toBe('40%')
    // Nearest tier to 0.4 * 3 = 1.2 is index 1 ('low'), updated live while dragging!
    expect(valueLabel.textContent).toBe('Low')
    expect(control.dataset.effort).toBe('low')

    // Release at x=64: `.dragging` is removed so CSS transition settles from 0.4 -> 1/3 (0.3333).
    document.dispatchEvent(new browser.PointerEvent('pointerup', {
      bubbles: true,
      clientX: 64,
      pointerId: 1,
    }) as unknown as Event)

    expect(control.classList.contains('dragging')).toBe(false)
    expect(Number(control.style.getPropertyValue('--effort-position'))).toBeCloseTo(1 / 3, 4)
    expect(component.selection()?.reasoningEffort).toBe('low')
    expect(onChange).toHaveBeenCalled()
  })

  it('glides smoothly without entering instant-drag mode when clicking another stop on the track', () => {
    const onChange = vi.fn()
    const component = createComposerConfigurationComponent({
      document,
      translate: (key) => String(key),
      onChange,
    })
    component.update(createInput('max'))

    const control = document.getElementById('effort-control')!
    const row = document.querySelector<HTMLElement>('.effort-slider-row')!
    row.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 144,
      bottom: 26,
      width: 144,
      height: 26,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    // Click near the 'off' stop (x=14) without dragging.
    row.dispatchEvent(new browser.PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 14,
      pointerId: 2,
    }) as unknown as Event)

    // Must NOT add `.dragging` on a plain click so CSS transition glides the knob!
    expect(control.classList.contains('dragging')).toBe(false)

    document.dispatchEvent(new browser.PointerEvent('pointerup', {
      bubbles: true,
      clientX: 14,
      pointerId: 2,
    }) as unknown as Event)

    expect(control.classList.contains('dragging')).toBe(false)
    expect(Number(control.style.getPropertyValue('--effort-position'))).toBe(0)
    expect(control.style.getPropertyValue('--effort-progress')).toBe('0%')
    expect(component.selection()?.reasoningEffort).toBe('off')
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})

function createInput(reasoningEffort: string): ComposerConfigurationInput {
  const reasoning = [
    { id: 'off', label: 'Off' },
    { id: 'low', label: 'Low' },
    { id: 'high', label: 'High' },
    { id: 'max', label: 'Maximum' },
  ]
  return {
    sessionId: 'session-1',
    connected: true,
    editable: true,
    blank: false,
    current: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort,
      agentPreset: 'standard',
    },
    sources: [{ id: 'deepseek-official', label: 'DeepSeek Official' }],
    models: [
      {
        provider: 'deepseek-official',
        providerName: 'DeepSeek Official',
        id: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        reasoning,
      },
    ],
    presets: [{ id: 'standard', label: 'Standard' }],
    fallbackReasoning: reasoning,
  }
}
