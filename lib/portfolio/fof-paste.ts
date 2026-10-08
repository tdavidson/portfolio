/**
 * Matching a manager's fund name to a fund holding, for the manager-email reader (fof-email.ts).
 *
 * Pure. With 20+ managers whose names rhyme
 * ("Acme Ventures III" vs "Acme Growth III"), a fuzzy match that guesses wrong books a call
 * against the wrong position and is only caught at the next manager tie-out. So matching is
 * exact-or-alias only: an unmatched row is a review item, which is cheap. A mismatched row is
 * a restatement, which is not.
 */

export interface GridInputRow {
  fundName: string
  /** null = the manager has not reported. NOT the same as a NAV of zero. */
  navAsOf: string | null
  reportedNav: number | null
  calls: number
  distributions: number
}

export interface MatchedRow {
  row: GridInputRow
  companyId: string | null
  matchedName: string | null
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

export function matchHoldings(
  rows: GridInputRow[],
  holdings: { id: string; name: string; aliases?: string[] | null }[],
): MatchedRow[] {
  const byName = new Map<string, { id: string; name: string }>()
  for (const h of holdings) {
    byName.set(norm(h.name), { id: h.id, name: h.name })
    for (const a of h.aliases ?? []) byName.set(norm(a), { id: h.id, name: h.name })
  }
  return rows.map(row => {
    const hit = byName.get(norm(row.fundName)) ?? null
    return { row, companyId: hit?.id ?? null, matchedName: hit?.name ?? null }
  })
}
