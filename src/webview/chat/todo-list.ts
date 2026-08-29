import type { TodoEntry } from '../../domain/todo-view.js'
import { node } from './context.js'

export type { TodoEntry } from '../../domain/todo-view.js'
export { todoGlyph, todoProgress, todoListSignature } from '../../domain/todo-view.js'

/** Inline SVG status icon per todo, mirroring the mock's clean circle/check. */
function todoStatusSvg(status: string): string {
  if (status === 'completed') {
    return '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="color-mix(in srgb, var(--vscode-testing-iconPassed, #40a02b) 22%, transparent)" stroke="var(--vscode-testing-iconPassed, #40a02b)" stroke-width="1.4"/><path d="M5 8.2l2 2 4-4.4" stroke="var(--vscode-testing-iconPassed, #40a02b)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  }
  if (status === 'in_progress') {
    return '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.5" stroke="#9b7cff" stroke-width="1.6" opacity=".55"/><circle cx="8" cy="8" r="3" fill="#9b7cff"/></svg>'
  }
  return '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.5" stroke="color-mix(in srgb, var(--vscode-descriptionForeground) 45%, transparent)" stroke-width="1.4"/></svg>'
}

/** Appends one checkbox row per todo; used by the Plan tab and stream cards. */
export function appendTodoRows(target: HTMLElement | DocumentFragment, todos: readonly TodoEntry[]): void {
  for (const todo of todos) {
    const row = node('div', `todo-row ${todo.status}`)
    const check = node('span', 'todo-check')
    check.innerHTML = todoStatusSvg(todo.status)
    row.append(check, node('span', 'todo-text', todo.content))
    target.append(row)
  }
}
