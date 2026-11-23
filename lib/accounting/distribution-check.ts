// A distribution, checked before it is declared. Pure: no I/O, so every rule here is pinned by
// distribution-check.test.ts. Whoever proposes a distribution (the Capital accounts page, the API,
// an assistant in chat) gets the same answer, computed from the split and the fund's records:
//
//   * The split has to tie: LP lines plus carry lines add to the total, and each line's return of
//     capital, preferred return and profit add to that line.
//   * The terms the split ran on are stated, and a vehicle with no carry terms is said to be split
//     pro-rata by capital, never silently.
//   * The cash on hand covers the distribution, after what earlier distributions still owe.
//   * Whatever the waterfall warned about (carry paid to date disagreeing with the replay, American
//     terms without realized deals, per-LP terms without per-LP contributions) is carried through.
//
// It reads nothing and writes nothing; the loader beside it gathers the facts.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { DraftChecks, DraftFlag, MissingItem } from '@/lib/drafting/checks'
import { roundCents } from './ledger'
import { loadPostedLedger } from './load'
import { lpPayableBalances } from './capital-calls'

export interface DistributionCheckInput {
  total: number
  date: string
  method: 'waterfall' | 'pro_rata' | 'manual'
  lines: { lpEntityId: string; amount: number }[]
  carryLines: { lpEntityId: string; amount: number }[]
  lineBreakdown?: { lpEntityId: string; returnOfCapital: number; preferred: number; profit: number }[]
  /** The carry terms in force: 'none' when the vehicle has none. */
  termsKind: string
  carryRecipients: string[]
  warnings: string[]
  names?: Record<string, string>
}

export interface DistributionFacts {
  /** Cash accounts' balance on the distribution date. Null when the vehicle keeps no ledger cash. */
  cash: number | null
  /** What earlier declared distributions still owe partners (the 2300 payable). */
  unpaidEarlier: number
}

const CENT = 0.005

