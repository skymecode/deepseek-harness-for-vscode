import { BuiltinDshPluginSource } from './builtin-plugin-source.js'
import { CuratedDshPluginSource, projectPluginRegistry } from './curated-plugin-source.js'
import { GitHubDshPluginTopicSource } from './github-topic-source.js'
import type { DshPluginCatalogContribution, DshPluginCatalogIssue, DshPluginCatalogItem, DshPluginCatalogSnapshot } from './types.js'

const REGISTRY_PAGE = 'https://awesome-dsh-plugin.com/'
const TOPIC_URL = 'https://github.com/topics/dsh-plugin'

export interface DshPluginSource {
  load(language: string, force?: boolean): Promise<DshPluginCatalogContribution>
}

/** Combines remote catalogs with trusted recipes for non-package suites. */
export class DshPluginCatalogService {
  private readonly lastSuccessful = new Map<string, DshPluginCatalogContribution>()

  constructor(
    private readonly githubTopic: DshPluginSource = new GitHubDshPluginTopicSource(),
    private readonly curated: DshPluginSource = new CuratedDshPluginSource(),
    private readonly builtin: DshPluginSource = new BuiltinDshPluginSource(),
  ) {}

  async load(language: string, force = false): Promise<DshPluginCatalogSnapshot> {
    const results = await Promise.allSettled([
      this.githubTopic.load(language, force),
      this.curated.load(language, force),
      this.builtin.load(language, force),
    ])
    const sources = ['github-topic', 'curated', 'builtin'] as const
    const sourceIssues: DshPluginCatalogIssue[] = []
    const contributions: DshPluginCatalogContribution[] = []
    results.forEach((result, index) => {
      const source = sources[index]!
      const key = `${language}/${source}`
      if (result.status === 'fulfilled') {
        this.lastSuccessful.set(key, result.value)
        contributions.push(result.value)
      } else {
        const cached = this.lastSuccessful.get(key)
        if (cached !== undefined) contributions.push(cached)
        sourceIssues.push({ source, message: catalogFailureMessage(result.reason), usingCache: cached !== undefined })
      }
    })
    if (contributions.length === 0) {
      const details = results.flatMap((result) => result.status === 'rejected' ? [String(result.reason)] : []).join('\n')
      throw new Error(`Could not load the DSH plugin marketplace.\n${details}`)
    }
    return { ...mergePluginCatalog(contributions), ...(sourceIssues.length === 0 ? {} : { sourceIssues }) }
  }
}

/** Deterministically merges independently validated remote and built-in sources. */
export function mergePluginCatalog(contributions: readonly DshPluginCatalogContribution[]): DshPluginCatalogSnapshot {
  const topic = contributions.find((item) => item.source === 'github-topic')
  const curated = contributions.find((item) => item.source === 'curated')
  const builtin = contributions.find((item) => item.source === 'builtin')
  const plugins = new Map<string, DshPluginCatalogItem>()
  for (const plugin of topic?.plugins ?? []) plugins.set(plugin.id, plugin)
  for (const plugin of curated?.plugins ?? []) {
    const existing = plugins.get(plugin.id)
    plugins.set(plugin.id, existing === undefined ? plugin : {
      ...existing,
      ...plugin,
      stars: Math.max(existing.stars, plugin.stars),
      ...(existing.updatedAt === undefined ? {} : { updatedAt: existing.updatedAt }),
      catalogSource: 'both',
    })
  }
  // Built-in recipes must win over a same-repository GitHub card because the
  // repository root is not necessarily an installable npm package.
  for (const plugin of builtin?.plugins ?? []) {
    const existing = plugins.get(plugin.id)
    plugins.set(plugin.id, existing === undefined ? plugin : {
      ...existing,
      ...plugin,
      stars: Math.max(existing.stars, plugin.stars),
      ...(existing.updatedAt === undefined ? {} : { updatedAt: existing.updatedAt }),
      catalogSource: 'builtin',
    })
  }
  const merged = [...plugins.values()].sort((left, right) => {
    const recency = (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')
    return recency !== 0 ? recency : right.stars - left.stars || left.name.localeCompare(right.name)
  })
  const categories = new Map<string, string>()
  for (const contribution of contributions) {
    for (const category of contribution.categories) categories.set(category.id, category.label)
  }
  const updated = [topic?.updated, curated?.updated, builtin?.updated].filter((item): item is string => item !== undefined).sort().at(-1)
  return {
    source: 'builtin+github-topic+awesome-dsh-plugin',
    sourceUrl: TOPIC_URL,
    topicUrl: TOPIC_URL,
    curatedSourceUrl: REGISTRY_PAGE,
    ...(topic?.totalAvailable === undefined ? {} : { topicRepositoryCount: topic.totalAvailable }),
    ...(updated === undefined ? {} : { updated }),
    categories: [...categories].map(([id, label]) => ({ id, label })),
    plugins: merged,
  }
}

export { projectPluginRegistry }

/** Keep transport codes useful without dumping response bodies or request headers. */
function catalogFailureMessage(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause)
  const detail = cause.cause
  const code = typeof detail === 'object' && detail !== null && 'code' in detail && typeof detail.code === 'string'
    ? detail.code : undefined
  return code === undefined ? cause.message : `${cause.message} (${code})`
}
