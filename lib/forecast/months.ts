// Month arithmetic for budgets and forecasts.
//
// The month is the only grain anything is stored or calculated at. Quarters and years are
// presentation: `aggregate` rolls months up, and it has to know whether a series is a FLOW
// (P&L activity, cash movement — sums) or a BALANCE (cash on hand — the opening of the first
// month and the ending of the last; summing twelve month-end balances is a meaningless number).

import { roundCents } from '@/lib/accounting/ledger'

/** 'YYYY-MM'. */
export type MonthKey = string

export type Interval = 'month' | 'quarter' | 'year'

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/

export function isMonthKey(s: unknown): s is MonthKey {
  return typeof s === 'string' && MONTH_RE.test(s)
}

export function monthKey(year: number, month1: number): MonthKey {
  return `${year}-${String(month1).padStart(2, '0')}`
}

export function parseMonth(m: MonthKey): { year: number; month: number } {
  const match = MONTH_RE.exec(m)
  if (!match) throw new Error(`Not a month: ${m}`)
  return { year: Number(match[1]), month: Number(match[2]) }
}

/** The month containing an ISO date. */
export function monthOf(isoDate: string): MonthKey {
  return isoDate.slice(0, 7)
}

export function addMonths(m: MonthKey, n: number): MonthKey {
  const { year, month } = parseMonth(m)
  const idx = year * 12 + (month - 1) + n
  return monthKey(Math.floor(idx / 12), (idx % 12) + 1)
}

/** Whole months from a to b (b - a). */
export function monthDiff(a: MonthKey, b: MonthKey): number {
  const pa = parseMonth(a)
  const pb = parseMonth(b)
  return (pb.year - pa.year) * 12 + (pb.month - pa.month)
}

/** Inclusive list of months from start to end. Empty when start > end. */
export function monthRange(start: MonthKey, end: MonthKey): MonthKey[] {
  const n = monthDiff(start, end)
  const out: MonthKey[] = []
  for (let i = 0; i <= n; i++) out.push(addMonths(start, i))
  return out
}

export function firstDay(m: MonthKey): string {
  return `${m}-01`
}

export function lastDay(m: MonthKey): string {
  const { year, month } = parseMonth(m)
  const d = new Date(Date.UTC(year, month, 0))
  return d.toISOString().slice(0, 10)
}

export interface Period {
  /** Stable key: '2026-03', '2026-Q1', '2026'. */
  key: string
  label: string
  startMonth: MonthKey
  endMonth: MonthKey
  months: MonthKey[]
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function bucketOf(m: MonthKey, interval: Interval): { key: string; label: string } {
  const { year, month } = parseMonth(m)
  if (interval === 'month') return { key: m, label: `${MONTH_NAMES[month - 1]} ${year}` }
  if (interval === 'quarter') {
    const q = Math.ceil(month / 3)
    return { key: `${year}-Q${q}`, label: `Q${q} ${year}` }
  }
  return { key: String(year), label: String(year) }
}

/**
 * The reporting periods covering [start, end]. A range that starts or ends mid-quarter
 * yields a partial first/last period — its `months` say exactly which months it holds,
 * so a partial quarter is never presented as a whole one.
 */
export function periods(start: MonthKey, end: MonthKey, interval: Interval): Period[] {
  const out: Period[] = []
  for (const m of monthRange(start, end)) {
    const { key, label } = bucketOf(m, interval)
    const last = out[out.length - 1]
    if (last && last.key === key) {
      last.months.push(m)
      last.endMonth = m
    } else {
      out.push({ key, label, startMonth: m, endMonth: m, months: [m] })
    }
  }
  return out
}

/** Sum a monthly flow into periods. Missing months contribute nothing (callers flag them). */
export function aggregateFlow(byMonth: ReadonlyMap<MonthKey, number>, ps: Period[]): number[] {
  return ps.map(p => roundCents(p.months.reduce((s, m) => s + (byMonth.get(m) ?? 0), 0)))
}

export interface BalancePoint {
  opening: number
  ending: number
}

/** Opening of a period's first month, ending of its last. Never a sum. */
export function aggregateBalance(byMonth: ReadonlyMap<MonthKey, BalancePoint>, ps: Period[]): (BalancePoint | null)[] {
  return ps.map(p => {
    const first = byMonth.get(p.startMonth)
    const last = byMonth.get(p.endMonth)
    if (!first || !last) return null
    return { opening: first.opening, ending: last.ending }
  })
}

export type RangePreset = 'ytd' | 'prior_year' | 'current_year' | 'next_12' | 'next_24'

/** Resolve a preset against "today" (a month) — next_N starts the month after `today`. */
export function presetRange(preset: RangePreset, today: MonthKey): { start: MonthKey; end: MonthKey } {
  const { year } = parseMonth(today)
  switch (preset) {
    case 'ytd':
      return { start: monthKey(year, 1), end: today }
    case 'prior_year':
      return { start: monthKey(year - 1, 1), end: monthKey(year - 1, 12) }
    case 'current_year':
      return { start: monthKey(year, 1), end: monthKey(year, 12) }
    case 'next_12':
      return { start: addMonths(today, 1), end: addMonths(today, 12) }
    case 'next_24':
      return { start: addMonths(today, 1), end: addMonths(today, 24) }
  }
}
