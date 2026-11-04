// Recycling: exit proceeds a vehicle puts back to work instead of distributing. The one read and
// write path for the terms and the register, used by the agent tools and their staged actions.
//
// The terms (cap, its basis, an end date, what the money may fund, the default treatment) sit on
// vehicle_waterfall_terms beside the carry terms, because they come from the same LPA clauses and
// are read with them. The register, `recycled_proceeds`, is one row per recycled amount, and the
// running total against the cap is read from it.
//
// Two treatments (packages/fund-engine/src/recycling.ts):
//
//   retained  never distributed. Nothing is posted: the cash is already in the bank, and keeping
//             it there is what makes the next call smaller. The row counts against the cap.
//   deemed    distributed and recontributed. One posted entry, no cash, no notices
//             (buildRecycledProceedsEntry): each partner's capital account shows a distribution
//             and a contribution of the same amount, on the same date, split by commitment like a
//             call. Same date means the waterfall reads the distribution as a return of the
//             capital recontributed with it, so it never reaches the hurdle or carry. The
//             distribution is recallable, so uncalled commitment is unchanged
//             (recontributedByLp; capital-calls.ts, live-report.ts).
//
// A deemed row whose entry has been voided no longer counts, so voiding the entry (the usual
// correction, with its audit reason) is how one is undone; `removeRecycling` then clears the row.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  recyclingCap,
  recyclingTermsFromRow,
  type RecyclingCapBasis,
  type RecyclingTerms,
  type RecyclingTreatment,
  type RecyclingUses,
} from '@portfolio/fund-engine'
import { roundCents } from './ledger'
import { allocateAmount } from './allocation'
import { accountIdByCode, ensureCapitalAccounts, persistEntry } from './persist'
import { DISTRIBUTION_PAYABLE_CODE } from './chart'
import { buildRecycledProceedsEntry } from './entries'
import { loadOwnership, loadPostedLedger } from './load'
import { computeCapitalAccounts } from './capital-account'
import { validCapitalDate } from './capital-operation-key'
import { vehicleIdByName } from './vehicle-id'
import { ensureVehicleAccounts } from './provision-accounts'
import { ACTUAL_BOOK } from './books'

export const RECYCLING_TREATMENTS: RecyclingTreatment[] = ['retained', 'deemed']
export const RECYCLING_CAP_BASES: RecyclingCapBasis[] = ['commitments', 'management_fees']
export const RECYCLING_USES: RecyclingUses[] = ['any', 'new_investments', 'follow_ons']

export const TREATMENT_LABEL: Record<RecyclingTreatment, string> = {
  retained: 'never distributed',
  deemed: 'distributed and recontributed',
}

/** The vehicle's recycling terms. No row, or a database not yet migrated, reads as no recycling. */
export async function loadRecyclingTerms(admin: SupabaseClient, fundId: string, group: string): Promise<RecyclingTerms> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return recyclingTermsFromRow(null)
  const { data } = await admin
    .from('vehicle_waterfall_terms' as any)
    .select('*')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .maybeSingle()
  return recyclingTermsFromRow(data as any)
}

export interface RecyclingTermsInput {
  capRate?: unknown
  capBasis?: unknown
  until?: unknown
  uses?: unknown
  defaultTreatment?: unknown
}

/** Check the terms without touching the database. Rates are fractions (0.2 = 20%). */
export function parseRecyclingTerms(body: RecyclingTermsInput): { ok: true; value: RecyclingTerms } | { error: string } {
  const capRate = body?.capRate == null || body.capRate === '' ? 0 : Number(body.capRate)
  if (!Number.isFinite(capRate) || capRate < 0 || capRate > 2) return { error: 'The recycling cap must be a fraction from 0 to 2 (0.2 = 20%).' }
  const capBasis = body?.capBasis ?? 'commitments'
  if (!(RECYCLING_CAP_BASES as unknown[]).includes(capBasis)) return { error: 'The cap is a share of commitments or of management fees.' }
  const until = body?.until == null || body.until === '' ? null : body.until
  if (until !== null && !validCapitalDate(until)) return { error: 'The end date must be a date (YYYY-MM-DD).' }
  const uses = body?.uses ?? 'any'
  if (!(RECYCLING_USES as unknown[]).includes(uses)) return { error: 'Recycled proceeds may fund any use, new investments or follow-ons.' }
  const defaultTreatment = body?.defaultTreatment ?? 'retained'
  if (!(RECYCLING_TREATMENTS as unknown[]).includes(defaultTreatment)) return { error: 'The treatment is retained (never distributed) or deemed (distributed and recontributed).' }
  return {
    ok: true,
    value: { capRate, capBasis: capBasis as RecyclingCapBasis, until: until as string | null, uses: uses as RecyclingUses, defaultTreatment: defaultTreatment as RecyclingTreatment },
  }
}

