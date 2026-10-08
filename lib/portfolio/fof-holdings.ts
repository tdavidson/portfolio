// lib/portfolio/fof-holdings.ts
import { computeFofFromRaw } from './fof-load'
import type { FundPosition } from './fof-metrics'

/**
 * The fund-holdings register, one row per (holding, entity). Pure.
 *
 * Two of our entities can commit to the same underlying fund: one `companies` row, two
 * independent positions — different commitments, calls, capital accounts and NAVs. Merging them
 * (as this register used to) showed one entity's terms beside both entities' cash flows, which is
 * neither position. Each row here is computed from that entity's terms, notices and statements
 * only, through the same computation every other fund-of-funds surface uses (fof-load.ts).
 */
export interface HoldingRow extends FundPosition {
  /** The entity this position is for; null for a holding with no entity recorded yet. */
  vehicleId: string | null
  vehicleName: string | null
  /** `${companyId}:${vehicleId ?? 'none'}` — unique per row. */
  key: string
}

export const holdingRowKey = (companyId: string, vehicleId: string | null) => `${companyId}:${vehicleId ?? 'none'}`

export function fundHoldingRows(input: {
  asOf: string
  holdings: { id: string; name: string }[]
  terms: any[]
  events: any[]
  navs: any[]
  vehicles: { id: string; name: string }[]
}): HoldingRow[] {
  const names = new Map(input.vehicles.map(v => [v.id, v.name]))
  const rows: HoldingRow[] = []

  for (const h of input.holdings) {
    const of = (list: any[]) => list.filter(r => r.company_id === h.id)
    const terms = of(input.terms)
    const events = of(input.events)
    const navs = of(input.navs)

    const entities = new Set<string | null>()
    for (const r of [...events, ...navs]) entities.add(r.vehicle_id ?? null)
    for (const t of terms) if (t.vehicle_id) entities.add(t.vehicle_id)
    if (entities.size === 0) entities.add(null)
    const named = Array.from(entities).filter((v): v is string => v !== null)

    for (const v of Array.from(entities)) {
      const mine = (list: any[]) => list.filter(r => (r.vehicle_id ?? null) === v)
      // A legacy terms row names no entity. It is the commitment of the holding's only entity; with
      // two it could be either's, so it is neither's — and never counted twice beside a null row.
      const own = mine(terms)
      const scopedTerms = own.length > 0 || v === null
        ? own
        : named.length === 1 ? terms.filter(t => t.vehicle_id == null) : []
      const [position] = computeFofFromRaw(
        { holdings: [h], terms: v === null && named.length > 0 ? [] : scopedTerms, events: mine(events), navs: mine(navs) },
        input.asOf,
      ).positions
      rows.push({ ...position, vehicleId: v, vehicleName: v ? names.get(v) ?? null : null, key: holdingRowKey(h.id, v) })
    }
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name) || (a.vehicleName ?? '').localeCompare(b.vehicleName ?? ''))
}
