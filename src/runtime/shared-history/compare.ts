/** Key order is not part of the logical append-only history contract. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** A diverged log must become a separate history, never overwrite the destination. */
export function compareHistories(source: readonly unknown[], target: readonly unknown[]): 'equal' | 'source-ahead' | 'target-ahead' | 'diverged' {
  for (let index = 0; index < Math.min(source.length, target.length); index++) {
    if (canonicalJson(source[index]) !== canonicalJson(target[index])) return 'diverged'
  }
  return source.length === target.length ? 'equal' : source.length > target.length ? 'source-ahead' : 'target-ahead'
}
