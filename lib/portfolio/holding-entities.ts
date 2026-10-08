//
// Which entities a holding belongs to, and which entity a watched wallet speaks for. One rule,
// AT ONE DATE: the close (at the period end), the schedule of investments (at each period's end)
// and the holding's wallets route (at its ?asOf=) all take their holders from `holdersAsOf`, so
// for the same entity and date the three cannot disagree about whose chain balance is whose.
// Holders taken from all of time instead would let a second entity that bought AFTER a period end
// take an untagged wallet away from the first entity's schedule for that period, while the
// close — cut at the period end — still counted it.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'

export interface HoldingEntity { id: string; name: string }

/**
 * The caller's entities linked to one holding (company_vehicles: holding or assigned), by name.
 * THROWS if either read fails — a failed read is not "no entities"; callers catch.
 */
export async function holdingEntities(
  admin: SupabaseClient,
  fundId: string,
  companyId: string,
  access: Pick<AccessContext, 'vehicles'>,
): Promise<HoldingEntity[]> {
  const { data: links, error: linksError } = await (admin as any).from('company_vehicles').select('vehicle_id')
    .eq('fund_id', fundId).eq('company_id', companyId)
  if (linksError) throw new Error(`company_vehicles read failed: ${linksError.message}`)
  const ids = Array.from(new Set(((links as any[]) ?? []).map(l => l.vehicle_id as string)))
    .filter(id => canSeeVehicle(access, id))
  if (ids.length === 0) return []
  const { data: vehicles, error: vehiclesError } = await (admin as any).from('fund_vehicles').select('id, name')
    .eq('fund_id', fundId).in('id', ids)
  if (vehiclesError) throw new Error(`fund_vehicles read failed: ${vehiclesError.message}`)
  return ((vehicles as any[]) ?? [])
    .map(v => ({ id: v.id as string, name: v.name as string }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

type TxnLike = { company_id: string; transaction_type: string; portfolio_group?: string | null; transaction_date?: string | null }

/**
 * Per holding, the entity names that had bought into it by `date` (an `investment` row tagged to
 * the entity, dated on or before it; an undated row counts, as everywhere else that cuts history
 * at a date). `date` null = every transaction, for an action taken now rather than at a date.
 *
 * Holders are fund-wide — never narrowed to the caller's entity — so a holding two entities hold
 * leaves an untagged wallet counting for neither.
 */
export function holdersAsOf(txns: TxnLike[], date: string | null): Map<string, string[]> {
  return holdersFromTransactions(date === null ? txns : txns.filter(t => !t.transaction_date || t.transaction_date <= date))
}

/** Per holding, the entity names that bought into it — over whatever history it is given. */
function holdersFromTransactions(
  txns: { company_id: string; transaction_type: string; portfolio_group?: string | null }[],
): Map<string, string[]> {
  const sets = new Map<string, Set<string>>()
  for (const t of txns) {
    if (t.transaction_type !== 'investment' || !t.portfolio_group) continue
    if (!sets.has(t.company_id)) sets.set(t.company_id, new Set())
    sets.get(t.company_id)!.add(t.portfolio_group)
  }
  return new Map(Array.from(sets, ([k, v]) => [k, Array.from(v).sort()]))
}

type WalletLike = { company_id: string; portfolio_group?: string | null }

/**
 * The entity a wallet speaks for: its own `portfolio_group`, or — for a wallet watched before
 * wallets had an entity — the holding's only holder. Null when that cannot be said: an untagged
 * wallet on a holding two entities hold belongs to neither, rather than to both.
 */
export function walletEntity(w: WalletLike, holders: Map<string, string[]>): string | null {
  if (w.portfolio_group) return w.portfolio_group
  const h = holders.get(w.company_id) ?? []
  return h.length === 1 ? h[0] : null
}

/** The wallets that speak for one entity's position in each holding. */
export function walletsForEntity<T extends WalletLike>(wallets: T[], group: string, holders: Map<string, string[]>): T[] {
  return wallets.filter(w => walletEntity(w, holders) === group)
}

/** The wallets a caller may see: those of their entities. `visibleNames` null = every entity. */
export function scopeWallets<T extends WalletLike>(
  wallets: T[], visibleNames: string[] | null, holders: Map<string, string[]>,
): T[] {
  if (visibleNames === null) return wallets
  return wallets.filter(w => {
    const e = walletEntity(w, holders)
    return e !== null && visibleNames.includes(e)
  })
}
