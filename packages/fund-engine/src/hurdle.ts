// The preferred return (hurdle): how much LPs are owed on their capital as at a date.
//
// Two bases, because LPAs say two different things:
//   'contributed' — the hurdle accrues on every contribution from the day it was wired, and capital
//                   coming back does not stop it. Simple, and the engine's original reading.
//   'unreturned'  — the hurdle accrues only on capital not yet returned, and (when it compounds) on
//                   preferred return accrued but not yet paid. The more common LPA wording: "8% per
//                   annum, compounded annually, on unreturned capital contributions".
//
// Under 'unreturned' the base shrinks as the waterfall returns capital and pays the pref, so the
// accrual depends on the distribution history; the caller passes what each prior distribution
// returned and paid (the replay in replay.ts works that out from the waterfall itself).

import { roundCents } from './ledger.ts'

/** What a contribution paid for. Untagged contributions count as capital under any terms. */
export type ContributionPurpose = 'investments' | 'fees' | 'expenses' | 'other'

/** A dated contribution, for accruing the preferred return. */
export interface DatedContribution {
  date: string
  amount: number
  /** What it paid for, when the terms leave some purposes out of capital (`capitalIncludes`). */
  purpose?: ContributionPurpose
}

/** A dated contribution tagged with the LP who made it, for a waterfall run per LP. */
export type LpDatedContribution = DatedContribution & { lpEntityId: string }

/**
 * The contributions that count as capital: to be returned, and to accrue the pref on. An LPA that
 * returns only invested capital before carry leaves fees and expenses out (`capitalIncludes`
 * ['investments']); absent, every contribution counts.
 */
export function capitalContributions(contributions: DatedContribution[], includes?: ContributionPurpose[] | null): DatedContribution[] {
  if (!includes) return contributions
  return contributions.filter(c => c.purpose === undefined || includes.includes(c.purpose))
}

/** What one distribution returned and paid, which shrinks an 'unreturned' hurdle base. */
export interface HurdleReduction {
  date: string
  /** Capital returned (the return-of-capital tier). */
  capital: number
  /** Preferred return paid (the preferred tier). */
  preferred: number
}

export type PrefBase = 'contributed' | 'unreturned'

/** How years are counted between two dates. */
export type DayCount = 'act/365' | '30/360'

// ACTUAL/365, the usual convention in an LPA. Using 365.25 would make "one year" 0.9993 of a year
// and quietly understate the hurdle — small, but it compounds, and it is the kind of difference an
// LP's accountant will find. Some LPAs say 30/360 instead, the US bond basis: every month is 30
// days, a 31st counts as the 30th, and a 31st at the end counts as the 30th only when the start
// was a 30th or 31st.
const DAY_MS = 24 * 60 * 60 * 1000

/** Years from `from` to `to` (YYYY-MM-DD) under a day count. */
export function yearFraction(from: string, to: string, dayCount: DayCount = 'act/365'): number {
  if (dayCount === '30/360') {
    const [y1, m1, d1raw] = from.slice(0, 10).split('-').map(Number)
    const [y2, m2, d2raw] = to.slice(0, 10).split('-').map(Number)
    const d1 = d1raw === 31 ? 30 : d1raw
    const d2 = d2raw === 31 && d1 >= 30 ? 30 : d2raw
    return (360 * (y2 - y1) + 30 * (m2 - m1) + (d2 - d1)) / 360
  }
  return (Date.parse(to) - Date.parse(from)) / (365 * DAY_MS)
}

/**
 * The cumulative preferred return accrued as at `asOf`.
 *
 * With no `reductions` this is the 'contributed' basis: each contribution accrues from the day it
 * was made — money committed on paper earns nothing; money actually WIRED does.
 *
 * With `reductions` it is the 'unreturned' basis: capital returned stops accruing from the day it
 * comes back, and (compounding) preferred paid stops compounding. The result is still CUMULATIVE —
 * everything accrued to date, paid or not — because the waterfall compares it with the cumulative
 * preferred paid.
 */
export function preferredTarget(
  contributions: DatedContribution[],
  asOf: string,
  rate: number,
  compounds: boolean,
  reductions?: HurdleReduction[],
  dayCount: DayCount = 'act/365',
): number {
  if (rate <= 0) return 0

  const end = Date.parse(asOf)
  if (Number.isNaN(end)) return 0

  if (!reductions || reductions.length === 0) {
    let total = 0
    for (const c of contributions) {
      const start = Date.parse(c.date)
      if (Number.isNaN(start) || start >= end || c.amount <= 0) continue
      const years = yearFraction(c.date, asOf, dayCount)
      total += compounds
        ? c.amount * (Math.pow(1 + rate, years) - 1)
        : c.amount * rate * years
    }
    return roundCents(total)
  }

  // The balance method: walk the dated events, accruing between them on what is outstanding.
  // On one date, contributions land before reductions, so a same-day call and return net out.
  type Event = { t: number; date: string; order: number; capital: number; preferred: number }
  const events: Event[] = []
  for (const c of contributions) {
    const t = Date.parse(c.date)
    if (Number.isNaN(t) || t >= end || c.amount <= 0) continue
    events.push({ t, date: c.date, order: 0, capital: c.amount, preferred: 0 })
  }
  for (const d of reductions) {
    const t = Date.parse(d.date)
    if (Number.isNaN(t) || t >= end) continue
    events.push({ t, date: d.date, order: 1, capital: -Math.max(0, d.capital), preferred: Math.max(0, d.preferred) })
  }
  events.sort((a, b) => a.t - b.t || a.order - b.order)

  let capital = 0 // unreturned capital
  let unpaid = 0 // preferred accrued and not yet paid
  let accrued = 0 // cumulative preferred accrued
  let at = events.length > 0 ? events[0].t : end
  let atDate = events.length > 0 ? events[0].date : asOf
  const accrueTo = (t: number, date: string) => {
    if (t <= at) return
    const years = yearFraction(atDate, date, dayCount)
    const growth = compounds
      ? (capital + unpaid) * (Math.pow(1 + rate, years) - 1)
      : capital * rate * years
    accrued += growth
    unpaid += growth
    at = t
    atDate = date
  }
  for (const e of events) {
    accrueTo(e.t, e.date)
    capital = Math.max(0, capital + e.capital)
    unpaid = Math.max(0, unpaid - e.preferred)
  }
  accrueTo(end, asOf)
  return roundCents(accrued)
}

/** The hurdle terms: a rate (`preferredTarget`), or a flat multiple of the capital owed back. */
export interface HurdleTerms {
  prefRate: number
  prefCompounds: boolean
  /**
   * A hurdle set as a multiple instead of a rate: the LPs get `prefMultiple` × their capital back
   * through return of capital and the preferred tier, whenever it comes. 1.08 is an 8% hurdle that
   * doesn't accrue. Absent or null means the rate.
   */
  prefMultiple?: number | null
  /** How the rate's years are counted. Absent means ACT/365. */
  prefDayCount?: DayCount
}

/**
 * The cumulative preferred owed as at `asOf`, on `capital` (dated, for a rate) of which `owed` is
 * the total the return-of-capital tier owes.
 */
export function hurdleTarget(
  terms: HurdleTerms,
  capital: DatedContribution[],
  owed: number,
  asOf: string,
  reductions?: HurdleReduction[],
): number {
  if (terms.prefMultiple != null && terms.prefMultiple > 0) return roundCents(Math.max(0, terms.prefMultiple - 1) * Math.max(0, owed))
  return preferredTarget(capital, asOf, terms.prefRate, terms.prefCompounds, reductions, terms.prefDayCount ?? 'act/365')
}