/** Store the terms. Only the recycle_* columns are written, so the carry terms are untouched. */
export async function saveRecyclingTerms(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  body: RecyclingTermsInput,
): Promise<{ ok: true; terms: RecyclingTerms } | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: `Unknown vehicle "${group}".` }
  const parsed = parseRecyclingTerms(body)
  if ('error' in parsed) return parsed
  const t = parsed.value
  const { error } = await admin
    .from('vehicle_waterfall_terms' as any)
    .upsert(
      {
        fund_id: fundId,
        vehicle_id: vehicleId,
        recycle_cap_rate: t.capRate,
        recycle_cap_basis: t.capBasis,
        recycle_until: t.until,
        recycle_uses: t.uses,
        recycle_default_treatment: t.defaultTreatment,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'fund_id,vehicle_id' },
    )
  if (error) return { error: 'The recycling terms could not be saved.' }
  return { ok: true, terms: t }
}

export interface RecycledRow {
  id: string
  recycledOn: string
  amount: number
  treatment: RecyclingTreatment
  companyId: string | null
  description: string | null
  journalEntryId: string | null
  /** False for a deemed row whose entry was voided: it no longer counts against the cap. */
  live: boolean
}

export interface RecyclingStatus {
  vehicle: string
  terms: RecyclingTerms
  /** What the cap is measured against today. */
  base: { commitments: number; managementFees: number }
  cap: number
  used: number
  /** What may still be recycled today (0 after the end date). */
  headroom: number
  rows: RecycledRow[]
}

/** The vehicle's recycling register, oldest first. A deemed row whose entry was voided is not live. */
export async function loadRecycledRows(admin: SupabaseClient, fundId: string, vehicleId: string): Promise<RecycledRow[]> {
  const { data, error } = await (admin as any)
    .from('recycled_proceeds')
    .select('id, recycled_on, amount, treatment, company_id, description, journal_entry_id')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .order('recycled_on', { ascending: true })
  if (error) throw error
  const raw = ((data as any[]) ?? [])
  const entryIds = raw.map(r => r.journal_entry_id).filter(Boolean)
  const status = new Map<string, string>()
  if (entryIds.length) {
    const { data: entries } = await admin.from('journal_entries' as any).select('id, status').eq('book', ACTUAL_BOOK).in('id', entryIds)
    for (const e of ((entries as any[]) ?? [])) status.set(e.id, e.status)
  }
  return raw.map(r => ({
    id: r.id,
    recycledOn: String(r.recycled_on).slice(0, 10),
    amount: roundCents(Number(r.amount)),
    treatment: r.treatment === 'deemed' ? 'deemed' : 'retained',
    companyId: r.company_id ?? null,
    description: r.description ?? null,
    journalEntryId: r.journal_entry_id ?? null,
    live: r.treatment !== 'deemed' || (!!r.journal_entry_id && status.get(r.journal_entry_id) === 'posted'),
  }))
}

/** The terms, the cap, what has been used and the register. */
export async function recyclingStatus(admin: SupabaseClient, fundId: string, group: string, asOf?: string): Promise<RecyclingStatus> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const [terms, owners, ledger] = await Promise.all([
    loadRecyclingTerms(admin, fundId, group),
    loadOwnership(admin, fundId, group),
    loadPostedLedger(admin, fundId, group),
  ])
  const commitments = roundCents(owners.reduce((s, o) => s + Math.max(0, o.commitment), 0))
  const accounts = computeCapitalAccounts(ledger.capitalPostings)
  // Fees charged to the partners' capital to date (the line is negative on the roll-forward).
  const managementFees = roundCents(-Array.from(accounts.values()).reduce((s, a) => s + a.managementFees, 0))
  const base = { commitments, managementFees: Math.max(0, managementFees) }

  const rows = vehicleId ? await loadRecycledRows(admin, fundId, vehicleId) : []
  const cap = recyclingCap(terms, base)
  const used = roundCents(rows.filter(r => r.live).reduce((s, r) => s + r.amount, 0))
  const today = asOf ?? new Date().toISOString().slice(0, 10)
  const headroom = terms.until && today > terms.until ? 0 : roundCents(Math.max(0, cap - used))
  return { vehicle: group, terms, base, cap, used, headroom, rows }
}

export interface RecordRecyclingInput {
  date?: unknown
  amount?: unknown
  /** Defaults to the terms' default treatment. */
  treatment?: unknown
  companyId?: unknown
  description?: unknown
}

export interface CheckedRecycling {
  date: string
  amount: number
  treatment: RecyclingTreatment
  companyId: string | null
  description: string | null
  /** Each partner's share, for a deemed amount: by commitment, as a call would split it. */
  perLp: { lpEntityId: string; amount: number }[]
  status: RecyclingStatus
}

