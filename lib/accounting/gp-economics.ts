import { loadPostedLedger } from './load'
import { loadResolvedCommitments } from './terms'
// GP / associate entity economics: who owns what, who holds carry points, and how much
// carry each partner has accrued, been paid, and is still owed.
//
// This is the accounting-side replacement for the "GP Entity Ownership" table that lived on
// the LPs page. It computes the SAME split the live report already does — it does not
// invent a second model — and adds the one thing that genuinely did not exist: carry paid.
//
// THE TWO ECONOMICS, and why they are separate:
//
//   ownership — a member's share of the capital the vehicle contributed to the fund, and of
//               everything that follows capital (gains, fees, expenses). DERIVED from
//               commitment_events wherever there are any, because a derived number cannot
//               drift from the books. Overridable only for a vehicle that has no
//               commitments to derive from.
//
//   carry     — a member's share of the carried interest the vehicle EARNS. Independent of
//               ownership: carry points routinely diverge from committed capital, and a
//               member can hold carry while committing nothing at all. Stored in
//               partner_allocation_terms (category 'carried_interest'), which is where the
//               look-through already reads them from. There is deliberately no second home
//               for them.
//
// Accrued carry is a MARK, NOT A DEBT. The close recomputes it from NAV each period and
// posts only the delta, so it reverses on its own if NAV falls. "Accrued and unpaid" means
// "what this partner would be owed if the fund liquidated today" — not a receivable. Every
// surface built on this must say so, or a GP will believe they are owed money they are not.

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundCents } from './ledger'
import { vehicleIdByName } from './vehicle-id'
import { loadCapitalPostings } from './capital-source'
import { computeCapitalAccounts, emptyAccount, type CapitalAccount } from './capital-account'
import { loadCommitmentEvents, resolveCommitmentMap, loadPartnerTerms } from './terms'
import { loadEntityNames, loadOwnership } from './load'
import { associateMembers, lookThroughAccount } from './look-through'
import { loadVehicleGpLinks } from './gp-links'
import { resolveCarryPaid, type CarryPayment } from './carry-paid'

export type { CarryPayment }

export interface GpVehicleLink {
  /** The associate/GP vehicle. */
  vehicle: string
  vehicleId: string
  /** The fund it is the GP of. */
  servesVehicle: string
  servesVehicleId: string
  /** The lp_entity it invests through, on the served fund's books. */
  lpEntityId: string
}

export type OwnershipBasis = 'commitments' | 'override' | 'none'

export interface GpPartnerRow {
  lpEntityId: string
  name: string
  /** 0–1. Share of the vehicle's capital. */
  ownershipPct: number
  /** 0–1. Share of the vehicle's carried interest. */
  carryPct: number
  /** Raw weight as stored, so the editor round-trips what was typed. */
  ownershipWeight: number
  carryWeight: number | null
  /** This member's share of the vehicle's capital account on the fund's books. */
  capital: CapitalAccount
  /** Carry accrued to this partner — their share of the vehicle's carriedInterest bucket. */
  carryAccrued: number
  /** Carry actually paid out (the register). */
  carryPaid: number | null
  /** accrued − paid. A mark, not a receivable. */
  carryUnpaid: number | null
}


export interface GpEconomics {
  link: GpVehicleLink
  /** Where the ownership split came from. */
  basis: OwnershipBasis
  /** How carry paid is sourced: 'ledger' = derived from the associate's own books;
   *  'events' = the editable carry_payments table (LP tracking). */
  source: 'ledger' | 'events' | 'mixed'
  /** The vehicle's own position on the fund's books, before the split. */
  associate: CapitalAccount
  partners: GpPartnerRow[]
  /** The carry-payment register — only for an LP-tracking ('events') vehicle; empty for ledger. */
  payments: CarryPayment[]
  totals: { carryAccrued: number; carryPaid: number | null; carryUnpaid: number | null; ending: number }
}

/**
 * The associate/GP vehicles in this fund that are properly linked to a fund — one row per
 * (gpVehicle, servedVehicle) link, so an entity that is GP of 3 vehicles yields 3 rows.
 */
export async function loadGpLinks(admin: SupabaseClient, fundId: string): Promise<GpVehicleLink[]> {
  const [links, vehRes] = await Promise.all([
    loadVehicleGpLinks(admin, fundId),
    (admin as any)
      .from('fund_vehicles')
      .select('id, name, kind, active')
      .eq('fund_id', fundId),
  ])

  const vehById = new Map<string, { name: string; kind: string; active: boolean }>(
    (((vehRes as any).data as any[]) ?? []).map(v => [v.id as string, { name: v.name as string, kind: v.kind as string, active: v.active as boolean }])
  )

  const rows: GpVehicleLink[] = []
  for (const l of links) {
    if (!l.lpEntityId) continue
    const gp = vehById.get(l.gpVehicleId)
    if (!gp || !['associate', 'gp'].includes(gp.kind) || !gp.active) continue
    const served = vehById.get(l.servedVehicleId)
    if (!served) continue
    rows.push({
      vehicle: gp.name,
      vehicleId: l.gpVehicleId,
      servesVehicle: served.name,
      servesVehicleId: l.servedVehicleId,
      lpEntityId: l.lpEntityId,
    })
  }
  return rows
}