export function checkDistribution(input: DistributionCheckInput, facts: DistributionFacts): DraftChecks {
  const missing: MissingItem[] = []
  const flags: DraftFlag[] = []
  const name = (id: string) => input.names?.[id] ?? id
  const total = roundCents(input.total)
  const lpTotal = roundCents(input.lines.reduce((s, l) => s + l.amount, 0))
  const carryTotal = roundCents(input.carryLines.reduce((s, l) => s + l.amount, 0))

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    missing.push({ field: 'distribution_date', label: 'Distribution date', required: true, why: 'The declaration posts on this date, and the waterfall replays every earlier distribution up to it.' })
  }
  if (!(total > 0)) {
    flags.push({ code: 'no_total', severity: 'blocker', message: 'The distribution total must be more than zero.' })
  }
  if (Math.abs(roundCents(lpTotal + carryTotal) - total) > CENT && total > 0) {
    flags.push({
      code: 'lines_do_not_tie', severity: 'blocker',
      message: `The partner lines add to ${roundCents(lpTotal + carryTotal).toFixed(2)} (LP ${lpTotal.toFixed(2)}, carry ${carryTotal.toFixed(2)}), not the ${total.toFixed(2)} total.`,
    })
  }
  for (const l of [...input.lines, ...input.carryLines]) {
    if (!(l.amount >= 0) || Math.abs(l.amount * 100 - Math.round(l.amount * 100)) > 1e-6) {
      flags.push({ code: 'bad_amount', severity: 'blocker', subject: l.lpEntityId, message: `${name(l.lpEntityId)}'s amount ${l.amount} is not a nonnegative amount in cents.` })
    }
  }

  const byLp = new Map(input.lines.map(l => [l.lpEntityId, l.amount]))
  for (const b of input.lineBreakdown ?? []) {
    const amount = byLp.get(b.lpEntityId)
    if (amount == null) continue
    if (Math.abs(roundCents(b.returnOfCapital + b.preferred + b.profit) - amount) > CENT) {
      flags.push({
        code: 'breakdown_does_not_tie', severity: 'blocker', subject: b.lpEntityId,
        message: `${name(b.lpEntityId)}'s return of capital, preferred return and profit add to ${roundCents(b.returnOfCapital + b.preferred + b.profit).toFixed(2)}, not their ${amount.toFixed(2)} line.`,
      })
    }
  }

  if (input.termsKind === 'none') {
    missing.push({
      field: 'carry_terms', label: 'Waterfall terms from the LPA', required: false,
      why: 'This vehicle has no carry terms recorded, so the distribution is split pro-rata by capital balance and no carried interest is calculated. Record the LPA terms first if it has a waterfall.',
    })
  } else if (input.method === 'pro_rata') {
    flags.push({ code: 'pro_rata_override', severity: 'warning', message: 'The vehicle has waterfall terms, but this split is pro-rata by capital. No carried interest is calculated. Use this only where the LPA treats the distribution that way.' })
  } else if (input.method === 'manual') {
    flags.push({ code: 'manual_split', severity: 'warning', message: 'The amounts were typed or edited by hand, so they are not the waterfall’s split and no per-partner breakdown is stored. Preview the split again to declare it as calculated.' })
  }
  if (input.termsKind !== 'none' && input.method === 'waterfall' && input.carryRecipients.length === 0) {
    missing.push({ field: 'carry_recipients', label: 'Who receives the carried interest', required: false, why: 'The terms name no carry recipient, so any carried interest has nobody to be paid to.' })
  }

  const both = input.carryLines.filter(c => byLp.has(c.lpEntityId)).map(c => c.lpEntityId)
  for (const id of both) {
    flags.push({
      code: 'gp_capital_and_carry', severity: 'warning', subject: id,
      message: `${name(id)} receives both a distribution on its own capital (${(byLp.get(id) ?? 0).toFixed(2)}) and carried interest (${(input.carryLines.find(c => c.lpEntityId === id)?.amount ?? 0).toFixed(2)}). Its notice shows the two separately.`,
    })
  }

  for (const w of input.warnings) flags.push({ code: 'waterfall_warning', severity: 'warning', message: w })

  if (facts.cash != null && total > 0) {
    const needed = roundCents(total + facts.unpaidEarlier)
    if (facts.cash + CENT < needed) {
      flags.push({
        code: 'cash_short', severity: 'warning', date: input.date,
        message: facts.unpaidEarlier > CENT
          ? `Cash on ${input.date} is ${facts.cash.toFixed(2)}, short of this ${total.toFixed(2)} plus the ${facts.unpaidEarlier.toFixed(2)} earlier distributions still owe.`
          : `Cash on ${input.date} is ${facts.cash.toFixed(2)}, short of this ${total.toFixed(2)} distribution.`,
      })
    }
  }
  if (facts.unpaidEarlier > CENT) {
    flags.push({ code: 'earlier_unpaid', severity: 'warning', message: `Earlier distributions still owe partners ${facts.unpaidEarlier.toFixed(2)}. Pay or settle those first, or make sure the cash covers both.` })
  }

  return { missing, flags }
}

/** The records a check reads: cash on the date and what earlier distributions still owe. */
export async function loadDistributionFacts(admin: SupabaseClient, fundId: string, group: string, date: string): Promise<DistributionFacts> {
  const [ledger, payables] = await Promise.all([
    loadPostedLedger(admin, fundId, group, /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined),
    lpPayableBalances(admin, fundId, group),
  ])
  const cashIds = new Set(ledger.accounts.filter(a => a.subtype === 'cash').map(a => a.id))
  const cash = cashIds.size === 0
    ? null
    : roundCents(ledger.postings.filter(p => cashIds.has(p.accountId) && (!p.entryDate || p.entryDate <= date)).reduce((s, p) => s + p.amount, 0))
  const unpaidEarlier = roundCents(Array.from(payables.values()).reduce((s, v) => s + Math.max(0, v), 0))
  return { cash, unpaidEarlier }
}
