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
  /**
   * The interest the conversion round recorded as converting (`interest_converted`) for this note,
   * or for the company when the conversion isn't linked to a note. The conversion entry moves exactly this out of 1150 into the equity's
   * cost, so it is both part of what the ledger accrued and the final figure for the interest a
   * converted note earned.
   */
  convertedInterest?: number
  /**
   * Which conversion `convertedInterest` belongs to. Notes that share a key share one converted
   * figure, so it is counted once. A conversion linked to its note (`converts_from_txn_id`) keys
   * on that note alone; an unlinked one keys on the company. Defaults to the company.
   */
  conversionKey?: string
  /**
   * Principal of this note the fund has exited (sold, repaid or written off) by the as-of date,
   * read from `proceeds` rows' `cost_basis_exited` against the note's round. The exited part earns
   * nothing: its interest is reversed, and anything actually collected is in the exit's proceeds.
   */
  exitedPrincipal?: number
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

/**
 * The share of a note's principal still held. A note written off or repaid in full earns nothing,
 * and its accrued interest comes back out of income: a written-off note's interest will never be
 * paid, and a repaid note's interest arrives inside the exit's proceeds, which already count it as
 * gain. A partial exit keeps interest on the part still held.
 */
function remainingFraction(n: Note): number {
  const exited = n.exitedPrincipal ?? 0
  if (exited <= 0 || n.principal <= 0) return 1
  return Math.max(0, 1 - exited / n.principal)
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
  const targetByCompany = new Map<string, { name: string; target: number; converted: number; keys: Set<string> }>()

  for (const n of notes) {
    const cur = targetByCompany.get(n.companyId) ?? { name: n.companyName, target: 0, converted: 0, keys: new Set<string>() }
    const converted = roundCents(n.convertedInterest ?? 0)
    const linked = (n.conversionKey ?? '').startsWith('note:')
    const hasConverted = !!n.convertedDate && n.convertedDate <= asOf && (converted > 0 || linked)
    if (hasConverted) {
      // A converted note's interest is what the conversion recorded, not our own estimate: the
      // company's figure is what actually became shares. Count each conversion once.
      const key = n.conversionKey ?? n.companyId
      if (!cur.keys.has(key)) {
        cur.keys.add(key)
        cur.converted = roundCents(cur.converted + converted)
      }
    } else {
      cur.target = roundCents(cur.target + accruedInterest(n, asOf) * remainingFraction(n))
    }
    targetByCompany.set(n.companyId, cur)
  }

  const out: NoteAccrual[] = []
  for (const [companyId, entry] of Array.from(targetByCompany.entries())) {
    const { name } = entry
    const target = roundCents(entry.target + entry.converted)
    // The conversion entry already moved the converted interest out of 1150 into cost, so the
    // 1150 balance alone understates what was accrued by exactly that amount.
    const alreadyAccrued = roundCents((accruedByCompany.get(companyId) ?? 0) + entry.converted)
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
  'id, company_id, transaction_type, transaction_date, investment_cost, interest_rate, maturity_date, interest_converted, converts_from_txn_id, round_name, cost_basis_exited, ' +
  'companies!investment_transactions_company_id_fkey!inner(name)'

/**
 * The vehicle's interest-bearing notes, as at `asOf`.
 *
 * ONLY `interest_rate`. `dividend_rate` is deliberately never read here: cumulative dividends on
 * preferred equity accrue to the LIQUIDATION PREFERENCE, not to income. They are not earned until
 * declared, and their economic effect reaches the statements through the fair-value mark. Booking
 * them as interest would overstate income and double-count against that mark.
 *
 * A note stops accruing when it CONVERTS. We detect conversion from the tracker: the round that
 * records `interest_converted` and names the note in `converts_from_txn_id` took that note out.
 * (The converted interest then lives in the equity's cost basis, which is where it belongs.)
 * See notesFromRows for how unlinked conversions are read.
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

  return notesFromRows((data as any[]) ?? [])
}

/**
 * Turn transaction rows into notes, each knowing whether and when it converted.
 *
 * A conversion row names the note it converted (`converts_from_txn_id`), and only that note stops
 * accruing. A company can issue a new note after an earlier one converts, and the new note earns
 * interest from its own issue date.
 *
 * Older conversion rows may carry `interest_converted` without the link. Those are read at the
 * company level, as before, but only against notes issued on or before the conversion: a note
 * issued afterwards can't have been part of it.
 *
 * A note exited through a `proceeds` row against its round (sold, repaid or written off) stops
 * earning on the principal exited, and the interest accrued on that part is reversed.
 *
 * @internal Exported for tests.
 */
export function notesFromRows(rows: any[]): Note[] {
  const byNote = new Map<string, { date: string; interest: number }>()
  const byCompany = new Map<string, { date: string; interest: number }>()
  for (const r of rows) {
    if (!r.transaction_date) continue
    // A conversion linked to its note stops that note even when no interest came across (the
    // holder gave it up): its interest target is then zero. An unlinked row only reads as a
    // conversion when it records interest.
    if (!r.converts_from_txn_id && !(Number(r.interest_converted ?? 0) > 0)) continue
    if (r.converts_from_txn_id && r.transaction_type !== 'investment') continue
    const target = r.converts_from_txn_id ? byNote : byCompany
    const key = (r.converts_from_txn_id ?? r.company_id) as string
    const prev = target.get(key)
    target.set(key, {
      date: !prev || r.transaction_date < prev.date ? r.transaction_date : prev.date,
      interest: roundCents((prev?.interest ?? 0) + Number(r.interest_converted ?? 0)),
    })
  }

  // Principal exited per company and round. A proceeds row names the round it sold, not the
  // transaction, so exits are matched to notes by round and applied oldest note first.
  const roundKey = (r: any) => `${r.company_id}|${String(r.round_name ?? '').trim().toLowerCase()}`
  const exitedByRound = new Map<string, number>()
  for (const r of rows) {
    if (r.transaction_type !== 'proceeds' || !(Number(r.cost_basis_exited ?? 0) > 0)) continue
    exitedByRound.set(roundKey(r), roundCents((exitedByRound.get(roundKey(r)) ?? 0) + Number(r.cost_basis_exited)))
  }

  const notes = rows
    .filter(r =>
      r.transaction_type === 'investment' &&
      r.interest_rate != null &&
      Number(r.interest_rate) > 0 &&
      Number(r.investment_cost ?? 0) > 0 &&
      r.transaction_date
    )
    .map(r => {
      const linked = byNote.get(r.id)
      const legacy = byCompany.get(r.company_id)
      const conv = linked ?? (legacy && r.transaction_date <= legacy.date ? legacy : undefined)
      return {
        txnId: r.id as string,
        companyId: r.company_id as string,
        companyName: (r.companies?.name as string) ?? 'Investment',
        principal: roundCents(Number(r.investment_cost)),
        rate: Number(r.interest_rate),
        startDate: r.transaction_date as string,
        maturityDate: (r.maturity_date as string) ?? null,
        convertedDate: conv?.date ?? null,
        convertedInterest: conv?.interest ?? 0,
        conversionKey: linked ? `note:${r.id}` : `company:${r.company_id}`,
        exitedPrincipal: 0,
        roundKey: roundKey(r),
      }
    })
    .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0))

  for (const n of notes) {
    const left = exitedByRound.get(n.roundKey) ?? 0
    if (left <= 0) continue
    const take = Math.min(left, n.principal)
    n.exitedPrincipal = roundCents(take)
    exitedByRound.set(n.roundKey, roundCents(left - take))
  }

  return notes.map(({ roundKey: _k, ...n }) => n)
}
