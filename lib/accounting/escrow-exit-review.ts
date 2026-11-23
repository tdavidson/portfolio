// Exits with escrow, set beside what the ledger booked for them. READ-ONLY: nothing here writes.
//
// Until `proceeds_received` had one meaning (lib/portfolio/proceeds.ts), an exit's entry debited
// cash with proceeds_received AND 1350 with proceeds_escrow — right when proceeds_received was the
// cash received, and overstating cash and realized gain by the escrow when it was the gross (which
// is what the form asked for). Derivation now reads it as gross. An entry already posted is never
// re-derived by itself — only an edit or delete of its transaction retracts it — so each exit
// booked the old way stays as it was until a person looks at it. This lists them.
//
// The decision per exit is one comparison: did the bank receive `bookedCash` at the exit?
//   yes → proceeds_received was entered as the cash received. The books are right; the tracker reads
//         the row as gross and understates realized proceeds by the escrow. Edit Proceeds to
//         proceeds_received + proceeds_escrow; the re-derived entry books the same cash.
//   no, it received bookedCash − escrow → proceeds_received was the gross and the books overstate
//         cash and realized gain by the escrow. Re-save the transaction (or edit anything on it);
//         the re-derived entry books gross − escrow to cash.
//
// Used by scripts/diagnose-escrow-exits.ts and the accounting status page (status.ts).

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundCents } from './ledger'
import { ACTUAL_BOOK } from './books'
import { readAll } from './bank-quickbooks-match'
import { proceedsSplit } from '@/lib/portfolio/proceeds'
import { txnRef } from './from-portfolio'

/**
 * How the ledger booked the exit, against the transaction's own figures:
 *   gross          cash = proceeds_received − escrow. The current rule; nothing to review.
 *   old_rule       cash = proceeds_received, 1350 = escrow. Booked under the old reading — review.
 *   old_rule_no_1350  cash = proceeds_received and no escrow receivable (a chart without 1350) — review.
 *   not_on_ledger  no live entry owns the transaction.
 *   other          none of the above (an entry edited by hand, a partial match) — review.
 */
export type EscrowExitReading = 'gross' | 'old_rule' | 'old_rule_no_1350' | 'not_on_ledger' | 'other'

export interface EscrowExitBooked { cash: number; escrow: number; gain: number }

export interface EscrowExitRow {
  txnId: string
  companyId: string
  company: string
  vehicle: string | null
  date: string | null
  roundName: string | null
  /** proceeds_received as stored. */
  proceedsReceived: number
  proceedsEscrow: number
  basis: number
  /** Escrow released so far for this company in this vehicle (escrow_receipt rows). */
  escrowReleased: number
  entryId: string | null
  entryOwner: 'derived' | 'adopted' | null
  entryStatus: string | null
  booked: EscrowExitBooked | null
  /** What the current rule books: cash gross − escrow, 1350 escrow, gain gross − basis. */
  expected: EscrowExitBooked
  reading: EscrowExitReading
  /** bookedCash − expected cash: the escrow when booked the old way. */
  cashDifference: number | null
}

const CENT = 0.005
const same = (a: number, b: number) => Math.abs(a - b) < CENT

/** Pure: how one exit was booked. */
export function classifyEscrowExit(
  txn: { proceeds_received?: unknown; proceeds_escrow?: unknown; cost_basis_exited?: unknown },
  booked: EscrowExitBooked | null,
): { expected: EscrowExitBooked; reading: EscrowExitReading; cashDifference: number | null } {
  const { gross, escrow, cash } = proceedsSplit(txn)
  const basis = Math.abs(Number(txn.cost_basis_exited ?? 0)) || 0
  const expected = { cash, escrow, gain: roundCents(gross - basis) }
  if (!booked) return { expected, reading: 'not_on_ledger', cashDifference: null }
  const cashDifference = roundCents(booked.cash - cash)
  let reading: EscrowExitReading = 'other'
  if (same(booked.cash, cash) && (same(booked.escrow, escrow) || same(booked.escrow, 0))) reading = 'gross'
  else if (same(booked.cash, gross) && same(booked.escrow, escrow)) reading = 'old_rule'
  else if (same(booked.cash, gross) && same(booked.escrow, 0)) reading = 'old_rule_no_1350'
  return { expected, reading, cashDifference }
}

/**
 * Booked, but not the way the current rule books it — a person has to compare it with the bank.
 * An exit not on the ledger yet is left to the "not on the ledger" backlog, which books it as gross
 * only when a person puts it there; the script lists it too.
 */
export const needsReview = (r: Pick<EscrowExitRow, 'reading'>) => r.reading !== 'gross' && r.reading !== 'not_on_ledger'

const chunks = <T,>(xs: T[], n = 200) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n))

/**
 * Every exit in the fund with escrow, with what its entry booked to cash (1000), escrow receivable
 * (1350) and realized gain. `vehicles` narrows to those portfolio_group names.
 */
