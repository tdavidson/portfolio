// Rule amounts → balanced forecast entries.
//
// A forecast is stored the way the books are: dated entries whose postings sum to zero. That is
// what lets P&L and cash diverge honestly. An annual insurance bill paid in September and
// recognised monthly is a prepayment (Dr prepaid / Cr cash) in September and twelve releases
// (Dr insurance / Cr prepaid) — the P&L sees $800 a month, cash sees $9,600 once, and the
// balance sheet in between holds the difference, as it would in the real ledger.
//
// These entries live in forecast_entries / forecast_postings and nowhere else. Nothing in this
// module can reach journal_*.

import type { Account, Posting } from '@/lib/accounting/types'
import { NORMAL_SIDE } from '@/lib/accounting/types'
import { roundCents } from '@/lib/accounting/ledger'
import { MANCO_KIND } from '@/lib/vehicle-kinds'
import { addMonths, lastDay, parseMonth, type MonthKey } from './months'

export type CashTiming =
  | { mode: 'same' }
  /** Paid/received N months after recognition (negative = before). */
  | { mode: 'offset'; months: number }
  /**
   * Already paid (or received) before the plan — a prepaid fee being expensed month by month, a
   * retainer collected up front. Each month draws down the prepaid (or deferred revenue) balance
   * and no cash moves in the plan.
   */
  | { mode: 'prepaid' }
  /**
   * Paid/received in one calendar month. 'advance' settles each recognised month in the most
   * recent payment month at or before it (an annual premium); 'arrears' in the next one at or after.
   */
  | { mode: 'month'; month: number; direction: 'advance' | 'arrears' }
  /**
   * A billing cycle: every `everyMonths` months starting in calendar month `anchor`. 'advance'
   * settles each month at the start of its cycle (a quarterly fee billed in advance), 'arrears' at
   * the end; `lagMonths` delays either (the call that pays the fee clears a month later).
   */
  | { mode: 'cycle'; everyMonths: number; anchor: number; direction: 'advance' | 'arrears'; lagMonths: number }

export const SAME_MONTH: CashTiming = { mode: 'same' }

export class CashTimingError extends Error {}

export function validateCashTiming(raw: unknown): CashTiming {
  if (raw == null) return SAME_MONTH
  if (typeof raw !== 'object') throw new CashTimingError('cashTiming must be an object')
  const t = raw as Record<string, unknown>
  switch (t.mode) {
    case 'same':
      return SAME_MONTH
    case 'prepaid':
      return { mode: 'prepaid' }
    case 'offset': {
      const n = t.months
      if (typeof n !== 'number' || !Number.isInteger(n) || Math.abs(n) > 36) {
        throw new CashTimingError('cashTiming.months must be a whole number from -36 to 36')
      }
      return n === 0 ? SAME_MONTH : { mode: 'offset', months: n }
    }
    case 'month': {
      const m = t.month
      if (typeof m !== 'number' || !Number.isInteger(m) || m < 1 || m > 12) {
        throw new CashTimingError('cashTiming.month must be 1–12')
      }
      if (t.direction !== 'advance' && t.direction !== 'arrears') {
        throw new CashTimingError("cashTiming.direction must be 'advance' or 'arrears'")
      }
      return { mode: 'month', month: m, direction: t.direction }
    }
    case 'cycle': {
      const every = t.everyMonths
      if (every !== 1 && every !== 3 && every !== 6 && every !== 12) throw new CashTimingError('cashTiming.everyMonths must be 1, 3, 6 or 12')
      const anchor = t.anchor ?? 1
      if (typeof anchor !== 'number' || !Number.isInteger(anchor) || anchor < 1 || anchor > 12) throw new CashTimingError('cashTiming.anchor must be 1–12')
      if (t.direction !== 'advance' && t.direction !== 'arrears') throw new CashTimingError("cashTiming.direction must be 'advance' or 'arrears'")
      const lag = t.lagMonths ?? 0
      if (typeof lag !== 'number' || !Number.isInteger(lag) || lag < 0 || lag > 12) throw new CashTimingError('cashTiming.lagMonths must be 0–12')
      return { mode: 'cycle', everyMonths: every, anchor, direction: t.direction, lagMonths: lag }
    }
    default:
      throw new CashTimingError("cashTiming.mode must be 'same', 'offset', 'month', 'cycle' or 'prepaid'")
  }
}

