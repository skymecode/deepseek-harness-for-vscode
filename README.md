# DeepSeek Harness for VS Code

**English** | [简体中文](README.zh-CN.md)

A native VS Code coding-agent extension powered by [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Install the platform-specific VSIX and start working—there is no upstream repository to clone, no Node/npm setup, and no local Harness deployment to manage.

> Community-maintained **0.6.2 stable extension release**, bundling the official `@deepseek-ai/dsh@0.2.2-rc.1` package (Typert Remote protocol) and standalone Node `24.22.2`. The bundled DSH runtime is a release candidate, and DeepSeek Harness remains a Developer Preview.

This release unifies saved session history with official DSH, groups conversations by their original project folder, adds native MCP management, and fixes duplicate or out-of-order prompts. See the [Chinese release notes](CHANGELOG.md#062).

> **Runtime upgrade:** Harness now uses session format V4. Supported older logs are migrated on resume into a new generation while their original files are preserved. Old runtimes cannot read the new V4 generation; back up the shared history home (default `~/.dsh`) and the private `~/.dsh/vscode/harness-home` before upgrading, and do not downgrade an active profile. Third-party plugins using the removed `ctx.agent` or runtime `Inbox` APIs need their own compatibility updates. The extension keeps its native VS Code interface rather than embedding the official Web UI.

Startup uses the official runtime package resolver. Only a recognized legacy module conflict triggers one bounded backup-and-repair attempt; ordinary profile packages are no longer moved on every startup or installation.

## 0.6.2 release update

This update aligns the workbench with DSH `0.2.2-rc.1`:

- **One saved-history store:** new sessions use the selected shared `sessions/` directory, normally `~/.dsh/sessions`. Readable legacy histories migrate with their originals retained; an incompatible record no longer switches the extension to a private store. The history panel shows the actual path and migration details.
- **Project-based session management:** conversations belong to their original folder across clients. Browse other projects, preview without activating an Agent, and choose **Continue here** to request native execution ownership. New conversations work directly in the selected folder; existing worktrees retain manual actions.
- **Native changes and titles:** per-turn snapshots and diffs use `@deepseek-ai/dsh-workspace-changes`. Titles are read from native logs and retained across partial or stale metadata updates.
- **MCP management:** add, edit, enable, disable and remove stdio or Streamable HTTP servers through **More → MCP servers** or the command palette. Changes are validated and wait for idle model turns before reloading the Host.
- **Conversation and compatibility fixes:** attached editor context no longer duplicates prompts after answers; streaming and queued prompts keep their order. The bundled chat importer is updated to `0.26.4`, with known-version upgrades preserving its enabled state.
- **Platform packages:** CI tests and builds `darwin-arm64`, `win32-x64`, `linux-x64` and `linux-arm64`. Unused Office preview and experimental voice resources remain excluded; sizes are shown on the release assets.

Download the VSIX from the [v0.6.2 release](https://github.com/skymecode/deepseek-harness-for-vscode/releases/tag/v0.6.2) and reload VS Code after installation. GitHub Actions builds and publishes the four platform packages when the release tag is pushed. Marketplace publication is separate. Release notes are available in Chinese in the [changelog](CHANGELOG.md#062).

## Runtime update policy

The bundled DeepSeek Harness runtime is upgraded selectively, not automatically with every upstream release. We review the actual changes—relevant features, bug and security fixes, and breaking changes—and adopt an update after compatibility adaptation and regression testing, with particular attention to Windows, macOS, Linux, existing conversation history, and plugins. The earlier 0.1.7 native capability audit is tracked in [the upgrade audit](docs/DSH_0_1_7_NATIVE_GAP_ANALYSIS.zh-CN.md).

Stability and the upgrade experience for existing users take priority over always bundling the newest version. Releases that still need validation or introduce compatibility risks may be deferred; an extension update may also keep the current pinned runtime. The bundled version and any upgrade caveats are documented in this README and the [changelog](CHANGELOG.md).

## Features

- **Native VS Code workbench** — all interaction happens in the sidebar; the local Harness Gateway exposes only the loopback API transport, while the official WebUI is neither served nor embedded.
- **First-run guidance** — an unconfigured key shows a three-step setup hint with a direct link to connection settings; history previews show the original project and execution directory before continuation.
- **Shared local history** — the bundled runtime and an independently installed official DSH can read the same saved conversations. Installing the official CLI is optional; credentials and plugin profiles stay separate.
- **Detachable workbench** — open the same synchronized conversation UI in an editor-area panel and move it to another VS Code window when more space is needed.
- **Complete session workflow** — persistent history, create, switch, rename, fork, resume, archive/restore, export, and import sessions (official DSH ZIP, ChatGPT export ZIP, and other agent transcripts via `dsh-chat-import`); a started conversation keeps its preset; model and reasoning choices remain editable, and another preset requires an explicitly created conversation.
- **Streaming Markdown** — headings, lists, tables, code blocks, copy controls, safe external links, and clickable workspace file references.
- **Stable incremental rendering** — streamed updates preserve disclosure state and the reader's scroll position.
- **Progressive reasoning timeline** — nodes appear as thinking steps arrive, connecting only existing steps within the same turn. Completed turns retain their timeline inside the expandable process section.
- **Session titles** — automatic titles and manual renames are owned by the official session service.
- **Session management** — a canonical original folder defines a project across desktop, Web and extension histories in the same store. Changing execution cwd never moves the conversation to another project; different folders in a monorepo remain distinct. History opens in preview; **Continue here** explicitly resumes the original native session. Writer conflicts remain readable. Actual Git registration distinguishes project directories and worktrees; missing directories block execution and other projects offer a new-window action. Drafts stay with their session; continuing no longer silently forks or moves an old session. Archive/pin state remains Host-scoped; shared logs do not synchronize separate Hosts’ management settings.
- **Per-turn file changes** — snapshots, net line counts and historical diffs come exclusively from `@deepseek-ai/dsh-workspace-changes`; the extension only adapts their presentation to VS Code. Native paths, binary/oversized files and capped lists are labeled. Git snapshots cover shell edits; outside Git, only file-tool captures are recorded. Snapshots last for the Session lifetime in its current Harness Host; old cards disappear after a Host restart. New conversations use the selected project directory through native Workspace registration and Session creation. The extension creates no worktrees or branches and performs no automatic merges. Legacy extension checkouts retain their files and manual actions.
- **Compact completed turns** — reasoning, tool calls and interim updates fold into a duration row; the final answer and file changes remain visible.
- **Reader-friendly streaming** — while a turn streams you can scroll up through earlier messages freely; auto-follow yields to your scroll and only resumes at the very bottom. The finished conclusion is set off by a divider between the thinking and the final answer (or above the message when there is no thinking).
- **DeepSeek Harness-native reasoning** — reasoning blocks start collapsed with a live summary and can be expanded manually. Streaming retains the chosen disclosure state; completed reasoning shows at least one second.
- **Editor context** — selected code appears as a removable context card; type `@` to fuzzy-search and attach workspace files without leaving the composer.
- **Slash commands** — use official Harness commands plus `/model`, `/reasoning`, and `/preset` extension commands.
- **Harness-native capabilities** — reasoning, tool calls, approvals, structured questions, Todos, Skills, Goals, Plan mode, and background jobs.
- **Model and agent controls** — official catalogs provide model capabilities and reasoning choices; new sessions default to `deepseek-flash`. The PTC preset uses `ptc`; legacy `code` sessions keep a compatible preset.
- **Token usage** — see current input and output token counts in the composer.
- **Native DSH plugin center** — search a curated catalog, filter by category and native compatibility, inspect installed plugins, or install an npm/GitHub/local/tarball package.
- **Native change records** — DSH records snapshots and diffs without an extra conversation or checkout. The legacy `worktreeAutoMerge` setting is retired. Snapshots record changes; they do not isolate concurrent edits to the same files.
- **External MCP servers** — use **More → MCP servers**, the command palette, or `deepseekHarness.mcpServers` in VS Code Settings. Validated stdio or Streamable HTTP entries are passed to DSH's profile; changes wait for idle model turns and reload the Host. Discovered tools use names such as `mcp__github__create_issue`. `toolCallTimeoutMs`, `maxInstructionBytes`, `failOnStartupError`, and bounded `reconnect` options use the native DSH MCP client.
- **Automatic localization** — follows the VS Code display language with English and Simplified Chinese support.
- **Zero-deployment runtime** — official `dsh`, pnpm, and standalone Node 24.22.2 are bundled in each platform VSIX and managed by the extension.

Open the workbench with `Ctrl+Alt+H` on Windows/Linux or `Cmd+Alt+H` on macOS.

## Interface preview

Screenshots use the **0.5.9** workbench UI with a demonstration conversation and no private account data. This README shows the English interface; the [Chinese README](README.zh-CN.md#界面预览) shows the localized interface. Select an image to view it at full resolution.

<table>
  <tr>
    <td align="center" width="58%">
      <a href="docs/images/workbench-preview.png">
        <img src="docs/images/workbench-preview.png" alt="DeepSeek Harness 0.5.9: single-row header, collapsed turn process, final answer and edited files" width="460">
      </a>
    </td>
    <td align="center" width="42%">
      <a href="docs/images/model-and-effort.png">
        <img src="docs/images/model-and-effort.png" alt="DeepSeek Harness 0.5.9: Flash and Pro model selection, four DSH modes and reasoning effort slider" width="300">
      </a>
    </td>
  </tr>
  <tr>
    <td align="center"><sub>0.5.9 workbench — compact turn process, final answer and per-turn file changes</sub></td>
    <td align="center"><sub>Flash / Pro, four DSH modes and the effort slider</sub></td>
  </tr>
</table>

## Installation

1. Download the VSIX matching your platform from the [0.6.2 release](https://github.com/skymecode/deepseek-harness-for-vscode/releases/tag/v0.6.2).
2. Open the VS Code Extensions view (`Cmd/Ctrl+Shift+X`).
3. Select `...` → **Install from VSIX...** and choose the downloaded file.
4. Reload the VS Code window when prompted.

For example, an Apple Silicon Mac requires the `darwin-arm64` package.

## Quick start

1. Open the project you want to work on.
2. Select the **DeepSeek Harness** icon in the Activity Bar.
3. Open **Connection settings** and configure DeepSeek Official or add a relay source. You can also run `DeepSeek Harness: Set API Key` for the official source.
4. New conversations use the project folder directly. Multi-root windows prompt for the project; existing conversations open in preview before you choose Continue here.
5. Describe your task in the composer and send it.

No Harness install or start command is required.

## Shared history with official DSH

The extension still ships and starts its own tested Harness/Node runtime. A separately installed CLI is **not required** and is not substituted automatically. On the same machine and OS user account, both backends use the official history location by default:

| Platform | Shared history home |
| --- | --- |
| Windows | `%USERPROFILE%\.dsh` |
| macOS | `~/.dsh` |
| Linux | `~/.dsh` |

An inherited `DSH_HOME` takes precedence. If official DSH uses another home, set the application-level `deepseekHarness.historyHome` to that same absolute path. Only `sessions/` and `attachments/` are shared. The extension's credentials, plugin profile and caches remain under `~/.dsh/vscode/harness-home`; archive and pin state use the native DSH workspace registry in the extension's private home and remain separate from independently launched DSH. Tags and the VS Code history filter stay local to this workbench. VS Code uninstall does not remove the shared history.

Migration copies readable legacy histories while retaining originals; conflicting same-ID histories are preserved through a native fork. Unreadable, locked, or attachment-conflicting records are reported without changing the canonical data source. An unavailable canonical target fails visibly and never opens a private session store.

Open the VS Code history panel to refresh its list; refresh the official Web UI page to discover externally created history. VS Code filters by the current project, while official DSH may show worktree sessions under their own workspace or as ungrouped sessions. This shares **saved history**, not another process's transient token stream. Kernel locks prevent simultaneous writes to one session: close the owning backend before continuing on the other side, or create a fork. Model credentials and installed plugins are configured independently.

**“Owned by another runtime”** means a live DSH backend holds that conversation's native writer lock. History remains readable, but continuation must wait for the owner to release the session. A completed reply or a closed browser tab does not necessarily release the backend; release it there, or stop that backend when finished, then choose **Retry continuation** in VS Code. Automatic execution handoff between independent Hosts is not implemented.

Both runtimes must support the same log format (this build uses **V4, DSH 0.2.2-rc.1**). An older official CLI cannot read new V4 logs and must be updated to use this sharing feature; original V2/V3 files are retained, but are not a downgrade-sync mechanism. This is not cloud, cross-device, or Windows/WSL cross-kernel synchronization; do not run live shared stores through a network/sync drive. Back up both the shared home and the old private home before a major runtime upgrade.

## DSH plugins

Open the **⊞ Plugins** button in the workbench header to browse repositories read directly from the [`dsh-plugin` GitHub topic](https://github.com/topics/dsh-plugin). Results are merged with [Awesome DSH Plugin](https://awesome-dsh-plugin.com/) metadata for curated categories, localized descriptions, and npm install specs. The **Installed** tab also accepts one package spec directly, including an npm package, `github:owner/repository`, a local path without shell metacharacters, or a tarball URL.

<p align="center">
  <a href="docs/images/plugin-marketplace.png">
    <img src="docs/images/plugin-marketplace.png" alt="DeepSeek Harness 0.5.9 plugin center with built-in catalog entries and compatibility labels" width="500">
  </a>
  <br>
  <sub>0.5.9 plugin center — built-in catalog example, not the complete live GitHub marketplace</sub>
</p>

Online results merge GitHub Topic and curated metadata. A network failure names the failed source and retains successful results for the current extension session; use Refresh to retry. A first load without network access or cache shows only three built-in recipes.

Ordinary bundles use the running official Plugin Manager for installation, cancellation, enable/disable and removal. The UI reports read-only, overridden and restart-required results. Bundled Node/pnpm are used without a system package manager. The optional Routing Suite keeps its preset-installation recipe and stopped-runtime CLI path. Super Injector is no longer installed automatically; existing installations are retained.

Host tools, policies, and runtime services contributed by a plugin work in this extension. A plugin may also contain client UI designed specifically for the upstream DSH browser application; those UI contributions cannot be rendered generically by this native VS Code workbench and are marked **Official Web UI**.

Marketplace cards classify known entries as **Agent compatible**, **Agent works · Web UI unavailable**, or **Official Web UI only**. UI-only themes and layout extensions cannot affect the native workbench, so their install button is disabled. GitHub-only entries without curated metadata are marked **Compatibility unknown** until their installed manifest can be inspected.

## MCP management

Run **DeepSeek Harness: Manage MCP Servers**, or choose **More → MCP servers** in the workbench. Add local stdio programs or Streamable HTTP endpoints, edit JSON, enable/disable or remove servers, and inspect native registered tool names. Changes wait for idle model turns and reload the Host. This is not per-server hot reload; background processes are not guaranteed to survive it. Invalid settings are shown instead of silently dropping entries.

The tool list is a global registry view, not a live connection test; use a chat request to verify a real tool result. OAuth login and prompt-template management are not implemented. For the capability comparison and roadmap, see [the DSH/MCP/Agent research report (Chinese)](docs/DSH_MCP_AGENT_GAP_ANALYSIS.zh-CN.md).

## Configuration

The 0.6.2 extension bundles DSH `0.2.2-rc.1`. In VS Code Settings, `deepseekHarness.webSearchProvider` selects `messages` (default: Messages search with local HTTP retrieval) or `search-api` (native DeepSeek Search and Fetch APIs). Reload the workbench after changing it. The direct APIs use the official DeepSeek credential, independently of the chat provider, and require access on that account. Disabling `deepseekHarness.webSearch` disables both DeepSeek web providers while retaining local HTTP retrieval. As in official DSH, Search API requests may include up to 128 characters of the initiating question.


DSH 0.2.1 uses only Messages for DeepSeek Official, at `https://api.deepseek.com/anthropic`. Old hand-written `llm-deepseek.protocol` options must be removed; Chat Completions endpoints belong under a custom provider. Custom-provider protocols remain unchanged.

Example MCP configuration:

```json
[
  {
    "serverName": "local",
    "transport": "stdio",
    "command": "node",
    "args": ["/absolute/path/server.mjs"],
    "env": { "MCP_TOKEN": "$env:MCP_TOKEN" }
  }
]
```

MCP servers are disabled by default. Review the server source and permissions before enabling one.

OTel, request-attached session logs (`dsh_session_log`) and plugin inventories (`dsh_plugin_packages`) are disabled by default. Normal model requests still contain submitted messages, context and attachments.

Workspace files use official persistent upload receipts for any file type (20 MiB per file, 40 MiB and eight files per submission). Editor selections stay native. Delivered files open in VS Code or an installed format viewer; binary attachments in subagent conversations are not yet supported.

This package excludes the official Web Office/PDF preview and experimental voice payloads, and disables the Office-to-PDF/document-preview profile rows. File uploads, editor opening and DSH file APIs remain available. Restored session terminals and dedicated SSH/Browser Use/Computer Use interfaces still require native workbench integration; installing a Web UI plugin alone does not add them. Experimental permissions are not enabled by upgrading.

| Setting                               | Default             | Description                                                            |
| ------------------------------------- | ------------------- | ---------------------------------------------------------------------- |
| `deepseekHarness.model`               | `deepseek-flash` | Default model for new sessions                                         |
| `deepseekHarness.reasoningEffort`     | `high`              | `off` / `low` / `high` / `max`                                                 |
| `deepseekHarness.agentPreset`         | `standard`          | Default Agent Preset for new sessions                                  |
| `deepseekHarness.provider`            | `deepseek-official` | Default source selected from the extension's Connection settings panel |
| `deepseekHarness.permissionMode`      | `workspace-write`   | `read-only` / `workspace-write` / `danger-full-access`                 |
| `deepseekHarness.autoAttachSelection` | `true`              | Automatically attach the active editor selection when sending          |

Provider endpoints and write-only credential references are managed through the bundled Harness settings and credentials services. API keys are stored in the extension's private Harness home, are never returned to the webview, and are not written to project-level `.vscode/settings.json`. Legacy `deepseekHarness.apiKey`, `baseUrl`, and `providers` values are imported once and then removed.

Use the Connection settings panel to add, edit, test, or remove OpenAI-compatible or Anthropic Messages sources. Custom sources are registered live through the upstream `llm-pi-ai` adapter; test the endpoint to import its advertised model ids, or enter them manually. API keys are optional for local endpoints such as llama-server, llama-swap, and Ollama-compatible servers. Configured providers and their models appear in the model panel grouped by provider.

Model modalities, context windows and reasoning options come from the official LLM resolver. For endpoints that omit context size, enter an explicit override such as `model-id:32k` in Model IDs. Existing model declarations are preserved when editing a provider; an empty new catalog does not invent DeepSeek models. The extension no longer maintains a parallel capacity or vision table.

Automatically attached selections are limited to 16 KB and are truncated when necessary. If the same file selection is already embedded manually, the host will not attach it again.

## Commands

| Command                                              | Description                               |
| ---------------------------------------------------- | ----------------------------------------- |
| `DeepSeek Harness: Open Workbench`                   | Open the sidebar workbench                |
| `DeepSeek Harness: Open Workbench in New Window`     | Open the detachable editor-area workbench |
| `DeepSeek Harness: Reload Workbench`                 | Restart the runtime and reconnect         |
| `DeepSeek Harness: Set API Key`                      | Save the API Key                          |
| `DeepSeek Harness: Clear API Key`                    | Clear the API Key                         |
| `DeepSeek Harness: Show Logs`                        | Open diagnostic logs                      |
| `DeepSeek Harness: Import Sessions`                  | Import a DSH ZIP, ChatGPT ZIP, or other agent transcripts |

## System notifications

Completed foreground and background work now uses **native Windows/macOS notifications**, not VS Code's in-window completion popup. Duplicate idle events, child-agent completions and Stop actions from this extension do not generate extra alerts. Queued prompts notify when the agent becomes idle after finishing the queue; opening old history does not replay notifications. Approval/question prompts remain unchanged.

User settings (effective immediately, without restarting Harness):

```json
"deepseekHarness.systemNotifications.enabled": true,
"deepseekHarness.systemNotifications.sound": false,
"deepseekHarness.systemNotifications.includeConversationTitle": false
```

Run **DeepSeek Harness: Test System Notification** from the Command Palette to test without an API request. Errors are recorded under **DeepSeek Harness: Show Logs**; there is no in-window fallback. Notifications never contain reply text or detailed errors; enabling titles may expose them on the lock screen.

- **macOS:** uses the system AppleScript notification service. Allow notifications/banners for the sender shown in System Settings → Notifications (it may appear as Script Editor/osascript, not a separate Harness app).
- **Windows:** uses Windows PowerShell and Windows Toast with the running VS Code product's AppUserModelID (including Insiders). Use an installed VS Code with its registered Start menu shortcut; portable/custom builds without a registered identity may not show notifications. No registry changes, administrator access or extra notification package is required.
- OS permissions, Focus/Do Not Disturb and enterprise policies can suppress banners even after successful submission. This feature currently requires a **local desktop extension host**; Linux, Remote SSH, WSL, containers and browser-hosted VS Code are not supported. Disconnected runs are not replayed after reconnection.

## Localization

English is the default language, and a Simplified Chinese language pack is included. Manifest contributions, settings, extension-host prompts, errors, and the full chat workbench follow the VS Code display language. After changing the display language, run **Developer: Reload Window**.

## Security and privacy

- The Harness Gateway listens only on a random `127.0.0.1` port.
- The Webview uses a strict CSP and loads no remote scripts or iframes.
- Plugin catalog JSON is fetched by the Extension Host, validated into a narrow UI data model, and rendered with `textContent`.
- Raw Markdown HTML is disabled, and rendered markup is sanitized through a DOMPurify allowlist.
- Remote Markdown images are disabled; http(s) links are validated again by the extension host.
- File and command access is controlled by `permissionMode` and Harness approval policies.
- The API Key is never sent to the Webview or written to extension logs.
- Third-party DSH plugins are trusted Extension Host dependencies: they run outside the Agent sandbox. Review their source before installation.

## Platform support

There is one extension ID and one Marketplace product. Platform-specific VSIX files are required because the bundled Node, PTY, and sandbox packages contain native binaries:

- macOS: `darwin-arm64`, `darwin-x64`
- Linux: `linux-arm64`, `linux-x64`
- Windows: `win32-arm64`, `win32-x64`

The current hosted GitHub Actions matrix builds `darwin-arm64`, `linux-arm64`, `linux-x64`, and `win32-x64`. Other architectures require a self-hosted runner or local packaging.

## Development and packaging

```sh
npm install
npm run check-types
npm run lint
npm test
npm run compile
npm run package
```

`npm run package` creates a VSIX for the current operating system and CPU architecture. `npm ci` executes lifecycle scripts required by native dependencies, so build only trusted commits and lockfiles.

All project commit messages use English. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the architecture and security boundaries.

## License

Extension code is licensed under the [MIT License](LICENSE). Licensing details for DeepSeek Harness, Node.js, and other dependencies are available in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and the license files shipped with each dependency.
