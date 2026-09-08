import type { WorkspaceFileView } from '../../editor/types.js'
import type { WebviewMessageKey } from '../localization.js'

interface FileMentionOptions {
  readonly document: Document
  readonly prompt: HTMLTextAreaElement
  readonly translate: (key: WebviewMessageKey) => string
  readonly onSearch: (query: string, requestId: number) => void
  readonly onChoose: (file: WorkspaceFileView) => void
  readonly onOpen: () => void
}

export interface FileMentionComponent {
  readonly open: () => void
  readonly acceptSuggestions: (requestId: number | undefined, query: string, files: readonly WorkspaceFileView[]) => void
  readonly close: () => void
}

interface ActiveMention {
  readonly start: number
  readonly end: number
  readonly query: string
}

/** @ workspace file autocomplete for the prompt textarea. */
export function createFileMentionComponent(options: FileMentionOptions): FileMentionComponent {
  const menu = requiredElement(options.document, 'file-mention-menu')
  let active: ActiveMention | undefined
  let suggestions: readonly WorkspaceFileView[] = []
  let selectedIndex = 0
  let requestId = 0
  let acceptedRequestId = 0
  let searchTimer: ReturnType<typeof setTimeout> | undefined

  const close = (): void => {
    active = undefined
    suggestions = []
    menu.classList.add('hidden')
    menu.replaceChildren()
  }

  const schedule = (): void => {
    const mention = activeMention(options.prompt)
    if (mention === undefined) {
      close()
      return
    }
    active = mention
    selectedIndex = 0
    options.onOpen()
    menu.classList.remove('hidden')
    menu.replaceChildren(status(options.translate('searchingWorkspaceFiles')))
    if (searchTimer !== undefined) clearTimeout(searchTimer)
    const nextRequest = ++requestId
    searchTimer = setTimeout(() => options.onSearch(mention.query, nextRequest), 80)
  }

  const render = (): void => {
    if (active === undefined) return
    if (suggestions.length === 0) {
      menu.replaceChildren(status(options.translate('noMatchingFiles')))
      menu.classList.remove('hidden')
      return
    }
    const fragment = options.document.createDocumentFragment()
    suggestions.forEach((file, index) => {
      const button = options.document.createElement('button')
      button.type = 'button'
      button.className = `file-mention-item${index === selectedIndex ? ' active' : ''}`
      button.setAttribute('role', 'option')
      button.setAttribute('aria-selected', String(index === selectedIndex))
      const icon = options.document.createElement('span')
      icon.className = 'file-mention-icon'
      icon.textContent = fileExtension(file.label)
      const copy = options.document.createElement('span')
      copy.className = 'file-mention-copy'
      const label = options.document.createElement('strong')
      label.textContent = file.label
      const detail = options.document.createElement('small')
      detail.textContent = file.path
      copy.append(label, detail)
      button.append(icon, copy)
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', () => choose(file))
      fragment.append(button)
    })
    menu.replaceChildren(fragment)
    menu.classList.remove('hidden')
  }

  const choose = (file: WorkspaceFileView): void => {
    if (active === undefined) return
    // The textarea cannot host an inline rich mention. Replace the typed
    // query with a real context chip instead of leaving a duplicate @path in
    // the plain prompt; removing the chip therefore truly removes context.
    options.prompt.setRangeText('', active.start, active.end, 'end')
    options.onChoose(file)
    close()
    options.prompt.dispatchEvent(new Event('input', { bubbles: true }))
    options.prompt.focus()
  }

  options.prompt.addEventListener('input', schedule)
  options.prompt.addEventListener('click', schedule)
  options.prompt.addEventListener('blur', () => {
    setTimeout(() => { if (!menu.matches(':hover')) close() }, 120)
  })
  options.prompt.addEventListener('keydown', (event) => {
    if (active === undefined || menu.classList.contains('hidden')) return
    if (event.key === 'ArrowDown' && suggestions.length > 0) {
      event.preventDefault()
      event.stopImmediatePropagation()
      selectedIndex = (selectedIndex + 1) % suggestions.length
      render()
    } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
      event.preventDefault()
      event.stopImmediatePropagation()
      selectedIndex = (selectedIndex - 1 + suggestions.length) % suggestions.length
      render()
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      const selected = suggestions[selectedIndex]
      if (selected === undefined) return
      event.preventDefault()
      event.stopImmediatePropagation()
      choose(selected)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      close()
    }
  }, { capture: true })

  return {
    open: () => {
      if (options.prompt.disabled) return
      // Reuse @ completion and host-issued file IDs; never replace an existing draft.
      const mention = activeMention(options.prompt)
      const start = options.prompt.selectionEnd
      options.prompt.focus()
      if (mention === undefined) {
        const prefix = start > 0 && !/\s/u.test(options.prompt.value[start - 1] ?? '') ? ' ' : ''
        options.prompt.setRangeText(`${prefix}@`, start, start, 'end')
        options.prompt.setSelectionRange(start + prefix.length + 1, start + prefix.length + 1)
      } else {
        options.prompt.setSelectionRange(mention.end, mention.end)
      }
      options.prompt.dispatchEvent(new Event('input', { bubbles: true }))
    },
    close,
    acceptSuggestions: (incomingRequestId, query, files) => {
      if (active === undefined || incomingRequestId === undefined || incomingRequestId < acceptedRequestId) return
      if (query !== active.query) return
      acceptedRequestId = incomingRequestId
      suggestions = files
      selectedIndex = Math.min(selectedIndex, Math.max(0, files.length - 1))
      render()
    },
  }

  function status(label: string): HTMLElement {
    const element = options.document.createElement('div')
    element.className = 'file-mention-status'
    element.textContent = label
    return element
  }
}

function activeMention(prompt: HTMLTextAreaElement): ActiveMention | undefined {
  const caret = prompt.selectionStart ?? prompt.value.length
  const before = prompt.value.slice(0, caret)
  const match = /(?:^|\s)@([^@\s"]*)$/u.exec(before)
  if (match === null || match.index === undefined) return undefined
  const prefixLength = match[0].startsWith('@') ? 0 : 1
  return {
    start: match.index + prefixLength,
    end: caret,
    query: match[1] ?? '',
  }
}

function fileExtension(label: string): string {
  const extension = label.includes('.') ? label.split('.').pop() ?? '' : ''
  return extension === '' ? 'FILE' : extension.slice(0, 4).toLocaleUpperCase()
}

function requiredElement(document: Document, id: string): HTMLElement {
  const element = document.getElementById(id)
  if (element === null) throw new Error(`Missing #${id}`)
  return element
}
