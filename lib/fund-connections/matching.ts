// Which LPs of two connected funds look like the same LP. Pure, so the rule is testable on its own.
//
// A suggestion is only that: nothing is linked until both funds' admins approve the pair. The
// suggestions are also the only way one fund sees the other's investors at all (besides pairs that
// already exist), so they list only investors that match on both sides, never the whole list.

export interface MatchableInvestor {
  id: string
  name: string
  contact_email?: string | null
}

export interface Suggestion {
  ours: MatchableInvestor
  theirs: MatchableInvestor
  reason: 'email' | 'name'
}

export const normalizeName = (s: string | null | undefined): string =>
  (s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

export const normalizeEmail = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase()

/**
 * One suggestion per unpaired investor of ours, matched by contact email first, then by name. A
 * key shared by two investors on the same side is ambiguous, so it suggests nothing: a guess
 * between two candidates is not a suggestion an admin should be approving in bulk.
 */
export function suggestPairs(
  ours: MatchableInvestor[],
  theirs: MatchableInvestor[],
  /** Investors already in a pair on this connection, on either side. */
  paired: Set<string> = new Set(),
): Suggestion[] {
  const freeOurs = ours.filter(i => !paired.has(i.id))
  const freeTheirs = theirs.filter(i => !paired.has(i.id))
  const out: Suggestion[] = []
  const taken = new Set<string>()

  for (const [reason, key] of [['email', (i: MatchableInvestor) => normalizeEmail(i.contact_email)], ['name', (i: MatchableInvestor) => normalizeName(i.name)]] as const) {
    const index = (list: MatchableInvestor[]) => {
      const m = new Map<string, MatchableInvestor[]>()
      for (const i of list) {
        if (taken.has(i.id)) continue
        const k = key(i)
        if (!k) continue
        m.set(k, [...(m.get(k) ?? []), i])
      }
      return m
    }
    const a = index(freeOurs)
    const b = index(freeTheirs)
    for (const [k, mine] of a) {
      const other = b.get(k)
      if (mine.length !== 1 || other?.length !== 1) continue
      out.push({ ours: mine[0], theirs: other[0], reason })
      taken.add(mine[0].id)
      taken.add(other[0].id)
    }
  }
  return out.sort((x, y) => x.ours.name.localeCompare(y.ours.name))
}

/** The other fund's investor an admin named by hand: an exact (normalized) name or email, and only one. */
export function findExact(theirs: MatchableInvestor[], query: string): MatchableInvestor | null {
  const q = query.trim()
  if (!q) return null
  const hits = q.includes('@')
    ? theirs.filter(i => normalizeEmail(i.contact_email) === normalizeEmail(q))
    : theirs.filter(i => normalizeName(i.name) === normalizeName(q))
  return hits.length === 1 ? hits[0] : null
}