/**
 * Every vehicle this GP/associate entity is linked to, each with the partner it appears as there.
 * An associate can be GP of a fund AND of SPVs (earning carry in each), so its position is the sum
 * across all of these, not just the first link.
 */
export async function gpLinksFor(
  admin: SupabaseClient,
  fundId: string,
  group: string,
): Promise<GpVehicleLink[]> {
  const links = await loadGpLinks(admin, fundId)
  return links.filter(l => l.vehicle === group)
}

/** Line-by-line sum of capital accounts (an associate's positions across the vehicles it serves). */
export function sumCapitalAccounts(accounts: CapitalAccount[]): CapitalAccount {
  const total = emptyAccount()
  for (const a of accounts) {
    for (const key of Object.keys(total) as (keyof CapitalAccount)[]) {
      total[key] = roundCents(total[key] + (a[key] ?? 0))
    }
  }
  return total
}

/**
 * The associate's combined position on the books of every vehicle it serves, as of `asOf`:
 * its capital account in each served vehicle (as its linked partner there), summed.
 */
export async function associatePosition(
  admin: SupabaseClient,
  fundId: string,
  links: GpVehicleLink[],
  asOf?: string,
): Promise<CapitalAccount> {
  const perServed = await Promise.all(links.map(async l => {
    const served = await loadCapitalPostings(admin, fundId, l.servesVehicle, asOf)
    return computeCapitalAccounts(served.postings).get(l.lpEntityId) ?? emptyAccount()
  }))
  return sumCapitalAccounts(perServed)
}

/** Is this vehicle a GP/associate entity with a fund behind it? */
export async function gpLinkFor(
  admin: SupabaseClient,
  fundId: string,
  group: string,
): Promise<GpVehicleLink | null> {
  const links = await loadGpLinks(admin, fundId)
  return links.find(l => l.vehicle === group) ?? null
}

/**
 * The ownership basis for an associate vehicle's members.
 *
 * Precedence, and the reason for it:
 *   1. An explicit override, when one exists. A vehicle that keeps no capital record has
 *      nothing to derive from, so its ownership must be stated.
 *   2. Commitments on the associate's own books (commitment_events). This is what the live
 *      report's look-through uses, and a derived number cannot drift from the books.
 *   3. The legacy `lp_investments` commitment scalar, which is the fallback the look-through
 *      already carries.
 */
export async function loadOwnershipBasis(
  admin: SupabaseClient,
  fundId: string,
  link: GpVehicleLink,
  asOf?: string,
): Promise<{ basis: OwnershipBasis; weights: Map<string, number> }> {
  const { data: overrides } = await (admin as any)
    .from('vehicle_partner_ownership')
    .select('lp_entity_id, ownership_weight')
    .eq('fund_id', fundId)
    .eq('vehicle_id', link.vehicleId)

  const ovr = ((overrides as any[]) ?? [])
  if (ovr.length > 0) {
    return {
      basis: 'override',
      weights: new Map(ovr.map(o => [o.lp_entity_id as string, Number(o.ownership_weight)])),
    }
  }

  const [events, owners] = await Promise.all([
    loadCommitmentEvents(admin, fundId, link.vehicle),
    loadOwnership(admin, fundId, link.vehicle),
  ])
  // Same events-or-scalar resolution as every other commitment reader (resolveCommitmentMap).
  // source:'ledger' — GP ownership weights follow commitments/events, not pasted positions
  // (whether tracking-vehicle positions should feed GP ownership is a separate question).
  const weights = await loadResolvedCommitments(admin, fundId, link.vehicle, asOf)
  if (Array.from(weights.values()).some(v => v > 0)) {
    return { basis: 'commitments', weights }
  }

  return { basis: 'none', weights: new Map() }
}

/**
 * Everything the GP panel shows for one associate/GP vehicle.
 *
 * The split itself is `lookThroughAccount`, the same function the live report calls, so the
 * accounting page and the LP report can never disagree about a member's position.
 */
