// Portfolio construction, by month.
//
// Construction owns a fund's investment economics and reports them by CALENDAR YEAR
// (construction-forecast.ts, on the rows of lib/accounting/construction-calendar.ts). Underneath, its deals carry fractional-year times —
// when a check is written, when an exit lands — so those can be placed in real months instead of
// dividing a year by twelve. This adapter does that and nothing more: it reads the schedule, it
// never recomputes it, and every year it produces re-adds to construction's own annual figure.
//
// What has a month and what doesn't:
//   invested, proceeds   per deal, at ceil(12·t) months after the model's as-of month. 'stated'
//                        when the deal carries its own timing, 'inferred' when fund-wide pacing set it.
//   fees, expenses       construction states only an annual amount → spread evenly, labelled so.
//   called, distributed  construction's annual waterfall result → placed in the months whose
//                        outflows (calls) or proceeds (distributions) drove them, so the year still
//                        re-adds exactly; labelled inferred.

import { roundCents } from '@/lib/accounting/ledger'
import type { ForecastSchedule } from '@/lib/accounting/construction-forecast'
import { projectedDeals, type ProjectedDeals } from '@/lib/accounting/forward-waterfall'
import { addMonths, lastDay, monthOf, type MonthKey } from './months'
import { monthIndexOfTime, rowEndMonth, rowOfMonthIndex, rowStartMonth, scheduleGrid } from '@/lib/accounting/construction-calendar'

export type ConstructionFlow = 'invested' | 'proceeds' | 'fees' | 'expenses' | 'called' | 'distributed'

export interface ConstructionEvent {
  month: MonthKey
  flow: ConstructionFlow
  amount: number
  /** Cost basis released by an exit (proceeds only), so the gain can be split from the return of capital. */
  cost?: number
  /** The part of an exit's proceeds the fund recycles (proceeds only), and of that the part booked as deemed. */
  recycled?: number
  recycledDeemed?: number
  deal?: string
  /** A company the fund already holds (its id), so its own cost, mark and gain accounts are used. */
  companyId?: string
  timing: 'stated' | 'inferred'
  note?: string
}

export interface MonthlyConstruction {
  asOfMonth: MonthKey
  events: ConstructionEvent[]
  byMonth: Map<MonthKey, Record<ConstructionFlow, number>>
  /** Per construction year: the annual figure and the monthly re-add, which must match. */
  reconciliation: { year: number; calendarYear: number; flow: ConstructionFlow; annual: number; monthly: number }[]
  warnings: string[]
}

const FLOWS: ConstructionFlow[] = ['invested', 'proceeds', 'fees', 'expenses', 'called', 'distributed']

/** Months after the as-of month for a fractional-year time. A row's months are its calendar year's (lib/accounting/construction-calendar.ts). */
const monthIndex = monthIndexOfTime

/** Spread `total` over weighted slots so the parts re-add to the cent. */
function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  const w = sum > 0 ? weights : weights.map(() => 1)
  const ws = w.reduce((a, b) => a + b, 0)
  const parts = w.map(x => roundCents((total * x) / ws))
  const drift = roundCents(total - parts.reduce((a, b) => a + b, 0))
  if (drift !== 0) {
    const i = w.indexOf(Math.max(...w))
    parts[i] = roundCents(parts[i] + drift)
  }
  return parts
}

/**
 * The deals' projected checks and exits by month, for a deal-by-deal waterfall, placed where
 * monthlyConstruction places their cash. `expenses` are the plan's fees and expenses by month.
 */
export function monthlyProjectedDeals(schedule: ForecastSchedule, asOf: string, expenses: Map<MonthKey, number>): ProjectedDeals {
  const asOfMonth = monthOf(asOf)
  return projectedDeals(
    schedule.deals,
    schedule.horizonYears,
    t => lastDay(addMonths(asOfMonth, monthIndex(t))),
    [...expenses].map(([m, amount]) => ({ date: lastDay(m), amount })),
  )
}

