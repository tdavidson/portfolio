//
// Which entities a holding belongs to, and which entity a watched wallet speaks for. One rule,
// used by the holding's own routes, the schedule of investments and the close, so the three can
// never disagree about whose chain balance is whose.

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

/** Per holding, the entity names that bought into it (an `investment` row tagged to the entity). */
export function holdersFromTransactions(
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
