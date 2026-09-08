import { icon } from '../../webview/icons.js'
import type { WebviewMessageKey } from '../../webview/localization.js'

/** Single-row chrome; uncommon actions and full stats do not compete for title width. */
export function headerHtml(logo: string, text: (key: WebviewMessageKey) => string): string {
  return `<header class="shell-header">
    <div class="header-row">
      <button id="history-toggle" class="icon-button" title="${text('history')}" aria-label="${text('history')}">${icon('menu')}</button>
      <button id="back-parent" class="icon-button compact hidden" title="${text('backToParentAgent')}" aria-label="${text('backToParentAgent')}">${icon('back')}</button>
      <img class="brand-logo" src="${logo}" alt="">
      <button id="session-title" class="title-button" title="${text('renameConversation')}">${text('newConversation')}</button>
      <span id="connection" class="connection" role="status"></span>
      <div class="header-actions">
        <button id="new-session" class="icon-button" title="${text('newConversation')}" aria-label="${text('newConversation')}">${icon('plus')}</button>
        <button id="plugins-toggle" class="icon-button" title="${text('plugins')}" aria-label="${text('plugins')}" aria-expanded="false" aria-controls="plugin-panel">${icon('plugins')}</button>
        <button id="header-menu-toggle" class="icon-button" title="${text('moreActions')}" aria-label="${text('moreActions')}" aria-haspopup="dialog" aria-expanded="false" aria-controls="header-menu">${icon('more')}</button>
      </div>
    </div>
    <section id="header-menu" class="header-menu hidden" role="dialog" aria-label="${text('moreActions')}">
      <button id="fork" class="header-menu-action" type="button">${icon('fork')}<span>${text('forkConversation')}</span></button>
      <button id="import-session" class="header-menu-action" type="button">${icon('import')}<span>${text('importSession')}</span></button>
      <button id="export-session" class="header-menu-action" type="button">${icon('export')}<span>${text('exportSession')}</span></button>
      <button id="open-settings" class="header-menu-action" type="button">${icon('settings')}<span>${text('extensionSettings')}</span></button>
      <div id="header-stats" class="header-stats hidden">
        <strong>${text('sessionStats')}</strong>
        <span id="session-stats" class="session-stats"></span>
        <span id="session-usage" class="session-usage hidden" title="${text('sessionTokenUsage')}"></span>
      </div>
    </section>
  </header>`
}
