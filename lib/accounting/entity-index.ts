import type { SupabaseClient } from '@supabase/supabase-js'
import { listVehiclesWithId, listMancoVehicles } from './load'
import { MANCO_KIND, VEHICLE_KINDS } from '@/lib/vehicle-kinds'
import type { IndexEntity } from './entity-pages'

// THE ENTITY INDEX: /funds, and every firm-wide section landing (/funds/journal, /funds/forecast…).
//
// Those landings used to load the books of every entity before showing anything — each entity's
// whole posted ledger for a trial balance, six counts, and on some the fund economics too — when
// what they are for is picking an entity. This reads the registry rows alone (two indexed queries,
// in parallel) and the page lists each entity with links to its pages. The figures live on the
// entity's own pages, which load one entity's books instead of all of them.

export type { IndexEntity }

const kindRank = (k: string | null) => {
  const i = VEHICLE_KINDS.indexOf((k ?? 'fund') as (typeof VEHICLE_KINDS)[number])
  return i < 0 ? VEHICLE_KINDS.length : i
}

export async function listIndexEntities(
  admin: SupabaseClient,
  fundId: string,
  opts: {
    includeManco: boolean
    /** Which entities the caller may see (entity access). */
    visible: (vehicleId: string | null) => boolean
  },
): Promise<IndexEntity[]> {
  const [vehicles, mancos] = await Promise.all([
    listVehiclesWithId(admin, fundId),
    opts.includeManco ? listMancoVehicles(admin, fundId) : Promise.resolve([]),
  ])
  return [
    ...vehicles.map(v => ({ ...v, active: true })),
    ...mancos.map(m => ({ id: m.id, name: m.name, kind: MANCO_KIND as string, active: m.active })),
  ]
    .filter(v => opts.visible(v.id))
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.name.localeCompare(b.name))
}