/** Check a recycled amount against the terms and the cap, writing nothing. */
export async function checkRecycling(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  input: RecordRecyclingInput,
): Promise<{ ok: true; value: CheckedRecycling } | { error: string }> {
  const date = input?.date
  if (!validCapitalDate(date)) return { error: 'The date the proceeds were received is required (YYYY-MM-DD).' }
  const amount = roundCents(Number(input?.amount))
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'The recycled amount must be more than zero.' }
  const status = await recyclingStatus(admin, fundId, group, date as string)
  const { terms } = status
  if (!(terms.capRate > 0)) return { error: `${group} has no recycling terms. Set its cap first (set_recycling_terms).` }
  if (terms.until && (date as string) > terms.until) return { error: `Proceeds received after ${terms.until} cannot be recycled under ${group}'s terms.` }
  if (amount > status.headroom + 0.005) {
    return { error: `That is more than ${group} may still recycle: the cap is ${status.cap.toLocaleString('en-US')}, ${status.used.toLocaleString('en-US')} is used, so ${status.headroom.toLocaleString('en-US')} is left.` }
  }
  const treatment = input?.treatment == null || input.treatment === '' ? terms.defaultTreatment ?? 'retained' : input.treatment
  if (!(RECYCLING_TREATMENTS as unknown[]).includes(treatment)) return { error: 'The treatment is retained (never distributed) or deemed (distributed and recontributed).' }

  let perLp: { lpEntityId: string; amount: number }[] = []
  if (treatment === 'deemed') {
    const owners = (await loadOwnership(admin, fundId, group)).filter(o => o.commitment > 0)
    if (owners.length === 0) return { error: `No commitments are recorded for ${group}, so a deemed amount cannot be split between the partners.` }
    perLp = Array.from(allocateAmount(amount, owners.map(o => ({ lpEntityId: o.lpEntityId, commitment: o.commitment }))).entries())
      .map(([lpEntityId, a]) => ({ lpEntityId, amount: a }))
      .filter(l => l.amount > 0)
  }
  return {
    ok: true,
    value: {
      date: date as string,
      amount,
      treatment: treatment as RecyclingTreatment,
      companyId: typeof input?.companyId === 'string' && input.companyId ? input.companyId : null,
      description: typeof input?.description === 'string' && input.description.trim() ? input.description.trim().slice(0, 500) : null,
      perLp,
      status,
    },
  }
}

/** Record a recycled amount: a register row, and for deemed the one netted entry. */
export async function recordRecycling(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  input: RecordRecyclingInput,
): Promise<{ ok: true; id: string; entryId: string | null; checked: CheckedRecycling } | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: `Unknown vehicle "${group}".` }
  const checked = await checkRecycling(admin, fundId, group, input)
  if ('error' in checked) return checked
  const c = checked.value
  if (c.companyId) {
    const { data: co } = await admin.from('companies' as any).select('id').eq('fund_id', fundId).eq('id', c.companyId).maybeSingle()
    if (!co) return { error: 'That company is not in this fund.' }
  }

  let entryId: string | null = null
  if (c.treatment === 'deemed') {
    await ensureVehicleAccounts(admin, fundId, group)
    const codes = await accountIdByCode(admin, fundId, group)
    const payableId = codes.get(DISTRIBUTION_PAYABLE_CODE)
    if (!payableId) return { error: `The chart is missing account ${DISTRIBUTION_PAYABLE_CODE} Distributions payable — add it under the entity's Admin → Chart of accounts.` }
    const capMap = await ensureCapitalAccounts(admin, fundId, group, c.perLp.map(l => l.lpEntityId))
    const memo = `Recycled proceeds, distributed and recontributed${c.description ? ` — ${c.description}` : ''}`
    const entry = buildRecycledProceedsEntry({ fundId, entryDate: c.date, memo }, new Map(c.perLp.map(l => [l.lpEntityId, l.amount])), capMap, payableId)
    const result = await persistEntry(admin, fundId, group, userId, entry, 'posted')
    if ('error' in result) return { error: result.error }
    entryId = result.entryId
  }

  const { data: row, error } = await (admin as any)
    .from('recycled_proceeds')
    .insert({
      fund_id: fundId,
      vehicle_id: vehicleId,
      recycled_on: c.date,
      amount: c.amount,
      treatment: c.treatment,
      company_id: c.companyId,
      description: c.description,
      journal_entry_id: entryId,
      created_by: userId,
    })
    .select('id')
    .single()
  if (error) {
    return { error: entryId
      ? `The entry was posted (${entryId}) but the register row could not be written: ${error.message}. Void the entry and try again.`
      : `The recycled amount could not be recorded: ${error.message}` }
  }
  return { ok: true, id: (row as any).id, entryId, checked: c }
}

/**
 * Remove a register row. A deemed row's entry must be voided first (with its audit reason, the
 * usual correction), because the row is only the register and the books are the entry.
 */
export async function removeRecycling(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  id: unknown,
): Promise<{ ok: true; row: RecycledRow } | { error: string }> {
  if (typeof id !== 'string' || !id) return { error: 'Which recycled amount? Pass its id (the recycling tool lists them).' }
  const status = await recyclingStatus(admin, fundId, group)
  const row = status.rows.find(r => r.id === id)
  if (!row) return { error: `No recycled amount with that id on ${group}.` }
  if (row.treatment === 'deemed' && row.live) {
    return { error: 'This amount was booked as distributed and recontributed. Void its entry first (void_entry, with a reason), then remove it.' }
  }
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { error } = await (admin as any).from('recycled_proceeds').delete().eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('id', id)
  if (error) return { error: `The recycled amount could not be removed: ${error.message}` }
  return { ok: true, row }
}