/** The month cash moves for an amount recognised in `m`. */
export function cashMonth(m: MonthKey, timing: CashTiming): MonthKey {
  switch (timing.mode) {
    case 'same':
    case 'prepaid':
      // Prepaid has no cash month: compileForecast draws down the balance instead.
      return m
    case 'offset':
      return addMonths(m, timing.months)
    case 'month': {
      const { month } = parseMonth(m)
      if (timing.direction === 'advance') return addMonths(m, -((month - timing.month + 12) % 12))
      return addMonths(m, (timing.month - month + 12) % 12)
    }
    case 'cycle': {
      const { month } = parseMonth(m)
      const into = (((month - timing.anchor) % timing.everyMonths) + timing.everyMonths) % timing.everyMonths
      const start = addMonths(m, -into)
      const at = timing.direction === 'advance' ? start : addMonths(start, timing.everyMonths - 1)
      return addMonths(at, timing.lagMonths)
    }
  }
}

export interface CounterAccounts {
  cash: string
  /** Expense paid later. */
  accrued?: string
  /** Expense paid earlier. */
  prepaid?: string
  /** Revenue received later. */
  receivable?: string
  /** Revenue received earlier. */
  deferred?: string
}

/**
 * The balance-sheet accounts a vehicle's forecast settles through, found by subtype. A fund's
 * only 'receivable' is 1300 Due from LPs, which is capital, not revenue — so receivables are
 * taken only from a management company's chart; anything else falls back to same-month cash.
 */
export function counterAccountsFor(kind: string, accounts: Account[]): CounterAccounts | null {
  const bySubtype = (...subtypes: string[]) => {
    for (const st of subtypes) {
      const hit = accounts
        .filter(a => a.subtype === st && !a.lpEntityId && !a.companyId)
        .sort((a, b) => a.code.localeCompare(b.code))[0]
      if (hit) return hit.id
    }
    return undefined
  }
  const cash = bySubtype('cash')
  if (!cash) return null
  return {
    cash,
    accrued: bySubtype('accrued', 'accounts_payable'),
    // A fund's only prepaid account is 1500 Prepaid management fees, which is exactly what a fee
    // billed in advance creates; a manco's is its general 1300 Prepaid expenses.
    prepaid: bySubtype('prepaid', 'prepaid_management_fee'),
    receivable: kind === MANCO_KIND ? bySubtype('receivable') : undefined,
    deferred: bySubtype('deferred_revenue'),
  }
}

export type EntryKind =
  | 'recognition' | 'settlement' | 'prepayment' | 'release'
  // Construction's non-P&L flows (lib/forecast/construction-adapter.ts).
  | 'investment' | 'proceeds' | 'capital_call' | 'distribution'

export interface CompiledEntry {
  entryDate: string
  kind: EntryKind
  memo: string
  /** The P&L account the entry exists for. */
  accountId: string
  ruleId: string | null
  overrideId: string | null
  /** 'opening' = settling a balance that already existed in the actuals when the plan starts. */
  /** 'manual' = entered by hand on the plan (lib/forecast/adjustments.ts). */
  source: 'rule' | 'override' | 'opening' | 'construction' | 'manual'
  /** A hand-entered entry's id ('manual|<id>'), for editing it; not stored. */
  key?: string
  postings: Posting[]
}

export interface CompileLine {
  account: Account
  ruleId: string | null
  /** Natural-side amount per month, with the override that set it, if any. */
  amounts: Map<MonthKey, { amount: number; overrideId?: string | null }>
  timing: CashTiming
}

export interface CompileOptions {
  /** First and last month entries may be dated in. */
  firstMonth: MonthKey
  lastMonth: MonthKey
  currency: string
  counters: CounterAccounts
}

export interface CompileResult {
  entries: CompiledEntry[]
  /** Per P&L account. */
  warnings: Map<string, string[]>
}

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })

