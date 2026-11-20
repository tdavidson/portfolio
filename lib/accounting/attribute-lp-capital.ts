// Attribute pooled LP capital to each partner's own account.
//
// When a vehicle is onboarded before its per-LP capital accounts exist, contributions and
// opening balances get booked to the POOLED "Partners' capital — LP (unallocated)" account
// (subtype lp_capital, no lp_entity_id) with each posting merely TAGGED with an lp_entity_id.
// The capital-account roll-forward only attributes a posting to an LP when it lands on that
// LP's OWN account (3100-<lp>), so those tagged-but-pooled postings never reach anyone's
// capital account — they sit unallocated forever.
//
// This moves each tagged pooled posting onto the partner's own account (creating it via
// `ensureCapitalAccounts`). It is balance-sheet-neutral — pooled and per-LP both roll into
// "Partners' capital" — so it's safe on posted entries too; only postings in a CLOSED period
// are skipped (reopen to include them). Untagged pooled postings can't be attributed and are
// reported for manual handling.

import type { SupabaseClient } from '@supabase/supabase-js'
import { vehicleIdByName } from './vehicle-id'
import { ensureCapitalAccounts } from './persist'
import { closedPeriodRanges, dateInAnyClosedPeriod } from './periods'
import { loadCommitmentEvents } from './terms'
import { fetchAllRows } from './load'
import { ACTUAL_BOOK } from './books'

/**
 * Every LP that should have a per-LP capital account for this vehicle: anyone with a
 * commitment (event history or the `lp_investments` scalar). Used to seed accounts for
 * committed-but-not-yet-contributed partners, so the roster is complete after onboarding.
 */
export async function committedLpIds(admin: SupabaseClient, fundId: string, group: string): Promise<string[]> {
  const ids = new Set<string>()
  for (const e of await loadCommitmentEvents(admin, fundId, group)) ids.add(e.lpEntityId)
  const { data: inv } = await admin
    .from('lp_investments' as any)
    .select('entity_id, commitment')
    .eq('fund_id', fundId)
    .eq('portfolio_group', group)
  for (const r of ((inv as any[]) ?? [])) if (Number(r.commitment) > 0 && r.entity_id) ids.add(r.entity_id)
  return Array.from(ids)
}

interface PooledPosting {
  id: string
  amount: number
  lpEntityId: string | null
  entryDate: string | null
}

export interface AttributePreview {
  /** Nothing to create and nothing to move. */
  empty: boolean
  /** Postings that would move from the pooled account to a per-LP account. */
  movable: number
  /** Distinct partners the movable postings belong to. */
  partners: { lpEntityId: string; name: string; postings: number; amount: number }[]
  /** Per-LP capital accounts that would be created (committed or tagged LPs lacking one). */
  accountsToCreate: number
  /** Tagged postings whose entry is in a closed period — skipped until reopened. */
  closedSkipped: number
  /** Pooled postings with no lp_entity_id — can't attribute, handle by hand. */
  untagged: number
}

/** lp_entity_ids that already have a per-LP capital account on this vehicle. */
async function existingLpAccountEntityIds(admin: SupabaseClient, fundId: string, vehicleId: string | null): Promise<Set<string>> {
  const { data } = await admin
    .from('chart_of_accounts' as any)
    .select('lp_entity_id')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .not('lp_entity_id', 'is', null)
  return new Set(((data as any[]) ?? []).map(a => a.lp_entity_id as string))
}

async function scan(admin: SupabaseClient, fundId: string, group: string) {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { data: pooled } = await admin
    .from('chart_of_accounts' as any)
    .select('id')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .eq('subtype', 'lp_capital')
    .is('lp_entity_id', null)
  const pooledIds = ((pooled as any[]) ?? []).map(a => a.id as string)
  if (pooledIds.length === 0) return { vehicleId, postings: [] as PooledPosting[] }

  // Paginate: PostgREST caps a single response at max_rows (1000), and a full-history
  // vehicle can have more than that many pooled postings — an unpaginated read would
  // silently attribute only the first page.
  // Exclude VOID entries. Their postings affect no balance, so attributing them achieves
  // nothing — but counting them made the tool report "N still untagged" for postings that
  // were never going to matter, which reads as an unfinished repair.
  const posts = await fetchAllRows<any>((f, t) =>
    admin
      .from('journal_postings' as any)
      .select('id, amount, lp_entity_id, journal_entries!inner(entry_date, status)')
      .eq('book', ACTUAL_BOOK)
      .eq('fund_id', fundId)
      .in('account_id', pooledIds)
      .neq('journal_entries.status', 'void')
      .order('id').range(f, t),
  )
  const postings: PooledPosting[] = (posts ?? []).map(p => ({
    id: p.id,
    amount: Number(p.amount),
    lpEntityId: p.lp_entity_id ?? null,
    entryDate: p.journal_entries?.entry_date ?? null,
  }))
  return { vehicleId, postings }
}

