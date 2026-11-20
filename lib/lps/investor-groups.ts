// Investor groupings: an investor may roll up under a parent (lp_investors.parent_id), so one
// family or institution that holds under several names reads as one LP. The LPs page table, the
// report cards (on screen, the zip and the assistant's links) and the assistant's LP tools all
// resolve a group the same way, here: follow parent_id to the top.

export interface InvestorRecord {
  id: string
  name: string
  parent_id?: string | null
  alternate_name?: string | null
}

export interface InvestorGroups {
  /** The topmost investor an investor rolls up to (itself when it has no parent). */
  topOf: (investorId: string) => string
  /** That top investor's name. */
  nameOf: (investorId: string) => string | undefined
  /** Every investor whose group is one of these (the groups' own ids included). */
  membersOf: (investorIds: Iterable<string>) => Set<string>
}

/** Resolve groups from the fund's investors. A parent chain that loops stops where it repeats. */
export function investorGroups(investors: InvestorRecord[]): InvestorGroups {
  const byId = new Map(investors.map(i => [i.id, i]))
  const cache = new Map<string, string>()
  const topOf = (id: string): string => {
    const hit = cache.get(id)
    if (hit) return hit
    const seen = new Set<string>([id])
    let cur = id
    for (;;) {
      const parent = byId.get(cur)?.parent_id
      if (!parent || !byId.has(parent) || seen.has(parent)) break
      seen.add(parent)
      cur = parent
    }
    cache.set(id, cur)
    return cur
  }
  return {
    topOf,
    nameOf: id => byId.get(topOf(id))?.name,
    membersOf: ids => {
      const tops = new Set(Array.from(ids, topOf))
      return new Set(investors.filter(i => tops.has(topOf(i.id))).map(i => i.id))
    },
  }
}

/** Does an investor's name or alternate name contain the search text (case-insensitive)? */
export function investorNameMatches(inv: { name: string; alternate_name?: string | null }, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return inv.name.toLowerCase().includes(q) || (inv.alternate_name ?? '').toLowerCase().includes(q)
}
