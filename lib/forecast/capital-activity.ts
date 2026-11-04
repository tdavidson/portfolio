// Capital planning's figures over a date range: what was called, distributed, invested and spent on
// fees and expenses, split into what the books record (Actual) and what the plan still expects
// (Forecast).
//
// THE ACTUAL SIDE READS THE SAME RECORDS AS THE REST OF THE APP. Capital called and distributed are
// partners' capital by source type (the capital-account roll-forward's buckets), invested capital is
// the investment transactions' cost (the Investments tab and the schedule of investments), and fees
// and expenses are the expense accounts (the income statement). Nothing is inferred from which
// account a cash leg happened to touch: that is the cash-flow statement's job, and inferring calls
// and fees from cash is how a call booked through Due from LPs or a fee accrued before it was paid
// went missing from this table.
//
// THE SPLIT IS BY MONTH. A month the report shows as actual (closed or not) counts entirely from the
// books; a forecast month counts entirely from the plan. A year that is half actual is split where
// its months are, never counted whole as one or the other.

import type { Account, Posting } from '@/lib/accounting/types'
import { roundCents } from '@/lib/accounting/ledger'
import { bucketForSourceType, type CapitalPosting } from '@/lib/accounting/capital-account'
import type { MonthKey } from './months'
import type { MonthStatus } from './statement'
import type { FlowEntry } from './report'

export type Split = { actual: number; forecast: number }

export interface CapitalActivity {
  called: Split
  distributed: Split
  invested: Split
  fees: Split
  org: Split
  partnership: Split
}

export interface CapitalActivityInput {
  /** The report's months and their status; nothing outside them is counted. */
  months: { month: MonthKey; status: MonthStatus }[]
  accounts: Account[]
  /** Postings to partners' capital, dated, with their entry's source type. */
  capitalPostings: CapitalPosting[]
  /** Posted actuals, dated (the expense accounts are read from these). */
  postings: Posting[]
  /** Each investment's cost, dated (lib/accounting/investment-costs.ts). */
  investments: { date: string | null; cost: number }[]
  /** The plan's entries; only those in forecast months are counted. */
  planEntries: FlowEntry[]
}

const PLAN_KIND: Record<string, 'called' | 'distributed' | 'invested'> = {
  capital_call: 'called',
  distribution: 'distributed',
  carry_distribution: 'distributed',
  investment: 'invested',
}

function expenseLine(a: Account | undefined): 'fees' | 'org' | 'partnership' | null {
  if (!a || a.type !== 'expense') return null
  if (a.subtype === 'management_fee') return 'fees'
  if (a.subtype === 'organizational_expense') return 'org'
  return 'partnership'
}

export function capitalActivity(input: CapitalActivityInput): CapitalActivity {
  const status = new Map(input.months.map(m => [m.month, m.status]))
  const side = (date: string | null | undefined): keyof Split | null => {
    if (!date) return null
    const s = status.get(date.slice(0, 7))
    if (s === 'actual' || s === 'actual_unclosed') return 'actual'
    if (s === 'forecast') return 'forecast'
    return null
  }
  const zero = (): Split => ({ actual: 0, forecast: 0 })
  const out: CapitalActivity = { called: zero(), distributed: zero(), invested: zero(), fees: zero(), org: zero(), partnership: zero() }
  const byId = new Map(input.accounts.map(a => [a.id, a]))

  // Partners' capital. A posting's amount is debit-positive: a contribution credits capital, a
  // distribution debits it. Reversals carry the opposite sign and net out on their own.
  for (const p of input.capitalPostings) {
    if (side(p.entryDate) !== 'actual') continue
    const bucket = bucketForSourceType(p.sourceType, p.amount)
    if (bucket === 'contributions') out.called.actual += -p.amount
    else if (bucket === 'distributions' || p.sourceType === 'carry_distribution') out.distributed.actual += p.amount
  }

  for (const t of input.investments) {
    if (side(t.date) === 'actual') out.invested.actual += t.cost
  }

  for (const p of input.postings) {
    if (side(p.entryDate) !== 'actual') continue
    const line = expenseLine(byId.get(p.accountId))
    if (line) out[line].actual += p.amount
  }

  // The plan: its calls, distributions and investments as the cash it expects them to move, and its
  // fees and expenses on their expense accounts — the same accounts the actual side reads.
  const cashIds = new Set(input.accounts.filter(a => a.subtype === 'cash' && !a.lpEntityId && !a.companyId).map(a => a.id))
  for (const e of input.planEntries) {
    if (side(e.date) !== 'forecast') continue
    const kind = e.kind ? PLAN_KIND[e.kind] : undefined
    if (kind) {
      const cash = e.postings.filter(p => cashIds.has(p.accountId)).reduce((s, p) => s + p.amount, 0)
      out[kind].forecast += kind === 'called' ? cash : -cash
    }
    for (const p of e.postings) {
      const line = expenseLine(byId.get(p.accountId))
      if (line) out[line].forecast += p.amount
    }
  }

  for (const k of Object.keys(out) as (keyof CapitalActivity)[]) {
    out[k] = { actual: roundCents(out[k].actual), forecast: roundCents(out[k].forecast) }
  }
  return out
}
