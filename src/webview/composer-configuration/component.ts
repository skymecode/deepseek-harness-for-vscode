import type { PromptConfiguration } from '../../domain/prompt-configuration.js'
import type { MessageArguments, WebviewMessageKey } from '../localization.js'
import { ComposerConfigurationStore } from './store.js'
import type {
  ComposerConfigurationInput,
  ComposerConfigurationSnapshot,
  ConfigurationOption,
  ConfigurationSection,
  EffortTone,
  ModelConfigurationOption,
} from './types.js'

type Translate = (key: WebviewMessageKey, args?: MessageArguments) => string

export interface ComposerConfigurationComponent {
  readonly update: (input: ComposerConfigurationInput | undefined) => void
  readonly selection: () => PromptConfiguration | undefined
  readonly markSubmitted: () => void
  readonly reset: () => void
  readonly open: (section?: ConfigurationSection) => void
  readonly close: () => void
}

interface ComponentOptions {
  readonly document: Document
  readonly translate: Translate
  readonly onChange: () => void
  readonly onOpen?: () => void
}

/** Claude Code-inspired composer configuration component. */
export function createComposerConfigurationComponent(options: ComponentOptions): ComposerConfigurationComponent {
  return new ComposerConfigurationDom(options)
}

class ComposerConfigurationDom implements ComposerConfigurationComponent {
  private readonly store = new ComposerConfigurationStore()
  private effortDragging = false
  /** Provider tab shown in the model rail; defaults to the selection's. */
  private expandedProvider: string | undefined
  private readonly panel: HTMLElement
  private readonly toggle: HTMLButtonElement
  private readonly toggleModel: HTMLElement
  private readonly toggleMode: HTMLElement
  private readonly closeButton: HTMLButtonElement
  private readonly source: HTMLSelectElement
  private readonly models: HTMLElement
  private readonly presets: HTMLElement
  private readonly modelsToggle: HTMLButtonElement
  private readonly presetsToggle: HTMLButtonElement
  private readonly modelsCurrent: HTMLElement
  private readonly presetsCurrent: HTMLElement
  private readonly effortControl: HTMLElement
  private readonly effortStandardRow: HTMLElement
  private readonly effortAutoModeRow: HTMLElement
  private readonly autoModeToggle: HTMLButtonElement
  private readonly effortValue: HTMLElement
  private readonly effortSlider: HTMLInputElement
  private readonly effortTicks: HTMLElement
  private readonly effortAuto: HTMLButtonElement
  private readonly hint: HTMLElement

  constructor(private readonly options: ComponentOptions) {
    const document = options.document
    this.panel = requiredElement(document, 'configuration-panel')
    this.toggle = requiredElement(document, 'configuration-toggle')
    this.toggleModel = requiredElement(document, 'configuration-toggle-model')
    this.toggleMode = requiredElement(document, 'configuration-toggle-mode')
    this.closeButton = requiredElement(document, 'configuration-close')
    this.source = requiredElement(document, 'configuration-source')
    this.models = requiredElement(document, 'configuration-models')
    this.presets = requiredElement(document, 'configuration-presets')
    this.modelsToggle = requiredElement(document, 'configuration-models-toggle')
    this.presetsToggle = requiredElement(document, 'configuration-presets-toggle')
    this.modelsCurrent = requiredElement(document, 'configuration-models-current')
    this.presetsCurrent = requiredElement(document, 'configuration-presets-current')
    this.effortControl = requiredElement(document, 'effort-control')
    this.effortStandardRow = requiredElement(document, 'effort-standard-row')
    this.effortAutoModeRow = requiredElement(document, 'effort-auto-mode-row')
    this.autoModeToggle = requiredElement(document, 'auto-mode-toggle')
    this.effortValue = requiredElement(document, 'effort-value')
    this.effortSlider = requiredElement(document, 'effort-slider')
    this.effortTicks = requiredElement(document, 'effort-ticks')
    this.effortAuto = requiredElement(document, 'effort-auto')
    this.hint = requiredElement(document, 'configuration-hint')
    this.bindEvents()
  }

  update(input: ComposerConfigurationInput | undefined): void {
    if (input === undefined) {
      this.store.reset()
      this.render(undefined)
      return
    }
    this.render(this.store.update(input))
  }