export async function loadGpEconomics(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  asOf?: string,
): Promise<GpEconomics | null> {
  const links = await gpLinksFor(admin, fundId, group)
  const link = links[0]
  if (!link) return null

  const [{ basis, weights }, terms, names, associate, own] = await Promise.all([
    loadOwnershipBasis(admin, fundId, link, asOf),
    loadPartnerTerms(admin, fundId, link.vehicle),
    loadEntityNames(admin, fundId, link.vehicle),
    // The vehicle's position is on the SERVED VEHICLES' books, not its own — it is a partner
    // of each. That is where its carriedInterest bucket lives (carry ACCRUED), because that is
    // where each served vehicle's close credits it. Summed across every vehicle it serves.
    associatePosition(admin, fundId, links, asOf),
    // Carry PAID comes from the associate's OWN books. The ledger separates a member's
    // distributions into return-of-capital (source_type 'distribution') and carried-interest
    // paid (source_type 'carried_interest') — they are different economics and post to different
    // buckets. Only the carried-interest portion is carry paid.
    loadCapitalPostings(admin, fundId, link.vehicle, asOf),
  ])

  // Carry points: only rows that PARTICIPATE and carry an explicit weight. The
  // 20260713000000 backfill inserted `participates = false` rows for every gp-class partner
  // on this category, so an unfiltered read would pick up weights that mean nothing.
  const carryWeights = new Map<string, number>(
    terms
      .filter(t => t.category === 'carried_interest' && t.participates && t.weightOverride != null)
      .map(t => [t.lpEntityId, Number(t.weightOverride)])
  )

  const members = associateMembers(weights, carryWeights)
  const split = lookThroughAccount(associate, members)

  // Carry PAID is sourced from whichever books this vehicle keeps:
  //   • Fund Accounting (ledger): each member's distributions on the associate's OWN ledger,
  //     rolled up per partner straight from the books — no separate register to maintain.
  //   • LP tracking (events): an explicit table of (partner, date, amount) in carry_payments,
  //     edited on the panel — the tracking equivalent of the ledger's distribution postings.
  // Carry PAID from whichever books this vehicle keeps (resolveCarryPaid, the carry seam):
  // ledger → carry_distribution postings on the associate's own books; tracking → the
  // carry_payments register. Unpaid = accrued − paid.
  const { paidByLp, payments, unresolvedLpIds } = await resolveCarryPaid(admin, {
    source: own.source,
    ownPostings: (await loadPostedLedger(admin, fundId, link.vehicle, asOf)).capitalPostings,
    asOf,
    fundId,
    vehicleId: link.vehicleId,
  })

  const totalOwn = members.reduce((s, m) => s + Math.max(0, m.ownershipWeight), 0)
  const totalCarry = members.reduce((s, m) => s + Math.max(0, m.carryWeight), 0)

  // Also surface members who hold ONLY names (an entity with no weight at all) — they'd be
  // invisible otherwise, and an ownership table that silently omits a partner is worse than
  // one that shows them at zero.
  const allIds = new Set<string>([...members.map(m => m.lpEntityId), ...Array.from(names.keys())])

  const partners: GpPartnerRow[] = Array.from(allIds).map(lpEntityId => {
    const m = members.find(x => x.lpEntityId === lpEntityId)
    const capital = split.get(lpEntityId) ?? emptyAccount()
    const carryAccrued = roundCents(capital.carriedInterest)
    const carryPaid = unresolvedLpIds.has(lpEntityId) ? null : roundCents(paidByLp.get(lpEntityId) ?? 0)
    return {
      lpEntityId,
      name: names.get(lpEntityId) ?? lpEntityId,
      ownershipPct: totalOwn > 0 && m ? Math.max(0, m.ownershipWeight) / totalOwn : 0,
      carryPct: totalCarry > 0 && m ? Math.max(0, m.carryWeight) / totalCarry : 0,
      ownershipWeight: m?.ownershipWeight ?? 0,
      carryWeight: carryWeights.has(lpEntityId) ? carryWeights.get(lpEntityId)! : null,
      capital,
      carryAccrued,
      carryPaid,
      carryUnpaid: carryPaid == null ? null : roundCents(carryAccrued - carryPaid),
    }
  }).sort((a, b) => a.name.localeCompare(b.name))

  return {
    link,
    basis,
    source: own.source,
    associate,
    partners,
    payments,
    totals: {
      carryAccrued: roundCents(partners.reduce((s, p) => s + p.carryAccrued, 0)),
      carryPaid: partners.some(p => p.carryPaid == null) ? null : roundCents(partners.reduce((s, p) => s + p.carryPaid!, 0)),
      carryUnpaid: partners.some(p => p.carryUnpaid == null) ? null : roundCents(partners.reduce((s, p) => s + p.carryUnpaid!, 0)),
      ending: roundCents(partners.reduce((s, p) => s + p.capital.ending, 0)),
    },
  }
}

