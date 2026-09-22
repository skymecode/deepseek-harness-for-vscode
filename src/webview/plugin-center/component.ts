import { applyIcon, icon } from '../icons.js'
import type { DshPluginCatalogItem, DshPluginCenterSnapshot, InstalledDshPlugin } from '../../plugins/types.js'
import type { MessageArguments, WebviewMessageKey } from '../localization.js'

type Translator = (key: WebviewMessageKey, args?: MessageArguments) => string

export interface PluginCenterComponent {
  open(): void
  close(): void
  update(snapshot: DshPluginCenterSnapshot): void
}

const INITIAL_RESULT_LIMIT = 60

/** Native DSH plugin browser. Network and installation stay in the Extension Host. */
export function createPluginCenterComponent(options: {
  readonly document: Document
  readonly translate: Translator
  readonly onOpen: () => void
  readonly onLoad: (force: boolean) => void
  readonly onInstall: (plugin: { readonly spec: string; readonly name?: string; readonly repositoryUrl?: string }) => void
  readonly onSetEnabled?: (name: string, enabled: boolean) => void
  readonly onRemove: (name: string) => void
  readonly onOpenExternal: (url: string) => void
}): PluginCenterComponent {
  const panel = required(options.document, 'plugin-panel')
  const toggle = requiredButton(options.document, 'plugins-toggle')
  const close = requiredButton(options.document, 'plugin-close')
  const refresh = requiredButton(options.document, 'plugin-refresh')
  const search = requiredInput(options.document, 'plugin-search')
  const category = requiredSelect(options.document, 'plugin-category')
  const market = required(options.document, 'plugin-marketplace-view')
  const installedView = required(options.document, 'plugin-installed-view')
  const marketList = required(options.document, 'plugin-marketplace-list')
  const installedList = required(options.document, 'plugin-installed-list')
  const status = required(options.document, 'plugin-status')
  const summary = required(options.document, 'plugin-summary')
  const loadMore = requiredButton(options.document, 'plugin-load-more')
  const customForm = requiredForm(options.document, 'plugin-custom-form')
  const customSpec = requiredInput(options.document, 'plugin-custom-spec')
  const source = requiredButton(options.document, 'plugin-source')
  const topic = requiredButton(options.document, 'plugin-topic')
  const tabs = Array.from(options.document.querySelectorAll<HTMLButtonElement>('[data-plugin-tab]'))
  let snapshot: DshPluginCenterSnapshot = { installed: [], busy: false }
  let activeTab: 'marketplace' | 'installed' = 'marketplace'
  let resultLimit = INITIAL_RESULT_LIMIT
  let loaded = false

  const setTab = (tab: 'marketplace' | 'installed'): void => {
    activeTab = tab
    for (const button of tabs) button.classList.toggle('active', button.dataset.pluginTab === tab)
    market.classList.toggle('hidden', tab !== 'marketplace')
    installedView.classList.toggle('hidden', tab !== 'installed')
    render()
  }

  toggle.addEventListener('click', () => {
    if (panel.classList.contains('hidden')) component.open()
    else component.close()
  })
  close.addEventListener('click', () => component.close())
  refresh.addEventListener('click', () => options.onLoad(true))
  search.addEventListener('input', () => {
    resultLimit = INITIAL_RESULT_LIMIT
    renderMarketplace()
  })
  category.addEventListener('change', () => {
    resultLimit = INITIAL_RESULT_LIMIT
    renderMarketplace()
  })
  loadMore.addEventListener('click', () => {
    resultLimit += INITIAL_RESULT_LIMIT
    renderMarketplace()
  })
  for (const button of tabs) {
    button.addEventListener('click', () => setTab(button.dataset.pluginTab === 'installed' ? 'installed' : 'marketplace'))
  }
  customForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const spec = customSpec.value.trim()
    if (spec !== '') options.onInstall({ spec })
  })
  source.addEventListener('click', () => {
    if (snapshot.catalog !== undefined) options.onOpenExternal(snapshot.catalog.curatedSourceUrl)
  })
  topic.addEventListener('click', () => {
    if (snapshot.catalog !== undefined) options.onOpenExternal(snapshot.catalog.topicUrl)
  })

  const component: PluginCenterComponent = {
    open() {
      options.onOpen()
      panel.classList.remove('hidden')
      toggle.setAttribute('aria-expanded', 'true')
      if (!loaded) {
        loaded = true
        options.onLoad(false)
      }
      setTab(activeTab)
      search.focus()
    },
    close() {
      panel.classList.add('hidden')
      toggle.setAttribute('aria-expanded', 'false')
    },
    update(value) {
      snapshot = value
      if (!snapshot.busy) loaded = snapshot.catalog !== undefined
        && (snapshot.catalog.sourceIssues?.length ?? 0) === 0 && snapshot.error === undefined
      render()
    },
  }

  function render(): void {
    panel.classList.toggle('busy', snapshot.busy)
    for (const control of Array.from(panel.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select'))) {
      control.disabled = snapshot.busy && control.id !== 'plugin-close'
    }
    status.classList.toggle('hidden', !snapshot.busy && snapshot.error === undefined)
    status.classList.toggle('error', snapshot.error !== undefined)
    status.textContent = snapshot.error ?? (snapshot.busy ? options.translate('pluginWorking') : '')
    if (activeTab === 'marketplace') renderMarketplace()
    else renderInstalled()
  }

  function renderMarketplace(): void {
    const catalog = snapshot.catalog
    replaceCategories(category, catalog?.categories ?? [], options.translate('allCategories'))
    const query = search.value.trim().toLowerCase()
    const selectedCategory = category.value
    const installed = snapshot.installed
    const filtered = (catalog?.plugins ?? []).filter((plugin) => {
      const matchesCategory = selectedCategory === '' || plugin.category === selectedCategory
      const haystack = `${plugin.name} ${plugin.owner} ${plugin.description}`.toLowerCase()
      return matchesCategory && (query === '' || haystack.includes(query))
    })
    const visible = filtered.slice(0, resultLimit)
    const fragment = options.document.createDocumentFragment()
    for (const plugin of visible) fragment.append(pluginCard(plugin, installed))
    if (visible.length === 0 && !snapshot.busy) fragment.append(element('p', 'plugin-empty', options.translate('noMatchingPlugins')))
    marketList.replaceChildren(fragment)
    loadMore.classList.toggle('hidden', visible.length >= filtered.length)
    summary.textContent = catalog === undefined
      ? ''
      : options.translate(catalog.topicRepositoryCount === undefined ? 'pluginCatalogSummaryUnavailable' : 'pluginCatalogSummary', {
        visible: visible.length,
        total: filtered.length,
        marketTotal: catalog.topicRepositoryCount ?? 0,
      })
  }

  function renderInstalled(): void {
    const fragment = options.document.createDocumentFragment()
    for (const plugin of snapshot.installed) fragment.append(installedCard(plugin))
    if (snapshot.installed.length === 0 && !snapshot.busy) {
      fragment.append(element('p', 'plugin-empty', options.translate('noInstalledPlugins')))
    }
    installedList.replaceChildren(fragment)
  }

  function pluginCard(plugin: DshPluginCatalogItem, installed: readonly InstalledDshPlugin[]): HTMLElement {
    const card = element('article', 'plugin-card')
    const heading = element('div', 'plugin-card-heading')
    const title = element('div', 'plugin-card-title')
    title.append(element('strong', '', plugin.name), element('span', 'plugin-owner', plugin.owner))
    const stars = element('span', 'plugin-stars')
    applyIcon(stars, icon('star', 10))
    stars.append(' ' + plugin.stars)
    heading.append(title, stars)
    const description = element('p', 'plugin-description', plugin.description)
    const meta = element('div', 'plugin-card-meta')
    meta.append(element('span', 'plugin-category-badge', categoryLabel(plugin.category)))
    if (plugin.installKind === 'managed-suite') meta.append(element('span', 'plugin-source-badge', options.translate('pluginSuite')))
    else if (plugin.npmPackage !== undefined) meta.append(element('span', 'plugin-source-badge', 'npm'))
    else meta.append(element('span', 'plugin-source-badge', 'GitHub'))
    meta.append(element('span', 'plugin-source-badge', options.translate(
      plugin.catalogSource === 'github-topic'
        ? 'githubTopicSource'
        : plugin.catalogSource === 'builtin' ? 'builtinSource' : 'curatedSource',
    )))
    meta.append(element('span', `plugin-compatibility-badge compatibility-${plugin.compatibility}`, compatibilityLabel(plugin)))
    const actions = element('div', 'plugin-card-actions')
    const details = button('secondary-button', options.translate('viewSource'))
    details.disabled = snapshot.busy
    details.addEventListener('click', () => options.onOpenExternal(plugin.detailsUrl ?? plugin.repositoryUrl))
    const alreadyInstalled = isInstalled(plugin, installed)
    const webUiOnly = plugin.compatibility === 'official-web-ui'
    const install = button('primary-button', options.translate(
      alreadyInstalled ? 'installed' : webUiOnly ? 'webUiOnly' : 'install',
    ))
    install.disabled = alreadyInstalled || webUiOnly || snapshot.busy
    install.addEventListener('click', () => options.onInstall({
      spec: plugin.installSpec,
      name: plugin.npmPackage ?? plugin.name,
      repositoryUrl: plugin.repositoryUrl,
    }))
    actions.append(details, install)
    card.append(heading, description, meta, actions)
    return card
  }

  function installedCard(plugin: InstalledDshPlugin): HTMLElement {
    const card = element('article', 'plugin-card installed-plugin-card')
    const heading = element('div', 'plugin-card-heading')
    const title = element('div', 'plugin-card-title')
    title.append(element('strong', '', plugin.name), element('span', 'plugin-owner', plugin.version))
    heading.append(title)
    if (plugin.description !== undefined) card.append(heading, element('p', 'plugin-description', plugin.description))
    else card.append(heading)
    const meta = element('div', 'plugin-card-meta')
    meta.append(element('span', 'plugin-source-badge', plugin.source))
    if (plugin.includesWebClient) meta.append(element('span', 'plugin-web-badge', options.translate('officialWebUi')))
    const actions = element('div', 'plugin-card-actions')
    if (plugin.repositoryUrl !== undefined) {
      const repository = button('secondary-button', options.translate('viewSource'))
      repository.disabled = snapshot.busy
      repository.addEventListener('click', () => options.onOpenExternal(plugin.repositoryUrl!))
      actions.append(repository)
    }
    const remove = button('danger-button', options.translate('remove'))
    remove.disabled = snapshot.busy || plugin.removable === false
    remove.title = plugin.readOnlyReason ?? ''
    remove.addEventListener('click', () => options.onRemove(plugin.name))
    actions.append(remove)
    if (plugin.enabled !== undefined && options.onSetEnabled) {
      const toggle = button('secondary-button', options.translate(plugin.enabled ? 'disablePlugin' : 'enablePlugin'))
      toggle.disabled = snapshot.busy || plugin.readOnlyReason !== undefined
      toggle.title = plugin.readOnlyReason ?? ''
      toggle.addEventListener('click', () => options.onSetEnabled?.(plugin.name, !plugin.enabled))
      actions.prepend(toggle)
    }
    card.append(meta, actions)
    return card
  }

  function categoryLabel(id: string): string {
    return snapshot.catalog?.categories.find((item) => item.id === id)?.label ?? id
  }

  function compatibilityLabel(plugin: DshPluginCatalogItem): string {
    switch (plugin.compatibility) {
      case 'agent': return options.translate('agentCompatible')
      case 'partial': return options.translate('partialCompatibility')
      case 'official-web-ui': return options.translate('webUiOnly')
      case 'unknown': return options.translate('unknownCompatibility')
    }
  }

  function button(className: string, text: string): HTMLButtonElement {
    const value = options.document.createElement('button')
    value.type = 'button'
    value.className = className
    value.textContent = text
    return value
  }

  function element(tag: string, className = '', text = ''): HTMLElement {
    const value = options.document.createElement(tag)
    if (className !== '') value.className = className
    if (text !== '') value.textContent = text
    return value
  }

  return component
}