  selection(): PromptConfiguration | undefined {
    return this.store.snapshot()?.selection
  }

  markSubmitted(): void {
    this.store.markSubmitted()
  }

  reset(): void {
    this.store.reset()
    this.close()
  }

  open(section?: ConfigurationSection): void {
    if (this.toggle.disabled) return
    this.options.onOpen?.()
    this.panel.classList.remove('hidden')
    this.toggle.classList.add('active')
    this.toggle.setAttribute('aria-expanded', 'true')
    // A targeted open (e.g. /model, /preset) must reveal its collapsed group.
    if (section === 'model') this.expandGroup(this.modelsToggle)
    if (section === 'preset') this.expandGroup(this.presetsToggle)
    const target = section === 'reasoning'
      ? this.effortSlider
      : section === 'preset'
        ? this.presets.querySelector<HTMLButtonElement>('button')
        : this.models.querySelector<HTMLButtonElement>('button')
    target?.focus()
  }

  close(): void {
    this.panel.classList.add('hidden')
    this.toggle.classList.remove('active')
    this.toggle.setAttribute('aria-expanded', 'false')
  }

  /** Folder-style collapse for the Models / DSH Modes groups. */
  private toggleGroup(toggle: HTMLButtonElement): void {
    const group = toggle.closest('.configuration-group')
    if (group === null) return
    const collapsed = group.classList.toggle('collapsed')
    toggle.setAttribute('aria-expanded', String(!collapsed))
  }

  private expandGroup(toggle: HTMLButtonElement): void {
    toggle.closest('.configuration-group')?.classList.remove('collapsed')
    toggle.setAttribute('aria-expanded', 'true')
  }

