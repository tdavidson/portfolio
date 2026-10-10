// What a capital call settles beyond the capital it asks for: money a partner sent AHEAD of the
// call, and other amounts a partner owes that the fund collects with it.
//
// ADVANCES. A wire from a partner with nothing called is not capital yet: it waits in 2350 (capital
// contributions received in advance), per partner. Issuing a call applies it — one entry per call,
// Dr 2350 / Cr Due from LPs per partner, dated the call — so the receivable the call created is met
// by the advance and only the rest is due. That entry is a SETTLEMENT like a wire: the call's
// register (lib/accounting/settlement.ts) sees it and the line shows paid, or partly paid.
//
// DEDUCTIONS, the mirror on a distribution: a fee, tax withheld, an unpaid call netted off. Each
// is its own entry, Dr Distributions payable (that partner) / Cr the account it belongs to — Due
// from LPs, for that partner, when it nets an unpaid call — tagged `dist-deduction:<dist>:<n>`.
// It reduces what is owed to the partner exactly as a wire would, so the register counts it as
// paid and only the rest is wired.
//
// CHARGES. Late interest, an expense or fee a partner owes, an equalization amount: each is its own
// entry, Dr Due from LPs (that partner) / Cr the account it belongs to, tagged to the call
// (`call-charge:<call>:<n>`). Nothing new is stored — the register reads them back from the books,
// adds them to the partner's line, and the wires that arrive settle the lot oldest first.

import type { SupabaseClient } from '@supabase/supabase-js'
import { accountIdByCode, persistEntry } from './persist'
import { loadPostedLedger } from './load'
import { ADVANCE_CODE, DISTRIBUTION_PAYABLE_CODE, RECEIVABLE_CODE } from './chart'
import { roundCents } from './ledger'
import { ACTUAL_BOOK } from './books'
import type { JournalEntry } from './types'

export const advanceRef = (callId: string) => `call-advance:${callId}`
export const chargeRefPrefix = (callId: string) => `call-charge:${callId}:`

export interface CallCharge {
  lpEntityId: string
  amount: number
  /** The account the charge is income to (or an expense it reimburses). */
  accountId: string
  description: string
}

/** Each partner's advance still unapplied: their credit balance on 2350. */
export async function advanceBalances(admin: SupabaseClient, fundId: string, group: string): Promise<Map<string, number>> {
  const { accounts, postings } = await loadPostedLedger(admin, fundId, group)
  const id = accounts.find(a => a.code === ADVANCE_CODE)?.id
  const out = new Map<string, number>()
  if (!id) return out
  for (const p of postings) {
    if (p.accountId !== id || !p.lpEntityId) continue
    out.set(p.lpEntityId, roundCents((out.get(p.lpEntityId) ?? 0) - p.amount))
  }
  for (const [lp, v] of out) if (v <= 0.005) out.delete(lp)
  return out
}

/** A wire received before anything is called: Dr cash / Cr received in advance (that partner). */
export function buildAdvanceEntry(base: { fundId: string; entryDate: string; memo?: string }, lpEntityId: string, amount: number, cashId: string, advanceId: string): JournalEntry {
  return {
    ...base, sourceType: 'capital_advance',
    postings: [
      { accountId: cashId, amount: roundCents(amount), currency: 'USD', lpEntityId: null },
      { accountId: advanceId, amount: roundCents(-amount), currency: 'USD', lpEntityId },
    ],
  }
}

async function exists(admin: SupabaseClient, fundId: string, ref: string, like = false): Promise<boolean> {
  const q = (admin as any).from('journal_entries').select('id').eq('fund_id', fundId).eq('book', ACTUAL_BOOK).neq('status', 'void')
  const { data } = await (like ? q.like('source_ref', `${ref}%`) : q.eq('source_ref', ref))
  return ((data as any[]) ?? []).length > 0
}

/**
 * Apply each partner's advance to their line on a just-issued call, once. Returns what was applied
 * per partner (nothing when there were no advances, or when this call already applied them).
 */
