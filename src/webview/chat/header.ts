import { WorkbenchHeader } from '../workbench-header/component.js'
import { elements, t } from './context.js'

/** Wiring only: header UI and summary formatting live in their own modules. */
export const workbenchHeader = new WorkbenchHeader(document, elements, t)
window.addEventListener('pagehide', () => workbenchHeader.dispose(), { once: true })