export function monthlyConstruction(schedule: ForecastSchedule, asOf: string): MonthlyConstruction {
  const asOfMonth = monthOf(asOf)
  const H = schedule.horizonYears
  // The schedule's own grid when it was made from the same as-of month; otherwise the same rule.
  const grid = schedule.grid?.asOfMonth === asOfMonth ? schedule.grid : scheduleGrid(asOf, H)
  const rowOfIndex = (k: number) => rowOfMonthIndex(grid, k)
  const events: ConstructionEvent[] = []
  const warnings: string[] = []
  const at = (k: number) => addMonths(asOfMonth, k)

  // Deals: the dated flows. Construction drops anything at t ≤ 0 and clamps investments past the
  // horizon into its last year; mirror both so the years still re-add.
  let dropped = 0
  for (const d of schedule.deals) {
    // Checks are only in the schedule when their timing was stated (construction omits undated
    // ones), so investments are 'stated'; an exit is stated only when the deal carries its own.
    const timing = d.timing === 'stated' ? 'stated' : 'inferred'
    const place = (t: number, amount: number) => {
      if (amount <= 0) return
      if (t <= 0) { dropped++; return }
      let k = monthIndex(t)
      let note: string | undefined
      if (k > grid.horizonMonths) { k = grid.horizonMonths; note = 'Beyond the horizon — construction books it in its last year' }
      events.push({ month: at(k), flow: 'invested', amount: roundCents(amount), deal: d.name, ...(d.kind === 'existing' ? { companyId: d.key } : {}), timing: 'stated', note })
    }
    place(d.initialAt, d.initialCheck)
    place(d.followOnAt, d.followOn)
    if (d.proceeds != null && d.proceeds > 0) {
      if (d.exitAt <= 0) dropped++
      else if (d.exitAt <= H + 1e-9) {
        const cost = d.investedToDate + d.initialCheck + d.followOn
        events.push({
          month: at(monthIndex(d.exitAt)), flow: 'proceeds', amount: roundCents(d.proceeds), cost: roundCents(cost), deal: d.name,
          ...(d.kind === 'existing' ? { companyId: d.key } : {}),
          ...(d.recycled ? { recycled: roundCents(d.recycled), recycledDeemed: roundCents(d.recycledDeemed ?? 0) } : {}),
          timing,
        })
      }
    }
  }
  if (dropped) warnings.push(`${dropped} construction flow${dropped === 1 ? '' : 's'} dated today or earlier ${dropped === 1 ? 'is' : 'are'} not in the forecast (construction leaves them out too)`)
  // An exit on the fund's default hold period is an assumption, not a problem: Investments shows
  // each company's hold, so there is no note for it.

  // Annual flows, year by year.
  for (const y of schedule.years) {
    if (y.year < 1) continue
    const first = rowStartMonth(grid, y.year), last = rowEndMonth(grid, y.year)
    const months = Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => at(first + i))
    const inYear = (flow: ConstructionFlow) => months.map(m => events.filter(e => e.month === m && e.flow === flow).reduce((s, e) => s + e.amount, 0))
    const invested = inYear('invested')
    const proceeds = inYear('proceeds')
    const fees = apportion(y.fees, months.map(() => 1))
    const expenses = apportion(y.expenses, months.map(() => 1))
    const called = apportion(y.called, months.map((_, i) => invested[i] + fees[i] + expenses[i]))
    const distributed = apportion(y.distributed, proceeds.some(p => p > 0) ? proceeds : months.map(() => 1))
    const push = (flow: ConstructionFlow, parts: number[], note: string) =>
      parts.forEach((amount, i) => { if (amount) events.push({ month: months[i], flow, amount, timing: 'inferred', note }) })
    push('fees', fees, 'Construction states fees per year; spread evenly by month')
    push('expenses', expenses, 'Construction states expenses per year; spread evenly by month')
    push('called', called, 'Placed in the months whose investments and costs it funds')
    push('distributed', distributed, 'Placed in the months whose exit proceeds it returns')
  }

  const byMonth = new Map<MonthKey, Record<ConstructionFlow, number>>()
  for (const e of events) {
    const row = byMonth.get(e.month) ?? (Object.fromEntries(FLOWS.map(f => [f, 0])) as Record<ConstructionFlow, number>)
    row[e.flow] = roundCents(row[e.flow] + e.amount)
    byMonth.set(e.month, row)
  }

  const reconciliation: MonthlyConstruction['reconciliation'] = []
  for (const y of schedule.years) {
    if (y.year < 1) continue
    for (const flow of FLOWS) {
      const annual = flow === 'proceeds'
        ? roundCents(schedule.deals.filter(d => d.proceeds != null && d.proceeds > 0 && d.exitAt > 0 && d.exitAt <= H + 1e-9 && rowOfIndex(monthIndex(d.exitAt)) === y.year).reduce((s, d) => s + d.proceeds!, 0))
        : (y as any)[flow] as number
      const monthly = roundCents(events.filter(e => e.flow === flow && rowOfIndex(monthIndexOf(asOfMonth, e.month)) === y.year).reduce((s, e) => s + e.amount, 0))
      reconciliation.push({ year: y.year, calendarYear: y.calendarYear, flow, annual: roundCents(annual), monthly })
    }
  }
  const off = reconciliation.filter(r => Math.abs(r.annual - r.monthly) > 0.01)
  if (off.length) warnings.push(`Monthly construction does not re-add to the annual model for ${off.map(r => `${r.flow} ${r.calendarYear}`).join(', ')}`)

  events.sort((a, b) => a.month.localeCompare(b.month) || FLOWS.indexOf(a.flow) - FLOWS.indexOf(b.flow))
  return { asOfMonth, events, byMonth, reconciliation, warnings }
}

function monthIndexOf(asOfMonth: MonthKey, m: MonthKey): number {
  const [ay, am] = asOfMonth.split('-').map(Number)
  const [y, mm] = m.split('-').map(Number)
  return (y - ay) * 12 + (mm - am)
}
