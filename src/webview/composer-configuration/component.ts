import type { PromptConfiguration } from '../../domain/prompt-configuration.js'
import type { MessageArguments, WebviewMessageKey } from '../localization.js'
import { applyIcon, icon } from '../icons.js'
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
  /** The currently staged model option, if any. */
  readonly stagedModel: () => ModelConfigurationOption | undefined
  /** Whether the staged model accepts image input; undefined when unknown. */
  readonly supportsImageInput: () => boolean | undefined
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
  private readonly modelSearch: HTMLInputElement
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
    this.modelSearch = requiredElement(document, 'configuration-model-search') as HTMLInputElement
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

  /** The model option currently staged in the model picker, if any. */
  stagedModel(): ModelConfigurationOption | undefined {
    const snapshot = this.store.snapshot()
    if (snapshot === undefined) return undefined
    // Auto mode has not resolved a concrete model yet; do not report a guess.
    if (snapshot.autoActive) return undefined
    return snapshot.model
  }

  supportsImageInput(): boolean | undefined {
    const snapshot = this.store.snapshot()
    if (snapshot === undefined) return undefined
    // Auto mode has not resolved a concrete model yet; do not block on a guess.
    if (snapshot.autoActive) return undefined
    return snapshot.model.imageInput
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
    this.modelSearch.addEventListener('input', () => {
      const snapshot = this.store.snapshot()
      if (snapshot !== undefined) this.renderModels(snapshot)
    })
    const sliderRow = this.effortSlider.parentElement ?? this.effortSlider
    this.effortSlider.addEventListener('input', () => {
      if (this.effortDragging) return
      this.changeReasoning(Number(this.effortSlider.value))
    })
    sliderRow.addEventListener('pointerdown', (event) => {
      if (event.button === 0) {
        // Suppress the native range drag entirely: on Windows Edge it fires an
        // `input` event storm while dragging, each one re-rendering the whole
        // panel and fighting the smooth overlay knob. Listening on the whole
        // row (above decorative ticks) ensures grabbing the knob or pressing
        // anywhere on the pill starts one unified continuous gesture.
        event.preventDefault()
        this.beginEffortDrag(event)
      }
    })
    sliderRow.addEventListener('wheel', (event) => {
      if (this.effortSlider.disabled) return
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
      if (target === null || typeof (target as Node).nodeType !== 'number' || this.panel.classList.contains('hidden')) return
      if (!this.panel.contains(target as Node) && !this.toggle.contains(target as Node)) this.close()
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
   * Tracks the pointer across the slider row:
   * - Grabbing the knob preserves the pointer-to-knob offset so it never jumps
   *   on press, then follows the cursor 1:1 at display refresh rate.
   * - Clicking elsewhere on the track without dragging keeps CSS transitions
   *   enabled so the knob and fill smoothly glide to the target detent.
   * - Dragging anywhere continuously interpolates knob/fill/tick highlights and
   *   magnetically settles onto the nearest detent on release.
   */
  private beginEffortDrag(start: PointerEvent): void {
    if (this.effortSlider.disabled || this.effortDragging) return
    const row = this.effortSlider.parentElement
    if (row === null) return
    const initialSnapshot = this.store.snapshot()
    if (initialSnapshot === undefined || initialSnapshot.reasoning.length <= 1) return
    const maxIndex = initialSnapshot.reasoning.length - 1
    const startTier = initialSnapshot.effortIndex
    const startTone = initialSnapshot.effortTone
    const initialFraction = startTier / maxIndex

    const initialRect = row.getBoundingClientRect()
    const travel = Math.max(1, initialRect.width - 24)
    const currentThumbX = initialRect.left + 12 + travel * initialFraction
    const grabbedThumb = initialRect.width > 24 && Math.abs(start.clientX - currentThumbX) <= 14
    let grabOffset = grabbedThumb ? start.clientX - currentThumbX : 0
    let moved = false

    this.effortDragging = true
    if (grabbedThumb) this.effortControl.classList.add('dragging')
    try {
      row.setPointerCapture?.(start.pointerId)
    } catch {
      // Synthetic test events without an active pointer id fall back to document listeners.
    }
    this.effortSlider.focus({ preventScroll: true })

    const document = this.options.document
    const view = document.defaultView ?? globalThis
    let pending: PointerEvent | undefined
    let frame: number | undefined

    const fractionAt = (clientX: number, offset: number): number => {
      const rect = row.getBoundingClientRect()
      if (rect.width <= 24) return initialFraction
      return Math.max(0, Math.min(1, (clientX - offset - rect.left - 12) / (rect.width - 24)))
    }

    const apply = (event: PointerEvent): void => {
      pending = undefined
      const fraction = fractionAt(event.clientX, grabOffset)
      this.effortControl.style.setProperty('--effort-position', String(fraction))
      this.effortControl.style.setProperty('--effort-progress', `${fraction * 100}%`)
      const tier = Math.round(fraction * maxIndex)
      this.syncEffortDrag(tier, fraction)
    }

    const move = (event: PointerEvent): void => {
      const threshold = grabbedThumb ? 0 : 3
      if (!moved && Math.abs(event.clientX - start.clientX) <= threshold && (!grabbedThumb || event.clientX === start.clientX)) {
        return
      }
      if (!moved) {
        moved = true
        if (!grabbedThumb) grabOffset = 0
        this.effortControl.classList.add('dragging')
      }
      // Coalesce high-frequency pointer events to one move per frame so the
      // knob stays glued to the cursor without layout thrashing.
      pending = event
      if (frame === undefined) {
        frame = view.requestAnimationFrame(() => {
          frame = undefined
          if (pending !== undefined) apply(pending)
        })
      }
    }

    let finished = false
    const finish = (cancelled: boolean) => {
      if (finished) return
      finished = true
      this.effortDragging = false
      this.effortControl.classList.remove('dragging')
      row.removeEventListener('lostpointercapture', onLostCapture)
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onCancel)
      try {
        if (row.hasPointerCapture?.(start.pointerId)) row.releasePointerCapture(start.pointerId)
      } catch {
        // Ignore if capture was already released.
      }
      if (frame !== undefined) {
        view.cancelAnimationFrame(frame)
        frame = undefined
      }
      if (!cancelled) {
        if (moved) {
          if (pending !== undefined) apply(pending)
        } else if (!grabbedThumb) {
          const clickFraction = fractionAt(start.clientX, 0)
          const clickTier = Math.round(clickFraction * maxIndex)
          this.store.selectReasoning(clickTier)
        }
      }
      // Settle onto the committed detent with CSS transitions re-enabled so
      // both track clicks and drag releases glide smoothly into place.
      const snapshot = this.store.snapshot()
      if (snapshot !== undefined) {
        this.renderEffort(snapshot)
        this.syncToggleSummary(snapshot)
        if (!cancelled && (snapshot.effortIndex !== startTier || snapshot.effortTone !== startTone)) {
          this.flourish(snapshot.effortTone, snapshot.effort.label)
        }
        this.options.onChange()
      }
    }
    const onUp = (event: PointerEvent) => {
      if (moved) pending = event
      finish(false)
    }
    const onCancel = () => finish(true)
    const onLostCapture = () => finish(!moved)

    row.addEventListener('lostpointercapture', onLostCapture)
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onCancel)
  }

  /**
   * Light drag-follow: stage the nearest tier and update the effort label /
   * tone / tick highlights continuously without rebuilding the panel DOM.
   */
  private syncEffortDrag(index: number, fraction: number): void {
    const snapshot = this.store.selectReasoning(index)
    if (snapshot === undefined) return
    this.effortControl.dataset.effort = snapshot.effortTone
    this.effortValue.textContent = snapshot.effort.label
    this.effortSlider.value = String(snapshot.effortIndex)
    this.effortSlider.setAttribute('aria-valuetext', snapshot.effort.label)
    this.syncToggleSummary(snapshot)
    const maxIndex = Math.max(1, snapshot.reasoning.length - 1)
    for (let i = 0; i < this.effortTicks.children.length; i += 1) {
      const tick = this.effortTicks.children[i]
      if (tick === undefined) continue
      const stopFraction = i / maxIndex
      const active = stopFraction <= fraction + 0.015
      tick.classList.toggle('active', active)
      tick.setAttribute('aria-current', String(i === snapshot.effortIndex))
    }
  }

  private syncToggleSummary(snapshot: ComposerConfigurationSnapshot): void {
    const { translate: t } = this.options
    if (snapshot.autoActive) {
      this.toggleModel.textContent = t('autoMode')
      this.toggleMode.textContent = t('effortAuto')
    } else {
      this.toggleModel.textContent = shortModelLabel(snapshot.model.label)
      this.toggleMode.textContent = snapshot.effort.label
    }
    this.toggle.title = snapshot.autoActive
      ? t('configurationSummaryAuto')
      : t('configurationSummary', {
        model: `${snapshot.model.providerName} · ${snapshot.model.label}`,
        mode: snapshot.preset.label,
        effort: snapshot.effort.label,
      })
    this.toggle.classList.toggle('pending', snapshot.dirty)
    this.toggle.dataset.effort = snapshot.effortTone
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
    this.syncToggleSummary(snapshot)
    this.renderSources(snapshot)
    this.renderModels(snapshot)
    this.renderPresets(snapshot)
    this.renderEffort(snapshot)
    this.hint.textContent = snapshot.presetLocked
      ? t('sessionPresetLocked')
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
    this.modelsCurrent.textContent = snapshot.autoActive ? this.options.translate('autoMode') : snapshot.model.label
    const fragment = this.options.document.createDocumentFragment()
    const groups = new Map<string, ModelConfigurationOption[]>()
    const query = this.modelSearch.value.trim().toLowerCase()
    const visibleModels = snapshot.input.models.filter((model) => query === ''
      || `${model.providerName} ${model.label} ${model.id} ${model.description ?? ''}`.toLowerCase().includes(query))
    for (const model of visibleModels) {
      const list = groups.get(model.provider)
      if (list === undefined) groups.set(model.provider, [model])
      else list.push(model)
    }
    if (visibleModels.length === 0) {
      const empty = this.options.document.createElement('p')
      empty.className = 'configuration-empty'
      empty.textContent = this.options.translate('noMatchingModels')
      fragment.append(empty)
    } else if (groups.size <= 1) {
      // A single provider needs no extra level: list its models directly.
      for (const models of groups.values()) {
        fragment.append(this.modelList(snapshot, models))
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
        if (provider === openProvider) detail.append(this.modelList(snapshot, models))
      }
      layout.append(rail, detail)
      fragment.append(layout)
    }
    this.models.replaceChildren(fragment)
  }

  /**
   * Renders a provider's model column as a scrollable list: the container is
   * sized to a four-row viewport (see .configuration-model-list in chat.css)
   * and the rest of the catalog is reached by scrolling. The currently
   * selected model is scrolled into view on first paint.
   */
  private modelList(snapshot: ComposerConfigurationSnapshot, models: readonly ModelConfigurationOption[]): HTMLElement {
    const { document } = this.options
    const container = document.createElement('div')
    container.className = 'configuration-model-list'
    for (const model of models) container.append(this.modelButton(snapshot, model))
    // Bring the active row into the four-row viewport after the buttons land.
    queueMicrotask(() => {
      const active = container.querySelector('.configuration-option.active')
      active?.scrollIntoView({ block: 'nearest' })
    })
    return container
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
      current.textContent = snapshot.autoActive ? this.options.translate('autoMode') : selected.label
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
      button.disabled = !snapshot.input.blank || !snapshot.input.editable
      if (!snapshot.input.blank) button.title = this.options.translate('sessionPresetLocked')
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
    const signature = snapshot.reasoning.map((effort) => effort.id).join('\0')
    if (this.effortTicks.dataset.signature !== signature) {
      const fragment = this.options.document.createDocumentFragment()
      snapshot.reasoning.forEach((effort, index) => {
        const tick = this.options.document.createElement('span')
        tick.className = 'effort-tick'
        tick.setAttribute('aria-hidden', 'true')
        const position = snapshot.reasoning.length <= 1 ? 50 : index / (snapshot.reasoning.length - 1) * 100
        tick.style.setProperty('--effort-stop', `${position}%`)
        fragment.append(tick)
      })
      this.effortTicks.replaceChildren(fragment)
      this.effortTicks.dataset.signature = signature
    }
    if (!this.effortDragging) {
      for (let index = 0; index < this.effortTicks.children.length; index += 1) {
        const tick = this.effortTicks.children[index]
        if (tick === undefined) continue
        tick.classList.toggle('active', index <= snapshot.effortIndex)
        tick.setAttribute('aria-current', String(index === snapshot.effortIndex))
      }
    }
  }

  private optionButton(option: ConfigurationOption, iconValue: string, active: boolean, providerName?: string): HTMLButtonElement {
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
    applyIcon(iconElement, iconValue)
    const check = document.createElement('span')
    check.className = 'configuration-option-check'
    applyIcon(check, active ? icon('check', 13) : '')
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

/** Maps one agent preset id to its compact toolbar glyph. */
function presetIcon(id: string): string {
  if (id === 'code' || id === 'ptc') return '</>'
  if (id === 'minimal') return '—'
  if (id === 'cordis') return icon('sparkle', 11)
  return '◎'
}

/**
 * Strips redundant provider/org prefixes (e.g. `deepseek/deepseek-v4-pro` -> `deepseek-v4-pro`)
 * so the pill button remains clean and does not crowd out adjacent toolbar controls.
 */
function shortModelLabel(label: string): string {
  const parts = label.split('/')
  return parts.length > 1 ? parts[parts.length - 1]! : label
}

export type { ComposerConfigurationInput, ModelConfigurationOption }