export async function applyAdvancesToCall(
  admin: SupabaseClient, fundId: string, group: string, userId: string | null,
  input: { callId: string; callDate: string; lines: Map<string, number> },
): Promise<{ applied: Map<string, number> } | { error: string }> {
  const applied = new Map<string, number>()
  if (await exists(admin, fundId, advanceRef(input.callId))) return { applied }
  const advances = await advanceBalances(admin, fundId, group)
  for (const [lp, line] of input.lines) {
    const take = roundCents(Math.min(line, advances.get(lp) ?? 0))
    if (take > 0.005) applied.set(lp, take)
  }
  if (applied.size === 0) return { applied }
  const codes = await accountIdByCode(admin, fundId, group)
  const advanceId = codes.get(ADVANCE_CODE), receivableId = codes.get(RECEIVABLE_CODE)
  if (!advanceId || !receivableId) return { error: `The chart is missing ${!advanceId ? `${ADVANCE_CODE} Capital contributions received in advance` : `${RECEIVABLE_CODE} Due from LPs`} — re-sync the chart of accounts.` }
  const entry: JournalEntry = {
    fundId, entryDate: input.callDate, memo: 'Capital call — met from amounts received in advance', sourceType: 'capital_advance_applied',
    sourceRef: advanceRef(input.callId),
    postings: [...applied].flatMap(([lp, amount]) => [
      { accountId: advanceId, amount, currency: 'USD', lpEntityId: lp },
      { accountId: receivableId, amount: roundCents(-amount), currency: 'USD', lpEntityId: lp },
    ]),
  }
  const r = await persistEntry(admin, fundId, group, userId, entry, 'posted')
  if ('error' in r) return { error: r.error }
  return { applied }
}

/** Post the other amounts a call collects, once each. Dr Due from LPs (the partner) / Cr the charge's account. */
export async function postCallCharges(
  admin: SupabaseClient, fundId: string, group: string, userId: string | null,
  input: { callId: string; callDate: string; charges: CallCharge[] },
): Promise<{ posted: number } | { error: string }> {
  const charges = input.charges.filter(c => c && typeof c.lpEntityId === 'string' && typeof c.accountId === 'string' && Number(c.amount) > 0)
  if (charges.length === 0) return { posted: 0 }
  if (await exists(admin, fundId, chargeRefPrefix(input.callId), true)) return { posted: 0 }
  const codes = await accountIdByCode(admin, fundId, group)
  const receivableId = codes.get(RECEIVABLE_CODE)
  if (!receivableId) return { error: `The chart is missing ${RECEIVABLE_CODE} Due from LPs.` }
  const allowed = new Set(codes.values())
  let posted = 0
  for (const [n, c] of charges.entries()) {
    if (!allowed.has(c.accountId) || c.accountId === receivableId) return { error: 'A charge names an account that is not in this entity’s chart.' }
    const amount = roundCents(Number(c.amount))
    const r = await persistEntry(admin, fundId, group, userId, {
      fundId, entryDate: input.callDate, memo: String(c.description || 'Charge with capital call').slice(0, 200), sourceType: 'call_charge',
      sourceRef: `${chargeRefPrefix(input.callId)}${n}`,
      postings: [
        { accountId: receivableId, amount, currency: 'USD', lpEntityId: c.lpEntityId },
        { accountId: c.accountId, amount: roundCents(-amount), currency: 'USD', lpEntityId: null },
      ],
    }, 'posted')
    if ('error' in r) return { error: r.error }
    posted++
  }
  return { posted }
}

/** Per call, per partner: the charges collected with it and the advance applied to it, from the books. */
export async function callExtras(admin: SupabaseClient, fundId: string, vehicleId: string | null, callIds: string[]): Promise<Map<string, { charges: Map<string, { amount: number; description: string }[]>; advance: Map<string, number> }>> {
  const out = new Map<string, { charges: Map<string, { amount: number; description: string }[]>; advance: Map<string, number> }>()
  if (!vehicleId || callIds.length === 0) return out
  const { data } = await (admin as any).from('journal_entries')
    .select('source_ref, memo, journal_postings(amount, lp_entity_id, chart_of_accounts!inner(code))')
    .eq('fund_id', fundId).eq('book', ACTUAL_BOOK).eq('vehicle_id', vehicleId).eq('status', 'posted')
    .or('source_ref.like.call-charge:%,source_ref.like.call-advance:%')
  for (const e of (data as any[]) ?? []) {
    const ref = String(e.source_ref)
    const callId = ref.split(':')[1]
    if (!callIds.includes(callId)) continue
    const slot = out.get(callId) ?? { charges: new Map(), advance: new Map() }
    for (const p of e.journal_postings ?? []) {
      if (p.chart_of_accounts?.code !== RECEIVABLE_CODE || !p.lp_entity_id) continue
      const amount = Number(p.amount)
      if (ref.startsWith('call-charge:') && amount > 0) {
        slot.charges.set(p.lp_entity_id, [...(slot.charges.get(p.lp_entity_id) ?? []), { amount, description: e.memo ?? 'Charge' }])
      } else if (ref.startsWith('call-advance:') && amount < 0) {
        slot.advance.set(p.lp_entity_id, roundCents((slot.advance.get(p.lp_entity_id) ?? 0) - amount))
      }
    }
    out.set(callId, slot)
  }
  return out
}

