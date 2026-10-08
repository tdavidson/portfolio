// What to tell a person after a post that released investment transactions — the plain-words
// summary the bank page and the journal's bulk post show. Posting a reversal draft deletes the
// transactions that owned the entry it reverses; when that fails part-way the reversal is still
// posted and `warnings` says what is left to do. Silent, the tracker keeps a reversed position.

export interface ReleaseReport {
  removedTransactions?: { company?: string | null }[]
  unlinkedRegisterRows?: string[]
  warning?: string | null
  warnings?: (string | { warning: string })[]
}

export function releaseNotice(r: ReleaseReport | null | undefined): string | null {
  if (!r) return null
  const parts: string[] = []
  const removed = r.removedTransactions ?? []
  if (removed.length > 0) {
    const companies = Array.from(new Set(removed.map(t => t.company).filter(Boolean))) as string[]
    parts.push(`Deleted ${removed.length} investment transaction${removed.length === 1 ? '' : 's'}${companies.length ? ` (${companies.join(', ')})` : ''} recorded by the reversed ${removed.length === 1 ? 'entry' : 'entries'}.`)
  }
  const unlinked = r.unlinkedRegisterRows ?? []
  if (unlinked.length > 0) parts.push(`No longer linked to a transaction: ${unlinked.join(', ')}.`)
  const warnings = [...(r.warning ? [r.warning] : []), ...(r.warnings ?? []).map(w => (typeof w === 'string' ? w : w.warning))]
  parts.push(...warnings)
  return parts.length ? parts.join(' ') : null
}
