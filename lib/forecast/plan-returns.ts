// A plan's returns — one calculation for the point forecast and every simulated run
// (plans/plan-unified-plan.md §2, steps 3–7).
//
// The plan's entries already hold everything but capital: fees, expenses and other P&L cash, hand
// entries, and the deal flows (checks written, exit proceeds) from its construction. Capital
// management (lib/forecast/capital.ts) turns those into calls and distributions month by month, the
// waterfall splits each distribution, and the LPs' cash flows — their share of calls out, their
// distributions in, their share of what is left valued through the waterfall at the end — give the
// net figures. A simulated run is the same thing with its own deal flows.
//
// Pure: the service supplies the flows, the starting state and the terminal value.

import { roundCents } from '@/lib/accounting/ledger'
import { runWaterfall } from '@/lib/accounting/waterfall'
import { irrOf, type TimedFlow } from '@/lib/accounting/construction-forecast'
import type { ConstructionWaterfallProjection } from '@/lib/accounting/construction'
import { computeCapital, runMonthlyWaterfall, type CapitalSettings, type MonthlyCharges } from './capital'
import { monthDiff, type MonthKey } from './months'
import type { ProjectedDeals } from '@/lib/accounting/forward-waterfall'

export interface ReturnsInput {
  months: MonthKey[]
  /** The month the figures are measured from (IRR time 0) — the plan's cutoff. */
  asOfMonth: MonthKey
  openingCash: number
  uncalled: number
  settings: CapitalSettings
  /** Cash moved by everything other than deals and capital (P&L, settlements, hand entries). */
  otherFlows: Map<MonthKey, number>
  /** Deal cash: checks written (negative) and exit proceeds (positive). */
  invested: Map<MonthKey, number>
  proceeds: Map<MonthKey, number>
  /** The part of the proceeds recycled, and of that the part booked as distributed and recontributed. */
  recycled?: Map<MonthKey, number>
  recycledDeemed?: Map<MonthKey, number>
  /** The fund's NAV (gross, holdings at value) at the end of the window, plus its cash then. */
  terminalNav: number
  waterfall?: ConstructionWaterfallProjection
  /** The deals' projected checks and exits, for a deal-by-deal waterfall (construction-adapter.ts). */
  deals?: ProjectedDeals
  /** The plan's fees and expenses by month (capital.ts `MonthlyCharges`). */
  charges?: Map<MonthKey, MonthlyCharges>
}

export interface YearRow { calendarYear: number; called: number; distributed: number; carry: number; toLp: number; invested: number; proceeds: number; lpCalled: number; endingCash: number }

export interface PlanReturns {
  years: YearRow[]
  totals: { called: number; distributed: number; carry: number; toLp: number; invested: number; proceeds: number }
  /** The LPs' net figures (their share; carry deducted). */
  lp: { called: number; distributed: number; terminal: number; tvpi: number | null; dpi: number | null; irr: number | null }
  /** The calendar year half of the forecast distributions have been paid. */
  halfBackYear: number | null
  /** Distributions paid (carry included) from the plan's start through each month's end. */
  distributedToDate: number[]
  /** Cash in the bank at each month's end, after calls and distributions. */
  cash: { month: MonthKey; ending: number }[]
  /** Exit proceeds the plan recycles, by month (only months with any). */
  recycled: { month: MonthKey; amount: number }[]
  /** The plan's lowest month-end cash. */
  lowestCash: { month: MonthKey; amount: number } | null
  warnings: string[]
}

const sumMap = (m: Map<string, number>) => roundCents([...m.values()].reduce((s, v) => s + v, 0))

