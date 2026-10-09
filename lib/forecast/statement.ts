// Monthly P&L and cash over a posting stream.
//
// The caller decides what the stream is — posted actuals through the cutoff followed by forecast
// postings after it, or actuals up to a budget's start followed by the budget. This module only
// buckets: income and expense by month on their normal side, and cash as a running balance
// across every cash-subtype account (operating AND reserve — matching on code 1000 alone would
// drop a management company's 1050).

import type { Account, Posting } from '@/lib/accounting/types'
import { roundCents } from '@/lib/accounting/ledger'
import { firstDay, monthOf, type MonthKey } from './months'

/** 'none' = the range runs past what the view has: a month with no actuals yet, or outside the plan. */
export type MonthStatus = 'actual' | 'actual_unclosed' | 'forecast' | 'none'

export interface StatementMonth {
  month: MonthKey
  status: MonthStatus
}

export interface StatementLine {
  accountId: string
  code: string
  name: string
  type: 'income' | 'expense'
  /** Natural-side amount by month: revenue and expense both positive. */
  byMonth: Record<MonthKey, number>
}

export interface CashMonth {
  opening: number
  movement: number
  ending: number
}

export interface MonthlyStatement {
  months: StatementMonth[]
  lines: StatementLine[]
  revenue: Record<MonthKey, number>
  expenses: Record<MonthKey, number>
  netIncome: Record<MonthKey, number>
  cash: Record<MonthKey, CashMonth>
  cashAccountIds: string[]
}

export interface StatementInput {
  accounts: Account[]
  /** Every posting must carry entryDate. */
  postings: Posting[]
  months: MonthKey[]
  /** Last month whose figures are actuals; later months are forecast. Null = all forecast. */
  actualsThrough: MonthKey | null
  /** Last closed month, for flagging actual-but-open months. */
  closedThrough: MonthKey | null
}

export function monthStatus(m: MonthKey, actualsThrough: MonthKey | null, closedThrough: MonthKey | null): MonthStatus {
  if (actualsThrough == null || m > actualsThrough) return 'forecast'
  return closedThrough != null && m <= closedThrough ? 'actual' : 'actual_unclosed'
}

export function monthlyStatement(input: StatementInput): MonthlyStatement {
  const { accounts, postings, months } = input
  const byId = new Map(accounts.map(a => [a.id, a]))
  const inRange = new Set(months)
  const cashIds = accounts.filter(a => a.subtype === 'cash').map(a => a.id)
  const cashSet = new Set(cashIds)

  const lines = new Map<string, StatementLine>()
  const zero = () => Object.fromEntries(months.map(m => [m, 0])) as Record<MonthKey, number>
  const revenue = zero()
  const expenses = zero()
  const movement = zero()
  let opening = 0
  const start = months.length ? firstDay(months[0]) : null

  for (const p of postings) {
    if (!p.entryDate) throw new Error('monthlyStatement needs dated postings')
    const m = monthOf(p.entryDate)
    if (cashSet.has(p.accountId)) {
      if (start && p.entryDate < start) opening += p.amount
      else if (inRange.has(m)) movement[m] += p.amount
    }
    if (!inRange.has(m)) continue
    const acct = byId.get(p.accountId)
    if (!acct || (acct.type !== 'income' && acct.type !== 'expense')) continue
    // Income is credit-normal: a credit (negative) posting is positive revenue.
    const natural = acct.type === 'income' ? -p.amount : p.amount
    let line = lines.get(acct.id)
    if (!line) {
      line = { accountId: acct.id, code: acct.code, name: acct.name, type: acct.type, byMonth: zero() }
      lines.set(acct.id, line)
    }
    line.byMonth[m] += natural
    if (acct.type === 'income') revenue[m] += natural
    else expenses[m] += natural
  }

  const netIncome = zero()
  const cash: Record<MonthKey, CashMonth> = {}
  let running = roundCents(opening)
  for (const m of months) {
    revenue[m] = roundCents(revenue[m])
    expenses[m] = roundCents(expenses[m])
    netIncome[m] = roundCents(revenue[m] - expenses[m])
    const mv = roundCents(movement[m])
    const ending = roundCents(running + mv)
    cash[m] = { opening: running, movement: mv, ending }
    running = ending
  }
  for (const line of lines.values()) for (const m of months) line.byMonth[m] = roundCents(line.byMonth[m])

  return {
    months: months.map(m => ({ month: m, status: monthStatus(m, input.actualsThrough, input.closedThrough) })),
    lines: [...lines.values()].sort((a, b) => a.code.localeCompare(b.code)),
    revenue,
    expenses,
    netIncome,
    cash,
    cashAccountIds: cashIds,
  }
}
