import type { PromptConfiguration } from '../../domain/prompt-configuration.js'
import type { MessageArguments, WebviewMessageKey } from '../localization.js'
import { ComposerConfigurationStore, modelsForSource } from './store.js'
import type {
  ComposerConfigurationInput,
  ComposerConfigurationSnapshot,
  ConfigurationOption,
  ConfigurationSection,
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
  private readonly panel: HTMLElement
  private readonly toggle: HTMLButtonElement
  private readonly toggleModel: HTMLElement
  private readonly toggleMode: HTMLElement
  private readonly closeButton: HTMLButtonElement
  private readonly source: HTMLSelectElement
  private readonly models: HTMLElement
  private readonly presets: HTMLElement
  private readonly effortControl: HTMLElement
  private readonly effortValue: HTMLElement
  private readonly effortSlider: HTMLInputElement
  private readonly effortTicks: HTMLElement
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
    this.effortControl = requiredElement(document, 'effort-control')
    this.effortValue = requiredElement(document, 'effort-value')
    this.effortSlider = requiredElement(document, 'effort-slider')
    this.effortTicks = requiredElement(document, 'effort-ticks')
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

  private bindEvents(): void {
    this.toggle.addEventListener('click', () => {
      if (this.panel.classList.contains('hidden')) this.open()
      else this.close()
    })
    this.closeButton.addEventListener('click', () => this.close())
    this.source.addEventListener('change', () => {
      this.render(this.store.selectSource(this.source.value))
      this.options.onChange()
    })
    this.effortSlider.addEventListener('input', () => {
      this.render(this.store.selectReasoning(Number(this.effortSlider.value)))
      this.options.onChange()
    })
    this.effortSlider.addEventListener('wheel', (event) => {
      event.preventDefault()
      const direction = event.deltaY > 0 ? 1 : -1
      this.render(this.store.selectReasoning(Number(this.effortSlider.value) + direction))
      this.options.onChange()
    }, { passive: false })
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

  private render(snapshot: ComposerConfigurationSnapshot | undefined): void {
    if (snapshot === undefined) {
      this.toggle.disabled = true
      this.close()
      return
    }
    const { translate: t } = this.options
    this.toggle.disabled = !snapshot.input.connected || !snapshot.input.editable
    if (this.toggle.disabled) this.close()
    this.toggleModel.textContent = snapshot.model.label
    this.toggleMode.textContent = snapshot.preset.label
    this.toggle.title = t('configurationSummary', {
      model: snapshot.model.label,
      mode: snapshot.preset.label,
      effort: snapshot.effort.label,
    })
    this.toggle.classList.toggle('pending', snapshot.dirty)
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
    const fragment = this.options.document.createDocumentFragment()
    for (const model of modelsForSource(snapshot.input.models, snapshot.selection.provider)) {
      const active = model.provider === snapshot.selection.provider && model.id === snapshot.selection.model
      const button = this.optionButton(model, modelIcon(model.id), active)
      button.addEventListener('click', () => {
        this.render(this.store.selectModel(model.provider, model.id))
        this.options.onChange()
      })
      fragment.append(button)
    }
    this.models.replaceChildren(fragment)
  }

  private renderPresets(snapshot: ComposerConfigurationSnapshot): void {
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
    this.effortControl.dataset.effort = snapshot.effortTone
    this.effortValue.textContent = snapshot.effort.label
    this.effortSlider.min = '0'
    this.effortSlider.max = String(Math.max(0, snapshot.reasoning.length - 1))
    this.effortSlider.step = '1'
    this.effortSlider.value = String(snapshot.effortIndex)
    this.effortSlider.disabled = snapshot.reasoning.length <= 1 || !snapshot.input.editable
    this.effortSlider.setAttribute('aria-valuetext', snapshot.effort.label)
    const progress = snapshot.reasoning.length <= 1
      ? 0
      : snapshot.effortIndex / (snapshot.reasoning.length - 1) * 100
    this.effortControl.style.setProperty('--effort-progress', `${progress}%`)
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
        this.render(this.store.selectReasoning(index))
        this.options.onChange()
      })
      fragment.append(button)
    })
    this.effortTicks.replaceChildren(fragment)
  }

  private optionButton(option: ConfigurationOption, icon: string, active: boolean): HTMLButtonElement {
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