export async function previewAttributeLpCapital(
  admin: SupabaseClient,
  fundId: string,
  group: string,
): Promise<AttributePreview> {
  const { vehicleId, postings } = await scan(admin, fundId, group)
  const closed = await closedPeriodRanges(admin, fundId, group)

  const untagged = postings.filter(p => !p.lpEntityId).length
  const tagged = postings.filter(p => p.lpEntityId)
  const closedSkipped = tagged.filter(p => p.entryDate && dateInAnyClosedPeriod(closed, p.entryDate)).length
  const movablePostings = tagged.filter(p => !(p.entryDate && dateInAnyClosedPeriod(closed, p.entryDate)))

  const byLp = new Map<string, { postings: number; amount: number }>()
  for (const p of movablePostings) {
    const cur = byLp.get(p.lpEntityId!) ?? { postings: 0, amount: 0 }
    cur.postings += 1
    cur.amount += p.amount
    byLp.set(p.lpEntityId!, cur)
  }

  const ids = Array.from(byLp.keys())
  const names = new Map<string, string>()
  if (ids.length > 0) {
    const { data: ents } = await admin.from('lp_entities' as any).select('id, entity_name').eq('fund_id', fundId).in('id', ids)
    for (const e of ((ents as any[]) ?? [])) names.set(e.id, e.entity_name)
  }

  // Accounts to create: every committed OR tagged LP that lacks a per-LP account today.
  const committed = await committedLpIds(admin, fundId, group)
  const allLps = new Set<string>([...committed, ...ids])
  const existing = await existingLpAccountEntityIds(admin, fundId, vehicleId)
  const accountsToCreate = Array.from(allLps).filter(id => !existing.has(id)).length

  return {
    empty: movablePostings.length === 0 && accountsToCreate === 0,
    movable: movablePostings.length,
    partners: ids
      .map(id => ({ lpEntityId: id, name: names.get(id) ?? id, postings: byLp.get(id)!.postings, amount: byLp.get(id)!.amount }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    accountsToCreate,
    closedSkipped,
    untagged,
  }
}

export async function attributeLpCapital(
  admin: SupabaseClient,
  fundId: string,
  group: string,
): Promise<{ moved: number; accountsEnsured: number; accountsCreated: number; closedSkipped: number; untagged: number }> {
  const { vehicleId, postings } = await scan(admin, fundId, group)
  const closed = await closedPeriodRanges(admin, fundId, group)

  const untagged = postings.filter(p => !p.lpEntityId).length
  const tagged = postings.filter(p => p.lpEntityId)
  const closedSkipped = tagged.filter(p => p.entryDate && dateInAnyClosedPeriod(closed, p.entryDate)).length
  const movable = tagged.filter(p => !(p.entryDate && dateInAnyClosedPeriod(closed, p.entryDate)))
  // Create an account for every committed OR tagged LP, even if nothing needs re-pointing yet.
  const taggedLpIds = Array.from(new Set(movable.map(p => p.lpEntityId!)))
  const committed = await committedLpIds(admin, fundId, group)
  const allLpIds = Array.from(new Set([...taggedLpIds, ...committed]))
  if (allLpIds.length === 0) return { moved: 0, accountsEnsured: 0, accountsCreated: 0, closedSkipped, untagged }

  const existing = await existingLpAccountEntityIds(admin, fundId, vehicleId)
  const accountsCreated = allLpIds.filter(id => !existing.has(id)).length
  const capMap = await ensureCapitalAccounts(admin, fundId, group, allLpIds)

  // Re-point the movable (tagged) postings, one update per target account (batched by id).
  let moved = 0
  for (const lpId of taggedLpIds) {
    const accountId = capMap.get(lpId)
    if (!accountId) continue // ensureCapitalAccounts would have thrown on a foreign id; skip defensively
    const postingIds = movable.filter(p => p.lpEntityId === lpId).map(p => p.id)
    const { error } = await admin.from('journal_postings' as any).update({ account_id: accountId }).in('id', postingIds).eq('fund_id', fundId)
    if (error) throw new Error(error.message)
    moved += postingIds.length
  }

  return { moved, accountsEnsured: allLpIds.length, accountsCreated, closedSkipped, untagged }
}