export function planReturns(input: ReturnsInput): PlanReturns {
  const cashFlows = new Map<MonthKey, number>()
  for (const m of input.months) {
    cashFlows.set(m, roundCents((input.otherFlows.get(m) ?? 0) + (input.invested.get(m) ?? 0) + (input.proceeds.get(m) ?? 0)))
  }
  const cap = computeCapital({
    months: input.months, openingCash: input.openingCash, cashFlows, proceeds: input.proceeds,
    recycled: input.recycled, recycledDeemed: input.recycledDeemed, uncalled: input.uncalled, settings: input.settings,
  })
  const wf = runMonthlyWaterfall(cap.distributions, cap.calls, input.months, input.waterfall, input.deals, input.charges)
  const carryOn = !!wf.state
  const share = wf.lpShare

  const byYear = new Map<number, YearRow>()
  const row = (m: MonthKey) => {
    const y = Number(m.slice(0, 4))
    return byYear.get(y) ?? (byYear.set(y, { calendarYear: y, called: 0, distributed: 0, carry: 0, toLp: 0, invested: 0, proceeds: 0, lpCalled: 0, endingCash: 0 }), byYear.get(y)!)
  }
  const lpFlows: TimedFlow[] = []
  const t = (m: MonthKey) => monthDiff(input.asOfMonth, m) / 12
  // The LPs' history (dated), so the IRR runs since inception.
  if (input.waterfall) {
    for (const c of input.waterfall.contributions) lpFlows.push({ t: t(c.date.slice(0, 7) as MonthKey), amount: -c.amount })
    for (const d of input.waterfall.distributions ?? []) lpFlows.push({ t: t(d.date.slice(0, 7) as MonthKey), amount: d.amount })
  }
  let lpCalled = 0, lpDistributed = 0
  for (const m of input.months) {
    const r = row(m)
    const call = cap.calls.get(m) ?? 0
    const split = wf.byMonth.get(m)
    const dist = split ? roundCents(split.toLp + split.toGpStake + split.carry) : 0
    // Without carry terms the split is all "to partners"; the LPs' part is their share of it.
    const toLp = split ? (carryOn ? split.toLp : roundCents(split.toLp * share)) : 0
    r.called = roundCents(r.called + call)
    r.distributed = roundCents(r.distributed + dist)
    r.carry = roundCents(r.carry + (split?.carry ?? 0))
    r.toLp = roundCents(r.toLp + toLp)
    r.invested = roundCents(r.invested + -(input.invested.get(m) ?? 0))
    r.proceeds = roundCents(r.proceeds + (input.proceeds.get(m) ?? 0))
    r.endingCash = cap.endingCash.get(m) ?? r.endingCash
    if (call) r.lpCalled = roundCents(r.lpCalled + call * share)
    if (call) { lpCalled = roundCents(lpCalled + call * share); lpFlows.push({ t: t(m), amount: -roundCents(call * share) }) }
    if (toLp) { lpDistributed = roundCents(lpDistributed + toLp); lpFlows.push({ t: t(m), amount: toLp }) }
  }
  // What the LPs would get for what is left: their share of the end NAV and cash, through the waterfall.
  const endCash = cap.endingCash.get(input.months[input.months.length - 1]) ?? 0
  const leftGross = Math.max(0, roundCents((input.terminalNav + endCash) * share))
  const terminal = carryOn && wf.state && wf.terms ? runWaterfall(leftGross, wf.terms, wf.state).toLP : leftGross
  const last = input.months[input.months.length - 1]
  if (terminal > 0 && last) lpFlows.push({ t: t(last), amount: terminal })

  const priorCalled = input.waterfall?.lpCalledCapital ?? 0
  const priorDistributed = input.waterfall?.lpDistributedCapital ?? 0
  const paidIn = priorCalled + lpCalled
  const outBack = priorDistributed + lpDistributed
  const years = [...byYear.values()].sort((a, b) => a.calendarYear - b.calendarYear)
  const totalDist = years.reduce((s, y) => s + y.distributed, 0)
  let running = 0
  const half = totalDist > 0 ? years.find(y => (running += y.distributed) >= totalDist / 2)?.calendarYear ?? null : null

  return {
    years,
    totals: {
      called: sumMap(cap.calls), distributed: roundCents(totalDist), carry: roundCents(years.reduce((s, y) => s + y.carry, 0)),
      toLp: roundCents(lpDistributed), invested: roundCents(years.reduce((s, y) => s + y.invested, 0)), proceeds: roundCents(years.reduce((s, y) => s + y.proceeds, 0)),
    },
    lp: {
      called: lpCalled, distributed: lpDistributed, terminal: roundCents(terminal),
      tvpi: paidIn > 0 ? (outBack + terminal) / paidIn : null,
      dpi: paidIn > 0 ? outBack / paidIn : null,
      irr: irrOf(lpFlows),
    },
    halfBackYear: half,
    cash: input.months.map(m => ({ month: m, ending: cap.endingCash.get(m) ?? 0 })),
    recycled: input.months.filter(m => (input.recycled?.get(m) ?? 0) !== 0).map(m => ({ month: m, amount: roundCents(input.recycled!.get(m)!) })),
    distributedToDate: input.months.reduce<number[]>((acc, m) => [...acc, roundCents((acc[acc.length - 1] ?? 0) + (cap.distributions.get(m) ?? 0))], []),
    lowestCash: input.months.reduce<{ month: MonthKey; amount: number } | null>((low, m) => {
      const v = cap.endingCash.get(m) ?? 0
      return !low || v < low.amount ? { month: m, amount: v } : low
    }, null),
    warnings: [...cap.warnings, ...wf.warnings],
  }
}
