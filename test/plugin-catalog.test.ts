import { describe, expect, it, vi } from 'vitest'
import { BuiltinDshPluginSource } from '../src/plugins/builtin-plugin-source.js'
import { CuratedDshPluginSource, projectPluginRegistry } from '../src/plugins/curated-plugin-source.js'
import { GitHubDshPluginTopicSource, projectGitHubTopicResponse } from '../src/plugins/github-topic-source.js'
import { DshPluginCatalogService, mergePluginCatalog } from '../src/plugins/plugin-catalog.js'
import type { DshPluginCatalogContribution } from '../src/plugins/types.js'

const registry = {
  updated: '2026-08-14',
  categories: { tools: { en: 'Tools', zh: '工具' } },
  plugins: [
    {
      name: 'Shared Plugin', owner: 'alice', url: 'https://github.com/alice/shared-plugin',
      page: 'https://awesome-dsh-plugin.com/plugins/alice/shared-plugin', category: 'tools',
      description: { en: 'Curated English', zh: '精选中文介绍' }, npm: 'dsh-shared', stars: 2,
      install: 'dsh plugin --profile web add dsh-shared', added: '2026-08-01',
    },
    {
      name: 'Curated Only', owner: 'bob', url: 'https://github.com/bob/curated-only', category: 'tools',
      description: { en: 'Curated only' }, stars: 40,
      install: 'dsh plugin --profile web add github:bob/curated-only#v1',
    },
    {
      name: 'Untrusted URL', owner: 'mallory', url: 'https://example.com/plugin', category: 'tools',
      description: { en: 'Must be filtered' }, stars: 999,
      install: 'dsh plugin --profile web add safe-name',
    },
    {
      name: 'Unsafe command', owner: 'mallory', url: 'https://github.com/mallory/unsafe', category: 'tools',
      description: { en: 'Must be filtered' }, stars: 999,
      install: 'dsh plugin --profile web add safe-name && whoami',
    },
  ],
}

const githubSearch = {
  total_count: 3016,
  items: [
    {
      full_name: 'alice/shared-plugin', html_url: 'https://github.com/alice/shared-plugin',
      description: 'GitHub description', stargazers_count: 20, updated_at: '2026-08-15T12:00:00Z',
      archived: false, fork: false,
    },
    {
      full_name: 'carol/topic-only', html_url: 'https://github.com/carol/topic-only',
      description: 'Direct from topic', stargazers_count: 4, updated_at: '2026-08-15T13:00:00Z',
      archived: false, fork: false,
    },
    {
      full_name: 'old/archived', html_url: 'https://github.com/old/archived',
      description: 'Hidden', stargazers_count: 100, updated_at: '2026-08-15T14:00:00Z',
      archived: true, fork: false,
    },
  ],
}