function isInstalled(plugin: DshPluginCatalogItem, installed: readonly InstalledDshPlugin[]): boolean {
  return installed.some((item) => item.name === plugin.installedName
    || item.name === plugin.npmPackage
    || item.name === plugin.name
    || item.source.includes(plugin.installSpec)
    || item.repositoryUrl?.toLowerCase() === plugin.repositoryUrl.toLowerCase())
}

function replaceCategories(
  select: HTMLSelectElement,
  categories: readonly { readonly id: string; readonly label: string }[],
  allLabel: string,
): void {
  const selected = select.value
  const fragment = select.ownerDocument.createDocumentFragment()
  const all = select.ownerDocument.createElement('option')
  all.value = ''
  all.textContent = allLabel
  fragment.append(all)
  for (const category of categories) {
    const option = select.ownerDocument.createElement('option')
    option.value = category.id
    option.textContent = category.label
    fragment.append(option)
  }
  select.replaceChildren(fragment)
  select.value = categories.some((item) => item.id === selected) ? selected : ''
}

function required(document: Document, id: string): HTMLElement {
  const value = document.getElementById(id)
  if (value === null) throw new Error(`Missing plugin center element: ${id}`)
  return value
}

function requiredButton(document: Document, id: string): HTMLButtonElement {
  const value = required(document, id)
  if (!(value instanceof HTMLButtonElement)) throw new Error(`Plugin center element is not a button: ${id}`)
  return value
}

function requiredInput(document: Document, id: string): HTMLInputElement {
  const value = required(document, id)
  if (!(value instanceof HTMLInputElement)) throw new Error(`Plugin center element is not an input: ${id}`)
  return value
}

function requiredSelect(document: Document, id: string): HTMLSelectElement {
  const value = required(document, id)
  if (!(value instanceof HTMLSelectElement)) throw new Error(`Plugin center element is not a select: ${id}`)
  return value
}

function requiredForm(document: Document, id: string): HTMLFormElement {
  const value = required(document, id)
  if (!(value instanceof HTMLFormElement)) throw new Error(`Plugin center element is not a form: ${id}`)
  return value
}
