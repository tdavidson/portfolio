// Variance: one stream measured against another, period by period.
//
// Computed MONTHLY and only then rolled up, so a quarter's variance is the sum of its months'
// dollar variances and its percentage is recomputed from those dollars — never an average of
// monthly percentages. When the comparison is actuals, months with no actuals yet are left out of
// both sides: a quarter one month into the year compares one month of actual with one month of
// budget, not with three, and says so.

import { roundCents } from '@/lib/accounting/ledger'
import { periods as periodsOf, type Interval, type MonthKey } from './months'
import type { Report } from './report'

export interface VarianceCell {
  base: number
  compare: number
  /** compare − base. */
  diff: number
  /** diff ÷ |base|; null when base is 0. */
  pct: number | null
  /** Revenue above or expense below the base. Null when diff is 0. */
  favorable: boolean | null
}

export interface VarianceLine {
  accountId: string
  code: string
  name: string
  type: 'income' | 'expense'
  cells: (VarianceCell | null)[]
  total: VarianceCell | null
}

export interface VariancePeriod {
  key: string
  label: string
  start: MonthKey
  end: MonthKey
  /** Months that entered the comparison. Fewer than the period holds = partial. */
  months: MonthKey[]
  partial: boolean
}

export interface VarianceResult {
  interval: Interval
  periods: VariancePeriod[]
  lines: VarianceLine[]
  revenue: (VarianceCell | null)[]
  expenses: (VarianceCell | null)[]
  netIncome: (VarianceCell | null)[]
  /** Ending cash at each period's last compared month. */
  endingCash: (VarianceCell | null)[]
  totals: { revenue: VarianceCell | null; expenses: VarianceCell | null; netIncome: VarianceCell | null }
}

export function varianceCell(base: number, compare: number, kind: 'income' | 'expense' | 'net'): VarianceCell {
  const diff = roundCents(compare - base)
  const pct = base === 0 ? null : Math.round((diff / Math.abs(base)) * 10000) / 10000
  const favorable = diff === 0 ? null : kind === 'expense' ? diff < 0 : diff > 0
  return { base: roundCents(base), compare: roundCents(compare), diff, pct, favorable }
}

export interface VarianceInput {
  /** Both monthly, over the same months. */
  base: Report
  compare: Report
  interval: Interval
  /** Only count months where the compare stream is actual (true when comparing against actuals). */
  actualMonthsOnly: boolean
  /** Only count months inside the base plan's own window. */
  window?: { first: MonthKey; last: MonthKey } | null
}

export function computeVariance({ base, compare, interval, actualMonthsOnly, window }: VarianceInput): VarianceResult {
  if (base.interval !== 'month' || compare.interval !== 'month') throw new Error('computeVariance needs monthly reports')
  const months = compare.months.map(m => m.month)
  if (months.join() !== base.months.map(m => m.month).join()) throw new Error('Reports cover different months')
  const included = new Set(
    compare.months
      .filter(m => !actualMonthsOnly || m.status === 'actual' || m.status === 'actual_unclosed')
      .filter(m => !window || (m.month >= window.first && m.month <= window.last))
      .map(m => m.month),
  )
  const idx = new Map(months.map((m, i) => [m, i]))
  const ps = periodsOf(months[0], months[months.length - 1], interval)

  const roll = (b: number[], c: number[], kind: 'income' | 'expense' | 'net') => {
    let tb = 0
    let tc = 0
    let any = false
    const cells = ps.map(p => {
      const ms = p.months.filter(m => included.has(m))
      if (!ms.length) return null
      any = true
      const sb = ms.reduce((s, m) => s + b[idx.get(m)!], 0)
      const sc = ms.reduce((s, m) => s + c[idx.get(m)!], 0)
      tb += sb
      tc += sc
      return varianceCell(sb, sc, kind)
    })
    return { cells, total: any ? varianceCell(tb, tc, kind) : null }
  }

  const baseLines = new Map(base.lines.map(l => [l.accountId, l]))
  const compareLines = new Map(compare.lines.map(l => [l.accountId, l]))
  const zero = months.map(() => 0)
  const ids = [...new Set([...baseLines.keys(), ...compareLines.keys()])]
  const lines: VarianceLine[] = ids
    .map(id => {
      const meta = compareLines.get(id) ?? baseLines.get(id)!
      const r = roll(baseLines.get(id)?.values ?? zero, compareLines.get(id)?.values ?? zero, meta.type)
      return { accountId: id, code: meta.code, name: meta.name, type: meta.type, cells: r.cells, total: r.total }
    })
    .sort((a, b) => a.code.localeCompare(b.code))

  const revenue = roll(base.revenue, compare.revenue, 'income')
  const expenses = roll(base.expenses, compare.expenses, 'expense')
  const net = roll(base.netIncome, compare.netIncome, 'net')

  const endingCash = ps.map(p => {
    const ms = p.months.filter(m => included.has(m))
    if (!ms.length) return null
    const i = idx.get(ms[ms.length - 1])!
    const b = base.cash[i]
    const c = compare.cash[i]
    return b && c ? varianceCell(b.ending, c.ending, 'net') : null
  })

  return {
    interval,
    periods: ps.map(p => {
      const ms = p.months.filter(m => included.has(m))
      return { key: p.key, label: p.label, start: p.startMonth, end: p.endMonth, months: ms, partial: ms.length > 0 && ms.length < p.months.length }
    }),
    lines,
    revenue: revenue.cells,
    expenses: expenses.cells,
    netIncome: net.cells,
    endingCash,
    totals: { revenue: revenue.total, expenses: expenses.total, netIncome: net.total },
  }
}

/** The largest variances by absolute dollars, for "what are the biggest misses". */
export function largestVariances(v: VarianceResult, opts: { type?: 'income' | 'expense'; limit?: number } = {}) {
  return v.lines
    .filter(l => l.total && (!opts.type || l.type === opts.type))
    .sort((a, b) => Math.abs(b.total!.diff) - Math.abs(a.total!.diff))
    .slice(0, opts.limit ?? 10)
    .map(l => ({ accountId: l.accountId, code: l.code, name: l.name, type: l.type, ...l.total! }))
}
