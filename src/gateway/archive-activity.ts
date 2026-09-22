/** Names the native activity families and items without inferring process state. */
export function archiveActivityLines(value: unknown, label: (kind: string) => string): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(entry => {
    if (typeof entry !== 'object' || entry === null || typeof entry.kind !== 'string') return []
    const family = label(entry.kind)
    if (!Array.isArray(entry.items) || entry.items.length === 0) return [family]
    return entry.items.flatMap((item: unknown) => {
      if (typeof item !== 'object' || item === null || !('id' in item) || typeof item.id !== 'string') return []
      const text = 'label' in item && typeof item.label === 'string' ? item.label : item.id
      return [`${family}: ${text}`]
    })
  })
}
