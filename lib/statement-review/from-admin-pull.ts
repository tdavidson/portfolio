// A saved administrator pull (lib/admin-reporting) as a statement package.
//
// A pull states each partner's commitment, paid-in, distributions and NAV to date, so the package
// carries them as to-date figures and ending capital. It has no beginning balance or allocations,
// so the roll-forward can't run on it; continuity (paid-in and distributions carrying on, commitments
// unchanged, nobody dropped) and completeness can.

import type { AdminFigures } from '@/lib/admin-reporting/figures'

export function packageInputFromPull(figures: AdminFigures, matches: { externalId: string; lpEntityId: string | null }[] = []) {
  const matched = new Map(matches.filter(m => m.lpEntityId).map(m => [m.externalId, m.lpEntityId as string]))
  const document = `${figures.source} figures as of ${figures.asOf}`
  return {
    period_end: figures.asOf,
    source: 'administrator' as const,
    documents: [{ name: document, kind: 'admin_pull' }],
    partners: figures.positions.map(p => {
      const cite = (label: string) => ({ document, label: `${p.name}, ${label}` })
      const lp = p.lpEntityId ?? matched.get(p.externalId)
      return {
        external_id: p.externalId,
        name: p.name,
        ...(lp ? { lp_entity_id: lp } : {}),
        commitment: p.commitment,
        paid_in_to_date: p.paidIn,
        distributed_to_date: p.distributions,
        ending: p.nav,
        cite: {
          commitment: cite('commitment'),
          paidInToDate: cite('paid-in'),
          distributedToDate: cite('distributions'),
          ending: cite('NAV'),
        },
      }
    }),
  }
}