export async function loadEscrowExits(admin: SupabaseClient, fundId: string, opts: { vehicles?: string[] } = {}): Promise<EscrowExitRow[]> {
  let q = (admin as any).from('investment_transactions').select('*')
    .eq('fund_id', fundId).eq('transaction_type', 'proceeds').gt('proceeds_escrow', 0)
  if (opts.vehicles) q = q.in('portfolio_group', opts.vehicles)
  const { data: exitRows, error } = await q
  if (error) throw new Error(`Exits could not be read: ${error.message}`)
  const exits = ((exitRows as any[]) ?? []).sort((a, b) => String(a.transaction_date).localeCompare(String(b.transaction_date)))
  if (exits.length === 0) return []

  const companyIds = Array.from(new Set(exits.map(t => t.company_id as string)))
  const [{ data: companies }, { data: receipts }] = await Promise.all([
    (admin as any).from('companies').select('id, name').eq('fund_id', fundId).in('id', companyIds),
    (admin as any).from('investment_transactions').select('company_id, portfolio_group, proceeds_received')
      .eq('fund_id', fundId).eq('transaction_type', 'escrow_receipt').in('company_id', companyIds),
  ])
  const nameOf = new Map<string, string>(((companies as any[]) ?? []).map(c => [c.id, c.name]))
  const released = new Map<string, number>()
  for (const r of (receipts as any[]) ?? []) {
    const k = `${r.company_id}|${r.portfolio_group ?? ''}`
    released.set(k, roundCents((released.get(k) ?? 0) + Number(r.proceeds_received ?? 0)))
  }

  // The live entry that owns each exit: derived (source_ref txn:<id>) or adopted (adopted_entry_id).
  const refs = exits.map(t => txnRef(t.id))
  const adoptedIds = exits.map(t => t.adopted_entry_id).filter(Boolean) as string[]
  const entries: any[] = []
  for (const part of chunks(refs)) {
    entries.push(...await readAll<any>((from, to) => (admin as any).from('journal_entries')
      .select('id, status, source_ref, journal_postings(account_id, amount)')
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).neq('status', 'void').in('source_ref', part).order('id').range(from, to)))
  }
  for (const part of chunks(adoptedIds)) {
    entries.push(...await readAll<any>((from, to) => (admin as any).from('journal_entries')
      .select('id, status, source_ref, journal_postings(account_id, amount)')
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).neq('status', 'void').in('id', part).order('id').range(from, to)))
  }
  const accountIds = Array.from(new Set(entries.flatMap(e => (e.journal_postings ?? []).map((p: any) => p.account_id as string))))
  const accounts = new Map<string, { code: string; subtype: string | null }>()
  for (const part of chunks(accountIds)) {
    const { data } = await (admin as any).from('chart_of_accounts').select('id, code, subtype').eq('fund_id', fundId).in('id', part)
    for (const a of (data as any[]) ?? []) accounts.set(a.id, { code: String(a.code), subtype: a.subtype ?? null })
  }
  const bookedOf = (e: any): EscrowExitBooked => {
    let cash = 0, escrow = 0, gain = 0
    for (const p of e.journal_postings ?? []) {
      const a = accounts.get(p.account_id)
      const amount = Number(p.amount)
      if (a?.code === '1000') cash += amount
      else if (a?.code === '1350' || a?.code === '1355') escrow += amount
      else if (a?.subtype === 'realized_gain') gain -= amount
    }
    return { cash: roundCents(cash), escrow: roundCents(escrow), gain: roundCents(gain) }
  }
  const byRef = new Map(entries.filter(e => e.source_ref).map(e => [e.source_ref as string, e]))
  const byId = new Map(entries.map(e => [e.id as string, e]))

  return exits.map(t => {
    const derived = byRef.get(txnRef(t.id))
    const adopted = t.adopted_entry_id ? byId.get(t.adopted_entry_id) : undefined
    const entry = derived ?? adopted ?? null
    const booked = entry ? bookedOf(entry) : null
    const { gross, escrow } = proceedsSplit(t)
    return {
      txnId: t.id,
      companyId: t.company_id,
      company: nameOf.get(t.company_id) ?? t.company_id,
      vehicle: t.portfolio_group ?? null,
      date: t.transaction_date ?? null,
      roundName: t.round_name ?? null,
      proceedsReceived: gross,
      proceedsEscrow: escrow,
      basis: Math.abs(Number(t.cost_basis_exited ?? 0)) || 0,
      escrowReleased: released.get(`${t.company_id}|${t.portfolio_group ?? ''}`) ?? 0,
      entryId: entry?.id ?? null,
      entryOwner: derived ? 'derived' : adopted ? 'adopted' : null,
      entryStatus: entry?.status ?? null,
      booked,
      ...classifyEscrowExit(t, booked),
    }
  })
}
