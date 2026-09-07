/**
 * The full HTML document served into a workbench webview (sidebar view or
 * editor panel). The template is localization-aware and expects the webview
 * bundle at `dist/webview/chat.js` with its stylesheets under `media/`.
 */
import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'
import { icon } from '../../webview/icons.js'
import { localizeWebviewMessages, type WebviewMessageKey } from '../../webview/localization.js'

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
  <header class="shell-header">
    <div class="brand-row">
      <button id="history-toggle" class="icon-button" title="${text('history')}" aria-label="${text('history')}">${icon('menu')}</button>
      <div class="brand"><img class="brand-logo" src="${logo}" alt=""><strong>Harness</strong><span id="connection" class="connection"></span></div>
      <div class="header-actions">
        <button id="new-session" class="icon-button" title="${text('newConversation')}" aria-label="${text('newConversation')}">${icon('plus')}</button>
        <button id="plugins-toggle" class="icon-button" title="${text('plugins')}" aria-label="${text('plugins')}" aria-expanded="false" aria-controls="plugin-panel">${icon('plugins')}</button>
        <button id="open-settings" class="icon-button" title="${text('extensionSettings')}" aria-label="${text('extensionSettings')}">${icon('settings')}</button>
      </div>
    </div>
    <div class="session-heading">
      <button id="back-parent" class="icon-button compact hidden" title="${text('backToParentAgent')}" aria-label="${text('backToParentAgent')}">${icon('back')}</button>
      <button id="session-title" class="title-button" title="${text('renameConversation')}">${text('newConversation')}</button>
      <button id="fork" class="icon-button compact" title="${text('forkConversation')}" aria-label="${text('forkConversation')}">${icon('fork')}</button>
      <button id="import-session" class="icon-button compact" title="${text('importSession')}" aria-label="${text('importSession')}">${icon('import')}</button>
      <button id="export-session" class="icon-button compact" title="${text('exportSession')}" aria-label="${text('exportSession')}">${icon('export')}</button>
      <span id="session-stats" class="session-stats" title="${text('sessionStats')}"></span>
      <span id="session-usage" class="session-usage hidden" title="${text('sessionTokenUsage')}"></span>
    </div>
  </header>

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
        </div>
        <div id="detail-content" class="detail-content"></div>
      </section>

      <div id="interactions" class="interactions"></div>
      </div>
      <section class="composer-shell">
      <div id="activity-status" class="activity-status hidden" role="status">
        <span class="activity-star" aria-hidden="true"><svg viewBox="-1.0932678 0.7196800000000001 28.9061678 21.77082" width="15" height="11.3" fill="none" aria-hidden="true"><path d="M26.5174 3.39471C26.235 3.2567 26.1137 3.52006 25.9487 3.65346C25.8923 3.69659 25.8446 3.75294 25.7969 3.80469C25.3846 4.24516 24.9027 4.53439 24.2737 4.49989C23.3536 4.44814 22.5682 4.73737 21.8735 5.44119C21.7258 4.57349 21.2353 4.0554 20.4889 3.72304C20.0985 3.55054 19.7034 3.37746 19.4297 3.00197C19.2388 2.73459 19.1865 2.43673 19.091 2.14289C19.0301 1.96579 18.9697 1.78466 18.7656 1.75418C18.5442 1.71968 18.4574 1.90541 18.3705 2.06067C18.0232 2.69549 17.8887 3.39471 17.9019 4.10313C17.9324 5.6965 18.6051 6.96556 19.9421 7.86834C20.0939 7.97184 20.133 8.07535 20.0852 8.22658C19.9938 8.53766 19.8857 8.83955 19.7903 9.15063C19.7293 9.34901 19.6384 9.39271 19.4257 9.30588C18.692 8.9994 18.0583 8.54571 17.4982 7.99772C16.5477 7.07827 15.6881 6.06336 14.6162 5.26869C14.3644 5.08296 14.1125 4.91045 13.8521 4.746C12.7584 3.68394 13.9952 2.81164 14.2816 2.70814C14.5812 2.60003 14.3857 2.22857 13.4179 2.23317C12.4502 2.2372 11.5646 2.56151 10.4359 2.99335C10.2708 3.05832 10.0972 3.10547 9.91951 3.14457C8.8954 2.95022 7.83162 2.90709 6.72069 3.03245C4.62877 3.26533 2.95777 4.25436 1.72954 5.94261C0.254043 7.97184 -0.0932678 10.2777 0.33167 12.6824C0.778458 15.2171 2.07225 17.3153 4.06008 18.9558C6.12152 20.6567 8.49577 21.4905 11.2047 21.3306C12.8498 21.2358 14.6812 21.0155 16.7473 19.2669C17.2682 19.5262 17.8151 19.6297 18.7219 19.7074C19.4205 19.7723 20.0933 19.6729 20.6143 19.5648C21.4302 19.3923 21.3739 18.6367 21.0789 18.4981C18.6874 17.3843 19.2124 17.8374 18.7351 17.4706C19.9501 16.033 21.8063 13.4776 22.379 9.99821C22.4353 9.61409 22.5072 9.073 22.4986 8.76192C22.494 8.57216 22.5377 8.49856 22.7545 8.47671C23.3536 8.40771 23.935 8.24383 24.4692 7.94999C26.0188 7.10357 26.6439 5.71318 26.7911 4.04678C26.8129 3.79204 26.7865 3.52869 26.5174 3.39471ZM13.0143 18.3946C10.6964 16.5724 9.5722 15.9726 9.10816 15.9985C8.67402 16.0244 8.75222 16.5212 8.84768 16.8449C8.94773 17.1646 9.07768 17.3849 9.25996 17.6655C9.38589 17.8512 9.47272 18.1272 9.13404 18.3348C8.38766 18.7965 7.08985 18.1796 7.0289 18.1491C5.51833 17.2595 4.25559 16.0853 3.36546 14.4793C2.50581 12.9337 2.0067 11.2753 1.92447 9.50542C1.90262 9.07818 2.02855 8.92695 2.45406 8.84932C3.01413 8.74582 3.59144 8.72397 4.15093 8.80619C6.51656 9.15178 8.53027 10.2092 10.2185 11.8848C11.1822 12.8388 11.9114 13.979 12.6623 15.0929C13.461 16.2757 14.3201 17.4027 15.4144 18.3268C15.8008 18.6505 16.109 18.8966 16.404 19.0783C15.5144 19.1778 14.0297 19.1991 13.0143 18.3958V18.3946ZM14.1252 11.2489C14.1252 11.0591 14.277 10.9079 14.4679 10.9079C14.511 10.9079 14.5501 10.9165 14.5852 10.9292C14.6329 10.9464 14.6766 10.9723 14.7111 11.0114C14.7721 11.0718 14.8066 11.158 14.8066 11.2489C14.8066 11.4386 14.6548 11.5899 14.4639 11.5899C14.273 11.5899 14.1252 11.4386 14.1252 11.2489ZM17.5759 13.0188C17.3545 13.1096 17.1331 13.1873 16.9203 13.1959C16.5903 13.2131 16.2303 13.0791 16.0348 12.9153C15.7312 12.6605 15.5139 12.5179 15.423 12.0734C15.3839 11.8837 15.4057 11.5899 15.4402 11.4214C15.5185 11.0585 15.4316 10.8257 15.1757 10.614C14.9676 10.4415 14.7025 10.3938 14.4115 10.3938C14.3029 10.3938 14.2034 10.3461 14.1292 10.3076C14.0079 10.2472 13.9078 10.096 14.0033 9.91023C14.0338 9.84985 14.1815 9.70322 14.216 9.67734C14.6111 9.45251 15.0665 9.52612 15.488 9.6946C15.8784 9.85445 16.174 10.1477 16.5989 10.5623C17.033 11.0631 17.1112 11.2011 17.3585 11.5772C17.554 11.871 17.7317 12.1729 17.8536 12.5185C17.9272 12.7341 17.8317 12.9107 17.5759 13.0188Z" fill="currentColor"></path></svg><span class="activity-spout" aria-hidden="true"><i class="stream"></i><i class="drop d1"></i><i class="drop d2"></i><i class="drop d3"></i></span></span>
        <span class="activity-verb">${text('activityWorking')}</span>
        <span id="activity-retry" class="activity-retry hidden" role="status"></span>
        <span class="activity-hint">${text('activityEscHint')}</span>
      </div>
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
