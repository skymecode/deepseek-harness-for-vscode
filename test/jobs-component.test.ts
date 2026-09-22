// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { JobsComponent } from '../src/webview/jobs/component.js'
import { createWebviewTranslator } from '../src/webview/localization.js'
import type { JobDisplayView } from '../src/domain/workbench-state.js'

afterEach(() => document.body.replaceChildren())
const job = { id: 'bash-1', kind: 'bash', label: 'build', status: 'running', startedAt: 1, output: { total: 0, earliest: 0 } } as JobDisplayView

it('keeps job buttons and output mounted during streaming and only follows on demand', () => {
  const post = vi.fn()
  const component = new JobsComponent(document, createWebviewTranslator(), post)
  document.body.append(component.element)
  component.update('s1', [job])
  expect(post).not.toHaveBeenCalled()
  const toggle = component.element.querySelector<HTMLButtonElement>('.job-toggle')!
  toggle.click()
  toggle.focus()
  const output = component.element.querySelector<HTMLElement>('.job-output')!
  for (let i = 1; i < 6; i++) component.update('s1', [{ ...job, outputText: `line ${i}` }])
  expect(document.activeElement).toBe(toggle)
  expect(component.element.querySelector('.job-output')).toBe(output)
  expect(output.textContent).toBe('line 5')
  expect(post).toHaveBeenCalledExactlyOnceWith('followJob', { sessionId: 's1', jobId: 'bash-1' })
  component.element.querySelector<HTMLButtonElement>('.job-stop')!.click()
  expect(post).toHaveBeenLastCalledWith('killJob', { sessionId: 's1', jobId: 'bash-1' })
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  toggle.click()
  expect(output.hidden).toBe(true)
  expect(post).toHaveBeenLastCalledWith('stopFollowingJob', { sessionId: 's1', jobId: 'bash-1' })
})

it('closes the old subscription and resets expansion on a session switch', () => {
  const post = vi.fn()
  const component = new JobsComponent(document, createWebviewTranslator(), post)
  component.update('s1', [job])
  component.element.querySelector<HTMLButtonElement>('.job-toggle')!.click()
  component.update('s2', [job])
  expect(post).toHaveBeenLastCalledWith('stopFollowingJob', { sessionId: 's1', jobId: 'bash-1' })
  expect(component.element.querySelector('.job-toggle')?.getAttribute('aria-expanded')).toBe('false')
  expect(component.element.querySelector<HTMLElement>('.job-output')?.hidden).toBe(true)
})