  private bindEvents(): void {
    this.toggle.addEventListener('click', () => {
      if (this.panel.classList.contains('hidden')) this.open()
      else this.close()
    })
    this.closeButton.addEventListener('click', () => this.close())
    for (const toggle of [this.modelsToggle, this.presetsToggle]) {
      toggle.addEventListener('click', () => this.toggleGroup(toggle))
    }
    this.source.addEventListener('change', () => {
      this.render(this.store.selectSource(this.source.value))
      this.options.onChange()
    })
    this.effortSlider.addEventListener('input', () => {
      this.changeReasoning(Number(this.effortSlider.value))
    })
    this.effortSlider.addEventListener('pointerdown', (event) => {
      if (event.button === 0) this.beginEffortDrag()
    })
    this.effortSlider.addEventListener('wheel', (event) => {
      event.preventDefault()
      const direction = event.deltaY > 0 ? 1 : -1
      this.changeReasoning(Number(this.effortSlider.value) + direction)
    }, { passive: false })
    this.effortAuto.addEventListener('click', () => {
      const snapshot = this.store.selectAuto()
      this.render(snapshot)
      this.options.onChange()
    })
    this.autoModeToggle.addEventListener('click', () => {
      const snapshot = this.store.toggleAuto()
      this.render(snapshot)
      if (snapshot !== undefined) {
        this.flourish(
          snapshot.effortTone,
          snapshot.autoActive ? this.options.translate('autoMode') : snapshot.effort.label,
        )
      }
      this.options.onChange()
    })
    this.options.document.addEventListener('pointerdown', (event) => {
      const target = event.target
      if (!(target instanceof Node) || this.panel.classList.contains('hidden')) return
      if (!this.panel.contains(target) && !this.toggle.contains(target)) this.close()
    })
    this.options.document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.panel.classList.contains('hidden')) {
        event.preventDefault()
        this.close()
        this.toggle.focus()
      }
    })
  }

  /**
   * Tracks the pointer during a drag so the knob and fill follow it
   * continuously (stepped range inputs otherwise jump detent to detent);
   * on release the control settles onto the committed detent with the
   * normal transition.
   */
  private beginEffortDrag(): void {
    if (this.effortSlider.disabled || this.effortDragging) return
    const row = this.effortSlider.parentElement
    if (row === null) return
    this.effortDragging = true
    this.effortControl.classList.add('dragging')
    const document = this.options.document
    const move = (event: PointerEvent) => {
      const rect = row.getBoundingClientRect()
      if (rect.width <= 24) return
      // Thumb centre travels from 12px to width - 12px (5px padding plus
      // half of the 14px knob on each side).
      const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left - 12) / (rect.width - 24)))
      this.effortControl.style.setProperty('--effort-position', String(fraction))
      this.effortControl.style.setProperty('--effort-progress', `${fraction * 100}%`)
    }
    const end = () => {
      this.effortDragging = false
      this.effortControl.classList.remove('dragging')
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', end)
      document.removeEventListener('pointercancel', end)
      // Settle onto the committed detent with the transition re-enabled.
      const snapshot = this.store.snapshot()
      if (snapshot !== undefined) this.renderEffort(snapshot)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', end)
    document.addEventListener('pointercancel', end)
  }

  /** Applies a user-driven reasoning change and pops the tier flourish. */
  private changeReasoning(index: number): void {
    const before = this.store.snapshot()?.effortTone
    const snapshot = this.store.selectReasoning(index)
    this.render(snapshot)
    if (snapshot !== undefined && snapshot.effortTone !== before) {
      this.flourish(snapshot.effortTone, snapshot.effort.label)
    }
    this.options.onChange()
  }

  /** Rhythm-game style judgement popup shown when the effort tier changes. */
  private flourish(tone: EffortTone, label: string): void {
    const burst = this.options.document.createElement('span')
    burst.className = `effort-flourish effort-flourish-${tone}`
    burst.setAttribute('aria-hidden', 'true')
    burst.textContent = label
    burst.addEventListener('animationend', () => burst.remove())
    this.effortControl.append(burst)
    // animationend does not fire when animations are disabled; sweep anyway.
    setTimeout(() => burst.remove(), 1200)
  }

  private render(snapshot: ComposerConfigurationSnapshot | undefined): void {
    if (snapshot === undefined) {
      this.toggle.disabled = true
      delete this.toggle.dataset.effort
      this.close()
      return
    }
    const { translate: t } = this.options
    this.toggle.disabled = !snapshot.input.connected || !snapshot.input.editable
    if (this.toggle.disabled) this.close()
    // Auto mode: the toggle leads with the mode and shows the model the last
    // Auto send actually landed on (it follows model switches in real time).
    if (snapshot.autoActive) {
      this.toggleModel.textContent = t('autoMode')
      this.toggleMode.textContent = snapshot.model.label
    } else {
      this.toggleModel.textContent = snapshot.model.label
      this.toggleMode.textContent = snapshot.effort.label
    }
    this.toggle.title = snapshot.autoActive
      ? t('configurationSummaryAuto', { model: snapshot.model.label })
      : t('configurationSummary', {
        model: `${snapshot.model.providerName} · ${snapshot.model.label}`,
        mode: snapshot.preset.label,
        effort: snapshot.effort.label,
      })
    this.toggle.classList.toggle('pending', snapshot.dirty)
    // Tints the toggle icon (and pending ring) with the active effort tone.
    this.toggle.dataset.effort = snapshot.effortTone
    this.renderSources(snapshot)
    this.renderModels(snapshot)
    this.renderPresets(snapshot)
    this.renderEffort(snapshot)
    this.hint.textContent = snapshot.modeStartsNewConversation
      ? t('modeStartsNewConversation')
      : t('configurationAppliesNextMessage')
  }

  private renderSources(snapshot: ComposerConfigurationSnapshot): void {
    const fragment = this.options.document.createDocumentFragment()
    for (const source of snapshot.input.sources) {
      const option = this.options.document.createElement('option')
      option.value = source.id
      option.textContent = source.label
      option.selected = source.id === snapshot.selection.provider
      fragment.append(option)
    }
    this.source.replaceChildren(fragment)
    this.source.disabled = snapshot.input.sources.length <= 1 || !snapshot.input.editable
    this.source.title = `${this.options.translate('configurationSwitchSource')}: ${snapshot.source.label}`
  }

  private renderModels(snapshot: ComposerConfigurationSnapshot): void {
    this.modelsCurrent.textContent = snapshot.model.label
    const fragment = this.options.document.createDocumentFragment()
    const groups = new Map<string, ModelConfigurationOption[]>()
    for (const model of snapshot.input.models) {
      const list = groups.get(model.provider)
      if (list === undefined) groups.set(model.provider, [model])
      else list.push(model)
    }
    if (groups.size <= 1) {
      // A single provider needs no extra level: list its models directly.
      for (const models of groups.values()) {
        for (const model of models) fragment.append(this.modelButton(snapshot, model))
      }
    } else {
      // Multiple providers get a master-detail layout: provider tabs on the
      // left rail, the open provider's models in a column on the right.
      const openProvider = this.expandedProvider ?? snapshot.selection.provider
      const layout = this.options.document.createElement('div')
      layout.className = 'configuration-provider-layout'
      const rail = this.options.document.createElement('div')
      rail.className = 'configuration-provider-rail'
      const detail = this.options.document.createElement('div')
      detail.className = 'configuration-provider-models'
      for (const [provider, models] of groups) {
        rail.append(this.providerTab(snapshot, provider, models, provider === openProvider))
        if (provider === openProvider) {
          for (const model of models) detail.append(this.modelButton(snapshot, model))
        }
      }
      layout.append(rail, detail)
      fragment.append(layout)
    }
    this.models.replaceChildren(fragment)
  }

  private providerTab(
    snapshot: ComposerConfigurationSnapshot,
    provider: string,
    models: readonly ModelConfigurationOption[],
    open: boolean,
  ): HTMLButtonElement {
    const tab = this.options.document.createElement('button')
    tab.type = 'button'
    tab.className = `configuration-provider-tab${open ? ' active' : ''}`
    tab.setAttribute('aria-pressed', String(open))
    const name = this.options.document.createElement('span')
    name.className = 'configuration-provider-name'
    name.textContent = models[0]?.providerName ?? provider
    tab.append(name)
    const selected = models.find((model) => model.provider === snapshot.selection.provider && model.id === snapshot.selection.model)
    if (selected !== undefined && !open) {
      const current = this.options.document.createElement('span')
      current.className = 'configuration-provider-current'
      current.textContent = selected.label
      tab.append(current)
    }
    const chevron = this.options.document.createElement('span')
    chevron.className = 'configuration-provider-chevron'
    chevron.setAttribute('aria-hidden', 'true')
    chevron.textContent = '›'
    tab.append(chevron)
    tab.addEventListener('click', () => {
      if (open) return
      this.expandedProvider = provider
      this.render(this.store.snapshot())
    })
    return tab
  }

  private modelButton(snapshot: ComposerConfigurationSnapshot, model: ModelConfigurationOption): HTMLButtonElement {
    const active = model.provider === snapshot.selection.provider && model.id === snapshot.selection.model
    const button = this.optionButton(model, modelIcon(model.id), active, model.providerName)
    button.addEventListener('click', () => {
      this.render(this.store.selectModel(model.provider, model.id))
      this.options.onChange()
    })
    return button
  }

  private renderPresets(snapshot: ComposerConfigurationSnapshot): void {
    this.presetsCurrent.textContent = snapshot.preset.label
    const fragment = this.options.document.createDocumentFragment()
    for (const preset of snapshot.input.presets) {
      const active = preset.id === snapshot.selection.agentPreset
      const button = this.optionButton(preset, presetIcon(preset.id), active)
      button.addEventListener('click', () => {
        this.render(this.store.selectPreset(preset.id))
        this.options.onChange()
      })
      fragment.append(button)
    }
    this.presets.replaceChildren(fragment)
  }

  private renderEffort(snapshot: ComposerConfigurationSnapshot): void {
    const { translate: t } = this.options
    this.effortControl.dataset.effort = snapshot.effortTone
    const effortLabel = snapshot.autoActive ? (snapshot.experimentalAutoEffort ? t('autoMode') : t('effortAuto')) : snapshot.effort.label
    this.effortValue.textContent = effortLabel

    if (snapshot.experimentalAutoEffort) {
      this.effortStandardRow.classList.add('hidden')
      this.effortAutoModeRow.classList.remove('hidden')
      this.autoModeToggle.classList.toggle('active', snapshot.autoActive)
      this.autoModeToggle.setAttribute('aria-checked', String(snapshot.autoActive))
      this.autoModeToggle.disabled = !snapshot.input.editable
      return
    }

    this.effortStandardRow.classList.remove('hidden')
    this.effortAutoModeRow.classList.add('hidden')
    // The Auto choice belongs to the experimental mode only: without the flag
    // the slider offers concrete tiers, so the Auto pill stays hidden.
    this.effortAuto.classList.toggle('hidden', !snapshot.experimentalAutoEffort)
    this.effortAuto.classList.toggle('active', snapshot.autoActive)
    this.effortAuto.setAttribute('aria-pressed', String(snapshot.autoActive))
    this.effortAuto.disabled = !snapshot.input.editable
    this.effortSlider.min = '0'
    this.effortSlider.max = String(Math.max(0, snapshot.reasoning.length - 1))
    this.effortSlider.step = '1'
    this.effortSlider.value = String(snapshot.effortIndex)
    // Auto owns the selected tier; the slider remains at the last concrete
    // detent for context but must not suggest that detent is being sent.
    this.effortSlider.disabled = snapshot.autoActive || snapshot.reasoning.length <= 1 || !snapshot.input.editable
    this.effortSlider.setAttribute('aria-valuetext', effortLabel)
    const fraction = snapshot.reasoning.length <= 1
      ? 0
      : snapshot.effortIndex / (snapshot.reasoning.length - 1)
    // While dragging, the pointer owns the knob/fill position.
    if (!this.effortDragging) {
      this.effortControl.style.setProperty('--effort-progress', `${fraction * 100}%`)
      this.effortControl.style.setProperty('--effort-position', String(fraction))
    }
    const fragment = this.options.document.createDocumentFragment()
    snapshot.reasoning.forEach((effort, index) => {
      const button = this.options.document.createElement('button')
      button.type = 'button'
      button.className = `effort-tick${index <= snapshot.effortIndex ? ' active' : ''}`
      button.textContent = effort.label
      button.title = effort.description ?? effort.label
      button.setAttribute('aria-label', effort.label)
      button.setAttribute('aria-current', String(index === snapshot.effortIndex))
      const position = snapshot.reasoning.length <= 1 ? 50 : index / (snapshot.reasoning.length - 1) * 100
      button.style.setProperty('--effort-stop', `${position}%`)
      button.addEventListener('click', () => {
        this.changeReasoning(index)
      })
      fragment.append(button)
    })
    this.effortTicks.replaceChildren(fragment)
  }

  private optionButton(option: ConfigurationOption, icon: string, active: boolean, providerName?: string): HTMLButtonElement {
    const document = this.options.document
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `configuration-option${active ? ' active' : ''}`
    button.setAttribute('role', 'option')
    button.setAttribute('aria-selected', String(active))
    const copy = document.createElement('span')
    copy.className = 'configuration-option-copy'
    const label = document.createElement('strong')
    label.textContent = option.label
    copy.append(label)
    if (providerName !== undefined && providerName !== '') {
      const provider = document.createElement('small')
      provider.className = 'configuration-option-provider'
      provider.textContent = providerName
      copy.append(provider)
    }
    if (option.description !== undefined && option.description !== '') {
      const description = document.createElement('small')
      description.textContent = option.description
      copy.append(description)
    }
    const iconElement = document.createElement('span')
    iconElement.className = 'configuration-option-icon'
    iconElement.textContent = icon
    const check = document.createElement('span')
    check.className = 'configuration-option-check'
    check.textContent = active ? '✓' : ''
    button.append(iconElement, copy, check)
    return button
  }
}

function requiredElement<T extends HTMLElement>(document: Document, id: string): T {
  const element = document.getElementById(id)
  if (element === null) throw new Error(`Missing composer configuration element: ${id}`)
  return element as T
}

function modelIcon(id: string): string {
  if (id.includes('flash')) return 'ϟ'
  if (id.includes('pro')) return '◆'
  return '◇'
}

function presetIcon(id: string): string {
  if (id === 'code') return '</>'
  if (id === 'minimal') return '—'
  if (id === 'cordis') return '✦'
  return '◎'
}

export type { ComposerConfigurationInput, ModelConfigurationOption }
