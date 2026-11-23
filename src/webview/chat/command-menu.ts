import type { CommandEntry } from '../../domain/workbench-state.js'
import { resizePrompt } from './composer-core.js'
import {
  components,
  elements,
  menuLoadedSession,
  menuState,
  node,
  payload,
  post,
  setMenuLoadedSession,
  setMenuState,
} from './context.js'

export function updateCommandMenu(): void {
  const active = payload?.state?.active
  const token = currentCommandToken(elements.prompt)
  if (token === undefined || !active) {
    closeCommandMenu()
    return
  }
  if (!menuState || menuState.query !== token) setMenuState({ query: token, index: 0, items: [] })
  const commands = active.commands || []
  if (menuLoadedSession !== active.id && commands.every((command) => command.kind === 'extension')) {
    setMenuLoadedSession(active.id)
    post('loadCommands')
  }
  const query = token.toLowerCase()
  const items = commands.filter((command) => {
    const name = command.name.toLowerCase()
    return query === '' || name.includes(query) || command.description.toLowerCase().includes(query)
  })
  items.sort((left, right) => rank(left.name, query) - rank(right.name, query))
  setMenuState(menuState ? { ...menuState, items } : { query: token, index: 0, items })
  if (menuState && menuState.index >= items.length) setMenuState({ ...menuState, index: Math.max(0, items.length - 1) })
  renderCommandMenu()
}

export function currentCommandToken(textarea: HTMLTextAreaElement): string | undefined {
  const before = textarea.value.slice(0, textarea.selectionStart)
  const match = /(?:^|\s)\/([a-zA-Z0-9_-]*)$/.exec(before)
  return match ? match[1] : undefined
}

function rank(name: string, query: string): number {
  if (query === '') return 0
  return name.toLowerCase().startsWith(query) ? 0 : 1
}

export function renderCommandMenu(): void {
  const menu = elements.commandMenu
  const state = menuState
  if (!state || state.items.length === 0) {
    menu.classList.add('hidden')
    menu.replaceChildren()
    return
  }
  const fragment = document.createDocumentFragment()
  state.items.forEach((command, index) => {
    const button = node('button', `command-menu-item${index === state.index ? ' active' : ''}`) as HTMLButtonElement
    button.type = 'button'
    button.setAttribute('role', 'option')
    button.setAttribute('aria-selected', String(index === state.index))
    const name = node('span', 'command-name', `/${command.name}`)
    const desc = node('span', 'command-desc', command.description)
    button.append(name, desc)
    if (command.input?.hint) button.append(node('span', 'command-hint', command.input.hint))
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', () => chooseCommand(command))
    fragment.append(button)
  })
  menu.replaceChildren(fragment)
  menu.classList.remove('hidden')
}

export function chooseCommand(command: CommandEntry): void {
  closeCommandMenu()
  if (command.kind === 'extension') {
    if (command.name === 'model') components.composerConfiguration.open('model')
    else if (command.name === 'reasoning') components.composerConfiguration.open('reasoning')
    else if (command.name === 'preset') components.composerConfiguration.open('preset')
    else if (command.name === 'mcp') post('manageMcp')
    return
  }
  insertCommand(command.name)
}

export function insertCommand(name: string): void {
  elements.prompt.value = `/${name} `
  resizePrompt()
  elements.prompt.focus()
  elements.prompt.setSelectionRange(elements.prompt.value.length, elements.prompt.value.length)
}

export function closeCommandMenu(): void {
  setMenuState(null)
  elements.commandMenu.classList.add('hidden')
  elements.commandMenu.replaceChildren()
}
