/**
 * The full HTML document served into a workbench webview (sidebar view or
 * editor panel). The template is localization-aware and expects the webview
 * bundle at `dist/webview/chat.js` with its stylesheets under `media/`.
 */
import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'
import { icon } from '../../webview/icons.js'
import { localizeWebviewMessages, type WebviewMessageKey } from '../../webview/localization.js'
import { headerHtml } from './header-html.js'

export function workbenchHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = randomBytes(18).toString('base64')
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'chat.js'))
    const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chat.css'))
    const responsiveStyle = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chat-responsive.css'))
    const logo = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'deepseek-harness.png'))
    const messages = localizeWebviewMessages((message) => vscode.l10n.t(message))
    const text = (key: WebviewMessageKey): string => escapeHtml(messages[key])
    const language = escapeHtml(vscode.env.language)
    const localization = jsonForInlineScript({ language: vscode.env.language, messages })
    return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    .hidden { display: none !important; }
    #loading {
      position: fixed;
      inset: 0;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3px;
      padding: 30px 20px;
      text-align: center;
      color: var(--vscode-descriptionForeground, #9d9d9d);
      background: var(--vscode-editor-background, #1e1e1e);
    }
    #loading.hidden { display: none !important; }
    .startup-logo { width: 56px; height: 56px; object-fit: contain; opacity: .92; animation: startup-float 2.2s ease-in-out infinite; }
    .startup-dots { height: 18px; margin-top: 10px; display: flex; align-items: center; gap: 5px; }
    .startup-dots span { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-progressBar-background, #0e639c); animation: startup-dot 1.1s ease-in-out infinite; }
    .startup-dots span:nth-child(2) { animation-delay: 140ms; }
    .startup-dots span:nth-child(3) { animation-delay: 280ms; }
    @keyframes startup-float { 50% { transform: translateY(-4px); } }
    @keyframes startup-dot {
      0%, 60%, 100% { transform: translateY(0); opacity: .5; }
      30% { transform: translateY(-6px); opacity: 1; }
    }
  </style>
  <link rel="stylesheet" href="${style}">
  <link rel="stylesheet" href="${responsiveStyle}">
  <title>DeepSeek Harness</title>
</head>
<body>
  ${headerHtml(String(logo), text)}

  <section id="key-banner" class="key-banner hidden">
    <span>${text('apiKeyRequired')}</span>
    <button id="set-api-key">${text('configure')}</button>
  </section>

  <aside id="history-panel" class="history-panel hidden" aria-label="${text('history')}">
    <div class="panel-heading">
      <strong>${text('history')}</strong>
      <div class="panel-heading-actions">
        <button id="history-archived" class="history-archive-toggle" type="button" aria-pressed="false" title="${text('archivedConversations')}">${text('archivedConversations')}</button>
        <button id="history-import" class="icon-button compact" title="${text('importSession')}" aria-label="${text('importSession')}">${icon('import')}</button>
        <button id="history-close" class="icon-button">${icon('close')}</button>
      </div>
    </div>
    <input id="history-search" class="search-input" type="search" placeholder="${text('searchConversations')}">
    <div id="session-list" class="session-list"></div>
  </aside>

  <aside id="plugin-panel" class="plugin-panel hidden" aria-label="${text('pluginCenter')}">
    <header class="plugin-panel-heading">
      <div><strong>${text('pluginCenter')}</strong><small>web profile</small></div>
      <div class="plugin-panel-actions">
        <button id="plugin-refresh" class="icon-button compact" title="${text('refreshPlugins')}" aria-label="${text('refreshPlugins')}">${icon('refresh')}</button>
        <button id="plugin-close" class="icon-button compact" title="${text('closePluginCenter')}" aria-label="${text('closePluginCenter')}">${icon('close')}</button>
      </div>
    </header>
    <nav class="plugin-tabs" aria-label="${text('pluginCenter')}">
      <button class="active" data-plugin-tab="marketplace">${text('pluginMarketplace')}</button>
      <button data-plugin-tab="installed">${text('installedPlugins')}</button>
    </nav>
    <section id="plugin-marketplace-view" class="plugin-panel-view">
      <div class="plugin-filter-row">
        <input id="plugin-search" class="search-input" type="search" placeholder="${text('searchPlugins')}" aria-label="${text('searchPlugins')}">
        <select id="plugin-category" class="plugin-category" aria-label="${text('allCategories')}"></select>
      </div>
      <p class="plugin-security-notice">${icon('warning', 12)} ${text('pluginSecurityNotice')}</p>
      <div id="plugin-marketplace-list" class="plugin-list"></div>
      <button id="plugin-load-more" class="secondary-button hidden" type="button">${text('loadMorePlugins')}</button>
      <footer class="plugin-source-footer">
        <span id="plugin-summary"></span>
        <span><button id="plugin-source" class="link-button" type="button">${text('curatedPlugins')}</button> · <button id="plugin-topic" class="link-button" type="button">${text('browsePluginTopic')}</button></span>
      </footer>
    </section>
    <section id="plugin-installed-view" class="plugin-panel-view hidden">
      <form id="plugin-custom-form" class="plugin-custom-form">
        <strong>${text('installCustomPlugin')}</strong>
        <div><input id="plugin-custom-spec" class="search-input" type="text" placeholder="${text('customPluginPlaceholder')}" aria-label="${text('customPluginPlaceholder')}"><button class="primary-button" type="submit">${text('install')}</button></div>
      </form>
      <p class="plugin-compatibility-notice">${text('nativeUiCompatibilityNotice')}</p>
      <div id="plugin-installed-list" class="plugin-list"></div>
    </section>
    <div id="plugin-status" class="plugin-status hidden" role="status"></div>
  </aside>

  <main id="workbench" class="workbench">
    <section id="loading" class="center-state startup-screen">
      <img class="startup-logo" src="${logo}" alt="">
      <div class="startup-dots" aria-hidden="true"><span></span><span></span><span></span></div>
      <h2>${text('startingHarness')}</h2>
      <p>${text('startingHarnessDescription')}</p>
    </section>
    <section id="error" class="center-state hidden">
      <div class="error-icon">!</div><h2>${text('connectionFailed')}</h2><p id="error-message"></p>
      <div class="state-actions"><button id="retry" class="primary-button">${text('retry')}</button><button id="show-logs" class="secondary-button">${text('logs')}</button></div>
    </section>
    <section id="chat" class="chat hidden">
      <div id="transcript-scroll" class="transcript-scroll">
      <div id="transcript-content" class="transcript-content">
      <div id="conversation" class="conversation">
        <button id="load-older" class="load-older hidden">${text('loadOlder')}</button>
        <section id="empty" class="empty-state">
          <img class="empty-logo" src="${logo}" alt=""><h2>${text('emptyTitle')}</h2><p>${text('emptyDescription')}</p>
        </section>
        <div id="messages" class="messages" aria-live="polite"></div>
      </div>

      <section id="details" class="details hidden">
        <div class="detail-tabs">
          <button data-detail="todos" class="active">${text('plan')} <span id="todo-count">0</span></button>
          <button data-detail="goal">Goal</button>
          <button data-detail="skills">${text('skills')} <span id="skill-count">0</span></button>
          <button data-detail="agents">${text('agents')} <span id="agent-count">0</span></button>
          <button data-detail="jobs">${text('jobs')} <span id="job-count">0</span></button>
          <button data-detail="timeline">${text('timeline')}</button>
          <button data-detail="runtime">${text('runtimeContext')}</button>
        </div>
        <div id="detail-content" class="detail-content"></div>
      </section>

      <div id="interactions" class="interactions"></div>
      </div>
      <div id="composer-dock" class="composer-dock">
      <section class="composer-shell">
        <section id="configuration-panel" class="configuration-panel hidden" role="dialog" aria-label="${text('configurationTitle')}">
          <header class="configuration-panel-header">
            <strong>${text('configurationTitle')}</strong>
            <label class="configuration-source-switch">
              <span>${text('configurationSource')}</span>
              <select id="configuration-source" aria-label="${text('configurationSwitchSource')}" title="${text('configurationSwitchSource')}"></select>
            </label>
            <button id="configuration-close" class="icon-button compact" type="button" title="${text('configurationClose')}" aria-label="${text('configurationClose')}">×</button>
          </header>
          <div class="configuration-panel-scroll">
            <section class="configuration-group configuration-model-group collapsed" aria-labelledby="configuration-models-label">
              <h3 id="configuration-models-label">
                <button id="configuration-models-toggle" class="configuration-group-toggle" type="button" aria-expanded="false" aria-controls="configuration-models">
                  <span class="configuration-group-chevron" aria-hidden="true">›</span>
                  <span>${text('configurationModels')}</span>
                  <span id="configuration-models-current" class="configuration-group-current"></span>
                </button>
              </h3>
              <div id="configuration-models" class="configuration-options" role="listbox"></div>
            </section>
            <section class="configuration-group collapsed" aria-labelledby="configuration-modes-label">
              <h3 id="configuration-modes-label">
                <button id="configuration-presets-toggle" class="configuration-group-toggle" type="button" aria-expanded="false" aria-controls="configuration-presets">
                  <span class="configuration-group-chevron" aria-hidden="true">›</span>
                  <span>${text('configurationModes')}</span>
                  <span id="configuration-presets-current" class="configuration-group-current"></span>
                </button>
              </h3>
              <div id="configuration-presets" class="configuration-options" role="listbox"></div>
            </section>
          </div>
          <footer id="effort-control" class="effort-control" data-effort="high">
            <div id="effort-standard-row" class="effort-main">
              <div class="effort-heading"><span>${text('configurationEffort')}</span><strong id="effort-value"></strong></div>
              <div class="effort-slider-row">
                <input id="effort-slider" type="range" min="0" max="2" step="1" value="1" aria-label="${text('configurationEffort')}">
                <div id="effort-ticks" class="effort-ticks"></div>
                <span class="effort-thumb" aria-hidden="true"></span>
              </div>
              <button id="effort-auto" class="effort-auto" type="button" aria-pressed="false" title="${text('effortAutoDescription')}">${text('effortAuto')}</button>
            </div>
            <div id="effort-auto-mode-row" class="effort-auto-mode-row hidden">
              <div class="auto-mode-label">
                <svg class="auto-mode-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="12" cy="5" r="2.5"></circle>
                  <circle cx="6" cy="18" r="2.5"></circle>
                  <circle cx="18" cy="18" r="2.5"></circle>
                  <path d="M10.2 7.2L7.8 15.5"></path>
                  <path d="M13.8 7.2L16.2 15.5"></path>
                  <path d="M8.5 18h7"></path>
                </svg>
                <span>${text('autoMode')}</span>
              </div>
              <button id="auto-mode-toggle" class="auto-mode-switch" type="button" role="switch" aria-checked="false" aria-label="${text('autoModeDescription')}" title="${text('autoModeDescription')}">
                <span class="auto-mode-switch-track">
                  <span class="auto-mode-switch-thumb"></span>
                </span>
              </button>
            </div>
            <p id="configuration-hint">${text('configurationAppliesNextMessage')}</p>
          </footer>
        </section>
        <div id="editor-context-list" class="editor-context-list hidden" aria-label="${text('attachedContext')}"></div>
        <div id="image-preview-list" class="image-preview-list hidden" aria-label="${text('imageAttachments')}"></div>
        <div id="timeline-panel" class="timeline-panel hidden" role="listbox" aria-label="${text('timeline')}"></div>
        <div id="file-mention-menu" class="file-mention-menu hidden" role="listbox" aria-label="${text('workspaceFiles')}"></div>
        <div id="command-menu" class="command-menu hidden" role="listbox" aria-label="${text('slashCommands')}"></div>
        <div id="queued-panel" class="queued-panel hidden" aria-label="${text('queuedMessages')}"></div>
        <textarea id="prompt" rows="1" placeholder="${text('promptPlaceholder')}" aria-label="${text('message')}"></textarea>
        <div class="composer-bar">
          <div class="composer-tools">
            <button id="attach-selection" class="text-button hidden" title="${text('attachSelection')}">${icon('attach', 12)} ${text('selection')}</button>
            <button id="timeline-toggle" class="text-button hidden" title="${text('timeline')}">${icon('timeline', 12)} ${text('timeline')}</button>
            <button id="details-toggle" class="text-button" title="${text('contextDescription')}">${text('context')}</button>
            <div id="permission" class="permission-picker hidden">
              <button id="permission-toggle" class="permission-toggle" type="button" title="${text('permissionDescription')}" aria-label="${text('permissionDescription')}" aria-haspopup="listbox" aria-expanded="false">
                <span class="permission-toggle-icon">◆</span>
                <span id="permission-toggle-label" class="permission-toggle-label"></span>
                <span class="permission-toggle-chevron">⌄</span>
              </button>
              <div id="permission-popup" class="permission-popup hidden" role="listbox" aria-label="${text('permissionDescription')}">
                <div class="permission-popup-title">${text('permissionLabel')}</div>
                <div id="permission-options" class="permission-options" role="presentation"></div>
              </div>
              <div id="permission-confirm" class="permission-confirm hidden" role="alertdialog" aria-labelledby="permission-confirm-title" aria-describedby="permission-confirm-warning">
                <div id="permission-confirm-title" class="permission-confirm-title">${icon('warning', 14)} ${text('permissionFullAccessTitle')}</div>
                <p id="permission-confirm-warning" class="permission-confirm-warning">${text('permissionFullAccessWarning')}</p>
                <div class="permission-confirm-actions">
                  <button id="permission-confirm-cancel" class="permission-confirm-cancel" type="button">${text('cancel')}</button>
                  <button id="permission-confirm-accept" class="permission-confirm-accept" type="button">${text('permissionFullAccessConfirm')}</button>
                </div>
              </div>
            </div>
          </div>
          <div class="composer-meta">
            <span id="composer-status" class="composer-status"></span>
          </div>
          <div class="composer-actions">
            <button id="context-meter" class="context-meter hidden" type="button" title="${text('compact')}" aria-label="${text('compact')}">
              <span class="context-meter-ring" aria-hidden="true"></span>
              <span id="context-meter-value" class="context-meter-value"></span>
            </button>
            <button id="configuration-toggle" class="configuration-toggle" type="button" title="${text('configurationOpen')}" aria-label="${text('configurationOpen')}" aria-expanded="false" aria-controls="configuration-panel" disabled>
              <span id="configuration-toggle-model" class="configuration-toggle-model">${text('model')}</span>
              <span id="configuration-toggle-mode" class="configuration-toggle-effort">${text('reasoning')}</span>
              <span class="configuration-toggle-chevron">⌄</span>
            </button>
            <button id="send" class="send-button" title="${text('sendTitle')}" aria-label="${text('send')}">↑</button>
          </div>
        </div>
      </section>
      <p id="composer-hint" class="composer-hint">${text('composerHint')}</p>
      </div>
      </div>
    </section>
  </main>
  <section id="settings-panel" class="settings-panel hidden" role="dialog" aria-label="${text('connectionSettings')}">
    <div class="settings-card">
      <header class="settings-header">
        <strong>${text('connectionSettings')}</strong>
        <button id="settings-close" class="icon-button compact" type="button" title="${text('closeSettings')}" aria-label="${text('closeSettings')}">${icon('close')}</button>
      </header>
      <div class="settings-body">
        <div class="settings-field">
          <span class="settings-label">${text('provider')}</span>
          <select id="settings-provider" class="settings-select"></select>
        </div>
        <div class="settings-field hidden" id="settings-name-field">
          <span class="settings-label">${text('providerName')}</span>
          <input id="settings-name" type="text" spellcheck="false" autocomplete="off" placeholder="${text('providerNamePlaceholder')}">
        </div>
        <div class="settings-field" id="settings-base-url-field">
          <span class="settings-label">${text('baseUrl')}</span>
          <input id="settings-base-url" type="text" spellcheck="false" autocomplete="off" aria-label="${text('baseUrl')}" placeholder="https://api.deepseek.com">
          <span id="settings-base-url-error" class="settings-error hidden"></span>
        </div>
        <label class="settings-field">
          <span class="settings-label">${text('apiKey')}</span>
          <input id="settings-api-key" type="password" spellcheck="false" autocomplete="off" placeholder="${text('apiKeyPlaceholder')}">
        </label>
        <label class="settings-field hidden" id="settings-models-field">
          <span class="settings-label">${text('providerModels')}</span>
          <input id="settings-models" type="text" spellcheck="false" autocomplete="off" placeholder="${text('providerModelsPlaceholder')}">
          <small class="settings-hint">${text('providerModelsHint')}</small>
        </label>
        <label class="settings-checkbox-field" id="settings-experimental-auto-effort-field">
          <input id="settings-experimental-auto-effort" type="checkbox">
          <span class="settings-label">${text('experimentalAutoEffort')}</span>
        </label>
        <div class="settings-test-row">
          <button id="settings-test" class="secondary-button" type="button">${text('testConnection')}</button>
          <span id="settings-test-result" class="settings-status hidden"></span>
        </div>
        <p class="settings-hint">${text('settingsHint')}</p>
      </div>
      <footer class="settings-footer">
        <button id="settings-delete" class="secondary-button hidden" type="button">${text('remove')}</button>
        <button id="settings-open-native" class="secondary-button" type="button">${text('openNativeSettings')}</button>
        <button id="settings-apply" class="primary-button" type="button">${text('apply')}</button>
      </footer>
    </div>
  </section>

  <div id="image-lightbox" class="image-lightbox hidden" role="dialog" aria-modal="true" aria-label="${text('imagePreview')}">
    <div class="image-lightbox-backdrop"></div>
    <figure class="image-lightbox-content">
      <img id="image-lightbox-image" alt="">
      <figcaption id="image-lightbox-name"></figcaption>
      <button id="image-lightbox-close" class="image-lightbox-close" type="button" title="${text('closeImagePreview')}" aria-label="${text('closeImagePreview')}">×</button>
    </figure>
  </div>
  <script nonce="${nonce}">globalThis.__DEEPSEEK_HARNESS_LOCALIZATION__=${localization};</script>
  <script nonce="${nonce}">
    // Surface webview-side failures to the host Output channel: a blank panel
    // (e.g. a view restored into the editor area) is otherwise silent.
    (function () {
      try {
        var post = function (message) {
          try { acquireVsCodeApi().postMessage({ type: 'webviewError', message: String(message) }); } catch (e) { /* no host */ }
        };
        window.addEventListener('error', function (event) { post('error: ' + (event.message || 'unknown') + ' @ ' + (event.filename || '?') + ':' + String(event.lineno || 0)); });
        window.addEventListener('unhandledrejection', function (event) { post('unhandledrejection: ' + String(event.reason)); });
      } catch (e) { /* ignore */ }
    }());
  </script>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`
  }

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}