export function compileForecast(lines: CompileLine[], opts: CompileOptions): CompileResult {
  const entries: CompiledEntry[] = []
  const warnings = new Map<string, string[]>()
  const warn = (accountId: string, msg: string) => {
    const list = warnings.get(accountId) ?? []
    if (!list.includes(msg)) list.push(msg)
    warnings.set(accountId, list)
  }
  const inRange = (m: MonthKey) => m >= opts.firstMonth && m <= opts.lastMonth
  const { counters, currency } = opts

  for (const line of lines) {
    const { account } = line
    if (account.type !== 'income' && account.type !== 'expense') {
      warn(account.id, 'Only income and expense accounts take rules')
      continue
    }
    const isExpense = account.type === 'expense'
    // Signed amount on the P&L account for a natural-side figure: expense debits, income credits.
    const signed = (a: number) => roundCents(NORMAL_SIDE[account.type] === 'debit' ? a : -a)
    const later = isExpense ? counters.accrued : counters.receivable
    const earlier = isExpense ? counters.prepaid : counters.deferred

    // Settlements roll up per (kind, month) so a quarter of monthly accruals pays in one entry.
    const settle = new Map<string, { kind: EntryKind; month: MonthKey; amount: number; counter: string }>()
    let beyond = 0
    let before = 0

    for (const [month, { amount, overrideId }] of [...line.amounts].sort(([a], [b]) => a.localeCompare(b))) {
      if (!inRange(month) || amount === 0) continue
      const s = signed(amount)
      if (line.timing.mode === 'prepaid') {
        // Paid before the plan: release the prepaid balance; nothing settles in the window.
        if (!earlier) {
          warn(account.id, `No ${isExpense ? 'prepaid' : 'deferred revenue'} account in this chart — cash moves in the month it is recognised`)
        } else {
          entries.push({
            accountId: account.id, ruleId: line.ruleId, overrideId: overrideId ?? null,
            source: (overrideId ? 'override' : 'rule') as 'rule' | 'override',
            entryDate: lastDay(month), kind: 'release',
            memo: `${account.code} ${account.name} — ${month} (${isExpense ? 'prepaid' : 'received in advance'})`,
            postings: [
              { accountId: account.id, amount: s, currency },
              { accountId: earlier, amount: roundCents(-s), currency },
            ],
          })
          continue
        }
      }
      let pay = cashMonth(month, line.timing)
      const counter = pay > month ? later : pay < month ? earlier : counters.cash
      if (!counter) {
        warn(account.id, `No ${pay > month ? (isExpense ? 'accrued expense' : 'receivable') : isExpense ? 'prepaid' : 'deferred revenue'} account in this chart — cash moves in the month it is recognised`)
        pay = month
      }
      const recogCounter = pay === month ? counters.cash : pay > month ? later! : earlier!
      const base = {
        accountId: account.id,
        ruleId: line.ruleId,
        overrideId: overrideId ?? null,
        source: (overrideId ? 'override' : 'rule') as 'rule' | 'override',
      }
      entries.push({
        ...base,
        entryDate: lastDay(month),
        kind: pay < month ? 'release' : 'recognition',
        memo: `${account.code} ${account.name} — ${month}`,
        postings: [
          { accountId: account.id, amount: s, currency },
          { accountId: recogCounter, amount: roundCents(-s), currency },
        ],
      })
      if (pay === month) continue
      if (!inRange(pay)) {
        if (pay > month) beyond = roundCents(beyond + amount)
        else before = roundCents(before + amount)
        continue
      }
      const kind: EntryKind = pay > month ? 'settlement' : 'prepayment'
      const key = `${kind}|${pay}`
      const cur = settle.get(key)
      if (cur) cur.amount = roundCents(cur.amount + s)
      else settle.set(key, { kind, month: pay, amount: s, counter: recogCounter })
    }

    for (const st of settle.values()) {
      if (st.amount === 0) continue
      entries.push({
        entryDate: lastDay(st.month),
        kind: st.kind,
        memo: `${account.code} ${account.name} — ${st.kind === 'settlement' ? (isExpense ? 'paid' : 'received') : isExpense ? 'paid in advance' : 'received in advance'} ${st.month}`,
        accountId: account.id,
        ruleId: line.ruleId,
        overrideId: null,
        source: 'rule',
        // A settlement clears the accrual into cash; a prepayment builds the asset (or deferred
        // revenue) out of cash. Either way the counter takes the P&L side's sign, cash the other.
        postings: [
          { accountId: st.counter, amount: st.amount, currency },
          { accountId: counters.cash, amount: roundCents(-st.amount), currency },
        ],
      })
    }
    if (beyond) warn(account.id, `${fmt(beyond)} recognised in the plan is ${isExpense ? 'paid' : 'received'} after its last month and stays on the balance sheet`)
    if (before) warn(account.id, `${fmt(before)} recognised in the plan was ${isExpense ? 'paid' : 'received'} before its first month; only the release is forecast`)
  }

  entries.sort((a, b) => a.entryDate.localeCompare(b.entryDate) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.memo.localeCompare(b.memo))
  for (const e of entries) assertEntryBalanced(e)
  return { entries, warnings }
}

const KIND_ORDER: Record<EntryKind, number> = {
  capital_call: 0, prepayment: 1, recognition: 2, release: 3, settlement: 4, investment: 5, proceeds: 6, distribution: 7,
}

export function assertEntryBalanced(e: { memo: string; postings: Posting[] }) {
  const byCurrency = new Map<string, number>()
  for (const p of e.postings) byCurrency.set(p.currency, roundCents((byCurrency.get(p.currency) ?? 0) + p.amount))
  for (const [c, v] of byCurrency) {
    if (v !== 0) throw new Error(`Forecast entry "${e.memo}" does not balance: ${c} ${v}`)
  }
}