describe('DSH plugin catalog sources', () => {
  it('validates and localizes the curated registry independently', () => {
    const contribution = projectPluginRegistry(registry, 'zh-cn')

    expect(contribution.source).toBe('curated')
    expect(contribution.categories).toEqual([{ id: 'tools', label: '工具' }])
    expect(contribution.plugins.map((plugin) => plugin.name)).toEqual(['Shared Plugin', 'Curated Only'])
    expect(contribution.plugins[0]).toMatchObject({
      description: '精选中文介绍', installSpec: 'dsh-shared', npmPackage: 'dsh-shared',
      catalogSource: 'curated', compatibility: 'agent',
    })
  })

  it('distinguishes Agent functionality from upstream Web UI-only entries', () => {
    const contribution = projectPluginRegistry({
      categories: {},
      plugins: [
        {
          name: 'Theme', owner: 'alice', url: 'https://github.com/alice/theme', category: 'theme',
          description: { en: 'A Web UI theme' }, stars: 1,
          install: 'dsh plugin --profile web add github:alice/theme',
        },
        {
          name: 'Memory', owner: 'bob', url: 'https://github.com/bob/memory', category: 'memory',
          description: { en: 'Memory tools with a settings page browser' }, stars: 1,
          install: 'dsh plugin --profile web add github:bob/memory',
        },
      ],
    }, 'en')

    expect(contribution.plugins.map((plugin) => plugin.compatibility)).toEqual(['official-web-ui', 'partial'])
  })

  it('projects the actual GitHub Topic response into installable repository specs', () => {
    const contribution = projectGitHubTopicResponse(githubSearch, 'en')

    expect(contribution.totalAvailable).toBe(3016)
    expect(contribution.plugins).toHaveLength(2)
    expect(contribution.plugins[1]).toMatchObject({
      name: 'topic-only', owner: 'carol', installSpec: 'github:carol/topic-only',
      category: 'github-topic', catalogSource: 'github-topic',
    })
  })

  it('exposes built-in plugins and the non-package routing suite through a trusted recipe', async () => {
    const contribution = await new BuiltinDshPluginSource().load('zh-cn')

    expect(contribution.source).toBe('builtin')
    expect(contribution.categories).toEqual([
      { id: 'routing', label: '路由与工作流' },
      { id: 'import', label: '导入' },
    ])
    expect(contribution.plugins[0]).toMatchObject({
      name: 'DSH Routing Suite',
      installSpec: 'builtin:dsh-routing-suite@0.3.3',
      installedName: 'dsh-routing-suite',
      installKind: 'managed-suite',
      catalogSource: 'builtin',
      compatibility: 'agent',
    })
    expect(contribution.plugins.map((plugin) => plugin.name)).toEqual([
      'DSH Routing Suite',
      'DSH Super Injector',
      'DSH Chat Import',
    ])
    expect(contribution.plugins[1]).toMatchObject({
      name: 'DSH Super Injector',
      installedName: '@dsh-external/dsh-super-injector',
      installKind: 'package',
      catalogSource: 'builtin',
      compatibility: 'agent',
    })
    expect(contribution.plugins[2]).toMatchObject({
      name: 'DSH Chat Import',
      installSpec: 'dsh-chat-import',
      installedName: 'dsh-chat-import',
      catalogSource: 'builtin',
      compatibility: 'partial',
    })
  })

  it('prefers the managed recipe over an invalid same-repository GitHub package spec', async () => {
    const github = projectGitHubTopicResponse({
      total_count: 1,
      items: [{
        full_name: 'yjh051108/dsh-routing-suite',
        html_url: 'https://github.com/yjh051108/dsh-routing-suite',
        description: 'Suite root', stargazers_count: 2300, updated_at: '2026-08-16T00:00:00Z',
        archived: false, fork: false,
      }],
    }, 'en')
    const builtin = await new BuiltinDshPluginSource().load('en')

    const plugin = mergePluginCatalog([github, builtin]).plugins.find((item) => item.name === 'DSH Routing Suite')
    expect(plugin).toMatchObject({
      installSpec: 'builtin:dsh-routing-suite@0.3.3',
      installKind: 'managed-suite',
      stars: 2300,
      catalogSource: 'builtin',
    })
  })

  it('merges duplicate repositories while preserving curated install metadata', () => {
    const catalog = mergePluginCatalog([
      projectGitHubTopicResponse(githubSearch, 'zh-cn'),
      projectPluginRegistry(registry, 'zh-cn'),
    ])

    expect(catalog.topicRepositoryCount).toBe(3016)
    expect(catalog.plugins.map((plugin) => plugin.name)).toEqual(['topic-only', 'Shared Plugin', 'Curated Only'])
    expect(catalog.plugins[1]).toMatchObject({
      installSpec: 'dsh-shared', npmPackage: 'dsh-shared', stars: 20,
      description: '精选中文介绍', catalogSource: 'both', compatibility: 'agent',
    })
  })

  it('keeps the marketplace usable when either remote source is unavailable', async () => {
    const github = projectGitHubTopicResponse(githubSearch, 'en')
    const failingSource = { load: vi.fn(async (): Promise<DshPluginCatalogContribution> => { throw new Error('offline') }) }
    const workingSource = { load: vi.fn(async () => github) }
    const service = new DshPluginCatalogService(workingSource, failingSource)

    const catalog = await service.load('en')
    expect(catalog.plugins).toHaveLength(5)
    expect(catalog.plugins.some((plugin) => plugin.name === 'DSH Routing Suite')).toBe(true)
    expect(catalog.plugins.some((plugin) => plugin.name === 'DSH Super Injector')).toBe(true)
    expect(catalog.plugins.some((plugin) => plugin.name === 'DSH Chat Import')).toBe(true)
    expect(catalog.topicRepositoryCount).toBe(3016)
  })

  it('caches both remote adapters and supports explicit refresh', async () => {
    const curatedFetch = vi.fn(async () => jsonResponse(registry))
    const githubFetch = vi.fn(async () => jsonResponse(githubSearch))
    const curated = new CuratedDshPluginSource(curatedFetch)
    const github = new GitHubDshPluginTopicSource(githubFetch)

    await curated.load('en'); await curated.load('zh-cn'); await curated.load('en', true)
    await github.load('en'); await github.load('zh-cn'); await github.load('en', true)

    expect(curatedFetch).toHaveBeenCalledTimes(2)
    expect(githubFetch).toHaveBeenCalledTimes(2)
  })

  it('reports both remote failures when only built-in recipes can be shown', async () => {
    const failing = { load: vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } })) }
    const catalog = await new DshPluginCatalogService(failing, failing).load('zh-cn')
    expect(catalog.plugins).toHaveLength(3)
    expect(catalog.topicRepositoryCount).toBeUndefined()
    expect(catalog.sourceIssues).toEqual([
      { source: 'github-topic', message: 'fetch failed (ETIMEDOUT)', usingCache: false },
      { source: 'curated', message: 'fetch failed (ETIMEDOUT)', usingCache: false },
    ])
  })

  it('retains each successful source after a failed refresh and clears diagnostics on recovery', async () => {
    const topic = projectGitHubTopicResponse(githubSearch, 'en')
    const curated = projectPluginRegistry(registry, 'en')
    const githubSource = { load: vi.fn().mockResolvedValue(topic) }
    const curatedSource = { load: vi.fn().mockResolvedValue(curated) }
    const service = new DshPluginCatalogService(githubSource, curatedSource)
    const first = await service.load('en')
    githubSource.load.mockRejectedValue(new Error('HTTP 403'))
    curatedSource.load.mockRejectedValue(new Error('timeout'))
    const cached = await service.load('en', true)
    expect(cached.plugins).toEqual(first.plugins)
    expect(cached.topicRepositoryCount).toBe(3016)
    expect(cached.sourceIssues).toEqual([
      { source: 'github-topic', message: 'HTTP 403', usingCache: true },
      { source: 'curated', message: 'timeout', usingCache: true },
    ])
    githubSource.load.mockResolvedValue({ ...topic, totalAvailable: 3017 })
    curatedSource.load.mockResolvedValue(curated)
    const recovered = await service.load('en', true)
    expect(recovered.topicRepositoryCount).toBe(3017)
    expect(recovered.sourceIssues).toBeUndefined()
  })

  it('fails only when every marketplace source fails', async () => {
    const failing = { load: vi.fn(async (): Promise<DshPluginCatalogContribution> => { throw new Error('offline') }) }
    await expect(new DshPluginCatalogService(failing, failing, failing).load('en')).rejects.toThrow('Could not load')
  })
})

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}
