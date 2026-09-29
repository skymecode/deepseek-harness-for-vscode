/** Built-in plugin definitions shared by the catalog and the default installer. */
export interface DefaultBuiltinPlugin {
  readonly id: string
  readonly name: string
  readonly owner: string
  readonly description: { readonly en: string; readonly zh: string }
  readonly category: string
  readonly categoryLabel: { readonly en: string; readonly zh: string }
  readonly repositoryUrl: string
  readonly installSpec: string
  /** VSIX-relative path to a bundled plugin tarball; first-run seeding installs from it instead of downloading. */
  readonly vendoredTarball?: string
  readonly installedName: string
  readonly npmPackage?: string
  readonly updatedAt: string
  readonly compatibility: 'agent' | 'partial' | 'official-web-ui' | 'unknown'
}

export const DEFAULT_BUILTIN_PLUGINS: readonly DefaultBuiltinPlugin[] = [
  {
    id: 'https://github.com/yjh051108/dsh-super-injector',
    name: 'DSH Super Injector',
    owner: 'yjh051108',
    description: {
      en: 'Runtime super-module injector for DSH: hot-inject local plugin packages, hot-reload, dev staging, one-click uninstall, route self-healing, and plugin management UI.',
      zh: 'DSH 超级模组注入器：运行时注入本地插件包、热重载、开发侧挂区、一键卸载、路由自愈与插件管理 UI。',
    },
    category: 'routing',
    categoryLabel: { en: 'Routing & workflow', zh: '路由与工作流' },
    repositoryUrl: 'https://github.com/yjh051108/dsh-super-injector',
    installSpec: 'https://github.com/yjh051108/dsh-super-injector/releases/download/v0.3.3/dsh-external-dsh-super-injector-0.3.3.tgz',
    vendoredTarball: 'vendor/plugins/dsh-external-dsh-super-injector-0.3.3.tgz',
    installedName: '@dsh-external/dsh-super-injector',
    updatedAt: '2026-08-13T00:00:00Z',
    compatibility: 'agent',
  },
  {
    id: 'https://github.com/Nwflower/dsh-chat-import',
    name: 'DSH Chat Import',
    owner: 'Nwflower',
    description: {
      en: 'Import Claude Code, Codex, Cursor, ChatGPT, and other agent transcripts as resumable DeepSeek Harness sessions. The native workbench also accepts official DSH session ZIP exports.',
      zh: '将 Claude Code、Codex、Cursor、ChatGPT 等外部 Agent 会话导入为可续聊的 DeepSeek Harness 会话。原生工作台还支持导入官方 DSH 会话 ZIP。',
    },
    category: 'import',
    categoryLabel: { en: 'Import', zh: '导入' },
    repositoryUrl: 'https://github.com/Nwflower/dsh-chat-import',
    installSpec: 'dsh-chat-import',
    vendoredTarball: 'vendor/plugins/dsh-chat-import-0.22.2.tgz',
    installedName: 'dsh-chat-import',
    npmPackage: 'dsh-chat-import',
    updatedAt: '2026-09-28T13:47:46Z',
    compatibility: 'partial',
  },
]
