import { describe, expect, it } from 'vitest'
import type { BundleInfo } from '@deepseek-ai/dsh-plugin-manager/types'
import { installedBundleViews } from '../src/plugins/bundle-views.js'

function bundle(values: Partial<BundleInfo>): BundleInfo {
  return { name: 'fixture', official: false, availability: 'profile', enabled: false, installed: true,
    optional: false, removable: true, rows: [], overrides: [], ...values }
}

describe('native bundle inventory', () => {
  it('does not treat on-demand downloads as already installed', () => {
    expect(installedBundleViews([
      bundle({ name: 'downloadable', installed: false, official: true, availability: 'missing', installTarget: { spec: 'downloadable@1.0.0', version: '1.0.0' } }),
      bundle({ name: 'bundled', installed: false, availability: 'installation' }),
      bundle({ name: 'installed', version: '1.2.3', source: '^1.2.0' }),
    ]).map(row => row.name)).toEqual(['bundled', 'installed'])
  })

  it('retains declared or selected missing packages for diagnosis and removal', () => {
    const rows = installedBundleViews([
      bundle({ availability: 'missing', error: { code: 'operation-error', diagnostic: 'Package cannot be resolved' } }),
      bundle({ name: 'selected', installed: false, enabled: true, availability: 'missing' }),
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ missing: true, removable: true, error: 'Package cannot be resolved' })
    expect(rows[1]).toMatchObject({ missing: true, enabled: true })
  })
})
