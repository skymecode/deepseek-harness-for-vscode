/**
 * Workbench icon set.
 *
 * Every UI icon must come from here as an inline, monochrome SVG. Unicode
 * symbol glyphs are emoji-presentation eligible (Segoe UI Emoji on Windows
 * renders gear/warning/bolt/flag as colorful emoji while macOS shows
 * monochrome text — a cross-platform inconsistency), so no emoji-presentation
 * characters are allowed in the workbench chrome. SVGs use currentColor so
 * VS Code theme tokens color them in dark / light / high-contrast alike.
 */
export type IconName =
  | 'menu' | 'plus' | 'plugins' | 'settings' | 'back' | 'fork' | 'import'
  | 'export' | 'close' | 'refresh' | 'timeline' | 'details' | 'attach'
  | 'pin' | 'unpin' | 'archive' | 'restore' | 'sendNow' | 'warning'
  | 'terminal' | 'edit' | 'read' | 'search' | 'web' | 'workflow'
  | 'subagent' | 'tool' | 'check' | 'cancel' | 'chevron' | 'checkSquare'
  | 'star' | 'sparkle' | 'question' | 'image' | 'atom' | 'bulb' | 'doc' | 'skillDoc' | 'spinner' | 'processing'

const PATHS: Record<IconName, string> = {
  menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  plugins: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  fork: '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  import: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  export: '<path d="M12 21V9M7 14l5-5 5 5M5 3h14"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/>',
  timeline: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  details: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  attach: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  pin: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
  unpin: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/><path d="M3 3l18 18"/>',
  archive: '<path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/>',
  restore: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
  sendNow: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  warning: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/><path d="M12 9v4M12 17h.01"/>',
  terminal: '<path d="m4 17 6-5-6-5M12 19h8"/>',
  edit: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  read: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/>',
  web: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  workflow: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  subagent: '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  cancel: '<path d="M18 6 6 18M6 6l12 12"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  checkSquare: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
  star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M12 7l1.2 3.8L17 12l-3.8 1.2L12 17l-1.2-3.8L7 12l3.8-1.2L12 7z"/>',
  question: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  /** DeepSeek Harness "thinking" mark: four petals around a center dot. */
  atom: '<circle cx="12" cy="12" r="1.4"/><ellipse cx="12" cy="11" rx="7.2" ry="3.6" transform="rotate(0 12 12)"/><ellipse cx="12" cy="11" rx="7.2" ry="3.6" transform="rotate(90 12 12)"/>',
  /** Thinking card: neutral bulb, with live color supplied by the theme. */
  bulb: '<path d="M9 18h6M10 21h4M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 4H9c0-2 0-3-1-4ZM12 1v1M3 4l1 1M20 5l1-1M1 10h1M22 10h1"/>',
  /** Read-style document: rounded page with two text lines. */
  doc: '<rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M9 8.5h6M9 12.5h6"/>',
  /** Skill: document with a sparkle on the top-right corner. */
  skillDoc: '<rect x="4.5" y="4" width="13" height="15.5" rx="2.5"/><path d="M8 8.5h6M8 12h4"/><path d="M18.5 2.5v4M16.5 4.5h4"/><path d="M19.5 6.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6.6-1.4z"/>',
  /** In-flight spinner arc (VS Code sync~spin style); rotate via CSS spin. */
  spinner: '<path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v6h-6"/>',
  /** Two open arcs for the model handoff indicator; rotated as one SVG. */
  processing: '<path d="M21 12a9 9 0 1 0-9 9"/><path d="M7 12a5 5 0 1 0 5-5"/>',
}

/** Inline SVG markup for a named icon, sized in px, colored by the theme via currentColor. */
export function icon(name: IconName, size = 14): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + PATHS[name] + '</svg>'
}

/**
 * Sets an element's content to an SVG icon, or falls back to a plain text
 * glyph for the few deliberately text-only marks. Works in the webview DOM.
 */
export function applyIcon(element: HTMLElement, value: string): void {
  if (value.startsWith('<svg')) element.innerHTML = value
  else element.textContent = value
}
