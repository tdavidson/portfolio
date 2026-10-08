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

/**
 * What the bank page shows after a post, ignore, unpost or restore: a refusal as an error; what was
 * released or set aside as a plain notice; anything left to do (`warning`/`warnings`) as a warning.
 * A bulk post that stopped part-way returns the error AND what the entries posted before it released
 * — both are shown, or the tracker changes with nothing said.
 */
export function bankActionMessages(ok: boolean, body: (ReleaseReport & { error?: string; note?: string }) | null | undefined): {
  error: string | null
  notice: string | null
} {
  const b = body ?? {}
  const released = releaseNotice(b)
  const hasWarnings = !!b.warning || (b.warnings ?? []).length > 0
  if (!ok) {
    const error = b.error ?? 'That could not be done.'
    return released
      ? { error, notice: `The entries posted before it stopped: ${released}` }
      : { error, notice: null }
  }
  const notice = [b.note, released].filter(Boolean).join(' ') || null
  // Something left to do is a warning, shown where errors are.
  return hasWarnings ? { error: notice, notice: null } : { error: null, notice }
}
