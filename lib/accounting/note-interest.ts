// Interest accrued on convertible notes.
//
// A note earns interest whether or not anyone books it. Not accruing it understates the fund's
// income and the position's carrying value — and then at conversion the interest silently
// appears inside the equity's cost basis with no record of where it came from.
//
// SAME SHAPE AS THE CARRY ACCRUAL (carry.ts): compute a TARGET from the terms and the time
// elapsed, compare it to what the ledger already carries, post the delta. Recomputing the target
// from scratch each close makes the accrual self-correcting — fix a wrong rate, and the next
// close repairs the balance rather than compounding the mistake.
//
// Dr 1150-<company> Accrued interest   (asset, per company)
// Cr 4100          Interest and dividend income
//
// INCOME, NOT A MARK. Interest a note genuinely earned is investment income; a valuation change
// is not. They belong on different lines, for the same reason FX does — an LP must be able to
// tell what the portfolio did from what the terms did. `4100` buckets to `operatingIncome` in the
// capital-account roll-forward, exactly as it should.

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundCents } from './ledger'

export interface Note {
  /** The transaction that created the note. */
  txnId: string
  companyId: string
  companyName: string
  /** Principal — what the fund actually lent. */
  principal: number
  /** Annual SIMPLE rate as a fraction. 0.08 = 8%. */
  rate: number
  /** When the note was issued — interest runs from here. */
  startDate: string
  /** Interest stops here even if the note hasn't converted. Null = runs until conversion. */
  maturityDate: string | null
  /** When the note converted, if it has. Interest stops here. */
  convertedDate?: string | null
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Interest earned on one note, from issue to `asOf`.
 *
 * SIMPLE, ACTUAL/365, counting the issue day — what the large majority of convertible notes actually specify, and the
 * same convention the preferred-return hurdle uses. An LP or an auditor can re-derive it by hand,
 * which is worth more than a marginally more precise model they can't check.
 *
 * Interest stops at the EARLIER of maturity and conversion. Past maturity an unconverted note is
 * renegotiated in practice, and accruing on regardless books income nobody is owed.
 */
export function accruedInterest(note: Note, asOf: string): number {
  if (!note.rate || note.rate <= 0 || note.principal <= 0) return 0

  const start = Date.parse(note.startDate)
  const end = Date.parse(asOf)
  if (Number.isNaN(start) || Number.isNaN(end)) return 0

  // The earliest of: the reporting date, maturity, conversion.
  const stops = [end]
  if (note.maturityDate) {
    const m = Date.parse(note.maturityDate)
    if (!Number.isNaN(m)) stops.push(m)
  }
  if (note.convertedDate) {
    const c = Date.parse(note.convertedDate)
    if (!Number.isNaN(c)) stops.push(c)
  }
  const until = Math.min(...stops)

  // The issue day earns interest. So a note accrued at a period end has earned through the END
  // of that day (issue and as-of days both counted: issued the 14th, accrued at the 31st is 18
  // days). A note that stops at conversion or maturity earns up to, not including, that day.
  // The two agree across a stop: accrued at the day before conversion and at conversion give the
  // same total.
  const stoppedEarly = stops.slice(1).some(t => t <= end)
  const days = (until - start) / DAY_MS + (stoppedEarly ? 0 : 1)
  if (until < start || days <= 0) return 0

  return roundCents(note.principal * note.rate * (days / 365))
}

export interface NoteAccrual {
  companyId: string
  companyName: string
  /** Total interest earned to date on this company's notes. */
  target: number
  /** What the ledger already carries in 1150 for this company. */
  alreadyAccrued: number
  /** What to post. Negative = a correction downwards (e.g. a rate was fixed). */
  delta: number
}

/**
 * What this close should post, per company.
 *
 * Notes are grouped by COMPANY because the accrual lands in that company's `1150-<id>` account —
 * which is what lets it convert into that company's cost basis later. A company with two notes
 * accrues the sum of both.
 */
export function noteAccruals(
  notes: Note[],
  accruedByCompany: Map<string, number>,
  asOf: string
): NoteAccrual[] {
  const targetByCompany = new Map<string, { name: string; target: number }>()

  for (const n of notes) {
    const earned = accruedInterest(n, asOf)
    const cur = targetByCompany.get(n.companyId) ?? { name: n.companyName, target: 0 }
    cur.target = roundCents(cur.target + earned)
    targetByCompany.set(n.companyId, cur)
  }

  const out: NoteAccrual[] = []
  for (const [companyId, { name, target }] of Array.from(targetByCompany.entries())) {
    const alreadyAccrued = roundCents(accruedByCompany.get(companyId) ?? 0)
    const delta = roundCents(target - alreadyAccrued)
    if (delta === 0) continue
    out.push({ companyId, companyName: name, target, alreadyAccrued, delta })
  }
  return out
}

/**
 * The columns loadNotes reads. The company embed names its foreign key because
 * investment_transactions has two to companies (company_id, and transfer_company_id for cost
 * transfers). A bare `companies(...)` embed is then ambiguous, and PostgREST refuses the whole
 * query. @internal Exported for tests.
 */
export const NOTE_COLUMNS =
  'id, company_id, transaction_type, transaction_date, investment_cost, interest_rate, maturity_date, interest_converted, ' +
  'companies!investment_transactions_company_id_fkey!inner(name)'

/**
 * The vehicle's interest-bearing notes, as at `asOf`.
 *
 * ONLY `interest_rate`. `dividend_rate` is deliberately never read here: cumulative dividends on
 * preferred equity accrue to the LIQUIDATION PREFERENCE, not to income. They are not earned until
 * declared, and their economic effect reaches the statements through the fair-value mark. Booking
 * them as interest would overstate income and double-count against that mark.
 *
 * A note stops accruing when it CONVERTS. We detect conversion from the tracker: an
 * `interest_converted` amount recorded against the same company is the round that took the note
 * out. (The converted interest then lives in the equity's cost basis, which is where it belongs.)
 */
export async function loadNotes(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  asOf: string
): Promise<Note[]> {
  const { data, error } = await admin
    .from('investment_transactions' as any)
    .select(NOTE_COLUMNS)
    .eq('fund_id', fundId)
    .eq('portfolio_group', group)
    .lte('transaction_date', asOf)

  // Throw rather than read an error as "no notes": a failed read here silently stops every
  // note's interest accruing, and the close still succeeds.
  if (error) throw new Error(`Couldn't load notes for ${group}: ${error.message}`)

  const rows = (data as any[]) ?? []

  // A company whose notes have converted: the round records the interest that came across.
  const convertedOn = new Map<string, string>()
  for (const r of rows) {
    if (Number(r.interest_converted ?? 0) > 0 && r.transaction_date) {
      const prev = convertedOn.get(r.company_id)
      if (!prev || r.transaction_date < prev) convertedOn.set(r.company_id, r.transaction_date)
    }
  }

  return rows
    .filter(r =>
      r.transaction_type === 'investment' &&
      r.interest_rate != null &&
      Number(r.interest_rate) > 0 &&
      Number(r.investment_cost ?? 0) > 0 &&
      r.transaction_date
    )
    .map(r => ({
      txnId: r.id as string,
      companyId: r.company_id as string,
      companyName: (r.companies?.name as string) ?? 'Investment',
      principal: roundCents(Number(r.investment_cost)),
      rate: Number(r.interest_rate),
      startDate: r.transaction_date as string,
      maturityDate: (r.maturity_date as string) ?? null,
      convertedDate: convertedOn.get(r.company_id) ?? null,
    }))
}