/** Set (or clear) a partner's ownership weight override. Weight <= 0 removes the row. */
export async function setOwnershipWeight(
  admin: SupabaseClient,
  fundId: string,
  vehicleId: string,
  lpEntityId: string,
  weight: number | null,
): Promise<void> {
  if (weight == null) {
    const { error } = await (admin as any)
      .from('vehicle_partner_ownership')
      .delete()
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('lp_entity_id', lpEntityId)
    if (error) throw new Error(error.message)
    return
  }
  const { error } = await (admin as any)
    .from('vehicle_partner_ownership')
    .upsert(
      { fund_id: fundId, vehicle_id: vehicleId, lp_entity_id: lpEntityId, ownership_weight: weight, updated_at: new Date().toISOString() },
      { onConflict: 'fund_id,vehicle_id,lp_entity_id' },
    )
  if (error) throw new Error(error.message)
}

/**
 * Set a partner's carry points.
 *
 * Writes `participates = true` alongside the weight, deliberately. The 20260713000000
 * backfill left `participates = false` rows on this category for every gp-class partner,
 * and the look-through ignores a weight whose row does not participate — so setting the
 * weight alone would look saved and do nothing.
 */
export async function setCarryWeight(
  admin: SupabaseClient,
  fundId: string,
  vehicleId: string,
  lpEntityId: string,
  weight: number | null,
): Promise<void> {
  const { error } = await (admin as any)
    .from('partner_allocation_terms')
    .upsert(
      {
        fund_id: fundId,
        vehicle_id: vehicleId,
        lp_entity_id: lpEntityId,
        category: 'carried_interest',
        participates: weight != null && weight > 0,
        weight_override: weight,
      },
      { onConflict: 'fund_id,vehicle_id,lp_entity_id,category' },
    )
  if (error) throw new Error(error.message)
}

export async function recordCarryPayment(
  admin: SupabaseClient,
  fundId: string,
  userId: string | null,
  input: { vehicleId: string; lpEntityId: string; paidDate: string; amount: number; memo?: string; journalEntryId?: string },
): Promise<{ id: string }> {
  if (!(input.amount > 0)) throw new Error('A carry payment must be a positive amount.')
  await validateCarryLink(admin, fundId, input)
  const { data, error } = await (admin as any)
    .from('carry_payments')
    .insert({
      fund_id: fundId,
      vehicle_id: input.vehicleId,
      lp_entity_id: input.lpEntityId,
      paid_date: input.paidDate,
      amount: input.amount,
      memo: input.memo ?? null,
      journal_entry_id: input.journalEntryId ?? null,
      created_by: userId,
    })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  return { id: (data as any).id }
}

export async function deleteCarryPayment(
  admin: SupabaseClient,
  fundId: string,
  id: string,
): Promise<void> {
  const { error } = await (admin as any)
    .from('carry_payments').delete().eq('fund_id', fundId).eq('id', id)
  if (error) throw new Error(error.message)
}

async function validateCarryLink(admin: SupabaseClient, fundId: string, input: { vehicleId: string; lpEntityId: string; paidDate: string; amount: number; journalEntryId?: string }) {
  if (input.journalEntryId) {
    const { data: entry, error } = await admin.from('journal_entries' as any).select('id, entry_date, source_type').eq('fund_id', fundId).eq('vehicle_id', input.vehicleId).eq('id', input.journalEntryId).eq('book', 'actual').eq('status', 'posted').maybeSingle()
    if (error || !entry || (entry as any).source_type !== 'carry_distribution' || (entry as any).entry_date !== input.paidDate) throw new Error('Link a posted carry distribution on this entity with the same payment date.')
    const { data: legs, error: legsError } = await admin.from('journal_postings' as any).select('amount, chart_of_accounts!inner(subtype)').eq('fund_id', fundId).eq('vehicle_id', input.vehicleId).eq('book', 'actual').eq('journal_entry_id', input.journalEntryId).eq('lp_entity_id', input.lpEntityId)
    const amount = ((legs as any[]) ?? []).filter(p => p.chart_of_accounts?.subtype === 'lp_capital').reduce((sum, p) => sum + Number(p.amount), 0)
    if (legsError || Math.abs(amount - input.amount) >= 0.005) throw new Error('The linked entry must have the same recipient and carry amount.')
  }
}

export async function reconcileCarryPayment(admin: SupabaseClient, fundId: string, vehicleId: string, id: string, journalEntryId?: string, separate = false) {
  const { data: payment, error } = await admin.from('carry_payments' as any).select('*').eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('id', id).single()
  if (error || !payment) throw new Error('Payment not found on this entity')
  const p = payment as any
  if (!journalEntryId && !separate) throw new Error('Choose a matching entry or identify this as a separate payment')
  await validateCarryLink(admin, fundId, { vehicleId, lpEntityId: p.lp_entity_id, paidDate: p.paid_date, amount: Number(p.amount), journalEntryId })
  const result = await admin.from('carry_payments' as any).update({ journal_entry_id: journalEntryId ?? null, separate_from_ledger: !journalEntryId && separate }).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('id', id)
  if (result.error) throw result.error
}
