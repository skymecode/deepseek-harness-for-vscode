/** Window-local drafts follow session identity, never the next selected conversation. */
export class SessionDrafts {
  private active: string | undefined
  private readonly drafts = new Map<string, string>()

  select(id: string | undefined, currentText: string): string | undefined {
    if (id === this.active) return undefined
    if (this.active !== undefined) {
      if (currentText) this.drafts.set(this.active, currentText)
      else this.drafts.delete(this.active)
    }
    this.active = id
    return id === undefined ? '' : this.drafts.get(id) ?? ''
  }
}