export const deductionRefPrefix = (distributionId: string) => `dist-deduction:${distributionId}:`

/** Post the deductions from a just-declared distribution, once each. */
export async function postDistributionDeductions(
  admin: SupabaseClient, fundId: string, group: string, userId: string | null,
  input: { distributionId: string; date: string; lines: Map<string, number>; deductions: CallCharge[] },
): Promise<{ posted: number } | { error: string }> {
  const deductions = input.deductions.filter(c => c && typeof c.lpEntityId === 'string' && typeof c.accountId === 'string' && Number(c.amount) > 0)
  if (deductions.length === 0) return { posted: 0 }
  if (await exists(admin, fundId, deductionRefPrefix(input.distributionId), true)) return { posted: 0 }
  const codes = await accountIdByCode(admin, fundId, group)
  const payableId = codes.get(DISTRIBUTION_PAYABLE_CODE)
  const receivableId = codes.get(RECEIVABLE_CODE)
  if (!payableId) return { error: `The chart is missing ${DISTRIBUTION_PAYABLE_CODE} Distributions payable.` }
  const allowed = new Set(codes.values())
  // Never more than the partner is owed on this distribution.
  const left = new Map(input.lines)
  let posted = 0
  for (const [n, d] of deductions.entries()) {
    if (!allowed.has(d.accountId) || d.accountId === payableId) return { error: 'A deduction names an account that is not in this entity’s chart.' }
    const owed = left.get(d.lpEntityId) ?? 0
    const amount = roundCents(Math.min(Number(d.amount), owed))
    if (amount <= 0) return { error: 'A deduction is larger than what that partner is owed on this distribution.' }
    left.set(d.lpEntityId, roundCents(owed - amount))
    const r = await persistEntry(admin, fundId, group, userId, {
      fundId, entryDate: input.date, memo: String(d.description || 'Deducted from distribution').slice(0, 200), sourceType: 'distribution_deduction',
      sourceRef: `${deductionRefPrefix(input.distributionId)}${n}`,
      postings: [
        { accountId: payableId, amount, currency: 'USD', lpEntityId: d.lpEntityId },
        // Netting an unpaid call clears THAT partner's receivable, so it carries their id.
        { accountId: d.accountId, amount: roundCents(-amount), currency: 'USD', lpEntityId: d.accountId === receivableId ? d.lpEntityId : null },
      ],
    }, 'posted')
    if ('error' in r) return { error: r.error }
    posted++
  }
  return { posted }
}

/** Per distribution, per partner: the deductions taken from it, from the books. */
export async function distributionDeductions(admin: SupabaseClient, fundId: string, vehicleId: string | null, distributionIds: string[]): Promise<Map<string, Map<string, { amount: number; description: string }[]>>> {
  const out = new Map<string, Map<string, { amount: number; description: string }[]>>()
  if (!vehicleId || distributionIds.length === 0) return out
  const { data } = await (admin as any).from('journal_entries')
    .select('source_ref, memo, journal_postings(amount, lp_entity_id, chart_of_accounts!inner(code))')
    .eq('fund_id', fundId).eq('book', ACTUAL_BOOK).eq('vehicle_id', vehicleId).eq('status', 'posted')
    .like('source_ref', 'dist-deduction:%')
  for (const e of (data as any[]) ?? []) {
    const id = String(e.source_ref).split(':')[1]
    if (!distributionIds.includes(id)) continue
    const slot = out.get(id) ?? new Map()
    for (const p of e.journal_postings ?? []) {
      if (p.chart_of_accounts?.code !== DISTRIBUTION_PAYABLE_CODE || !p.lp_entity_id || Number(p.amount) <= 0) continue
      slot.set(p.lp_entity_id, [...(slot.get(p.lp_entity_id) ?? []), { amount: Number(p.amount), description: e.memo ?? 'Deduction' }])
    }
    out.set(id, slot)
  }
  return out
}
