'use client'

import { useMemo } from 'react'
import {
  ResponsiveContainer, ComposedChart, BarChart, Bar, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ReferenceLine, Cell, LabelList,
} from 'recharts'
import { ChartCard, EmptyPlot, AXIS, tooltipStyle, HUE, INVEST_NEW, PROCEEDS_HUE } from '@/components/fund-chart-kit'
import type { ForecastSchedule } from '@/lib/accounting/construction-forecast'
import type { SimulationResult } from '@/lib/accounting/construction-simulation'

/**
 * The plan on a date axis — the three pictures the pacing layer makes possible.
 *
 * The construction charts (charts.tsx) are compositions and scenarios because the model has no
 * clock. These have one, stated by the GP in the pacing assumptions, and so they can be honest
 * time series. Same chart vocabulary (fund-chart-kit) so called capital and proceeds keep the hues
 * they have on the fund page.
 */

type Fmt = (v: number | null) => string

/** A point on the fund's actual growth series, already reduced to multiples. */
export interface ActualPoint {
  /** Decimal calendar year, e.g. 2024.75 for a Q3 '24 quarter end. */
  x: number
  label: string
  tvpi: number | null
  dpi: number | null
  /** Capital paid in to date (called, or invested for a tracking-only vehicle). */
  paidIn?: number
}

export interface ActualCashFlow {
  year: number
  called: number
  invested: number
  expenses: number
  distributed: number
  lpDistributed: number
  carriedInterest: number
}

const TVPI_HUE = HUE.chart1
const DPI_HUE = HUE.chart2
const TVPI_BAND_OUTER = 'hsl(var(--chart-1) / 0.12)'
const TVPI_BAND_INNER = 'hsl(var(--chart-1) / 0.24)'
const DISTRIBUTION_BAND = 'hsl(var(--chart-2) / 0.24)'

function niceCurrencyScale(min: number, max: number): { domain: [number, number]; ticks: number[] } {
  const span = Math.max(1, max - min)
  const roughStep = span / 5
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)))
  const normalized = roughStep / magnitude
  const multiplier = normalized < 1.5 ? 1 : normalized < 3.5 ? 2 : normalized < 7.5 ? 5 : 10
  const step = multiplier * magnitude
  const lower = Math.floor(Math.min(0, min) / step) * step
  const upper = Math.ceil(Math.max(0, max) / step) * step
  const ticks: number[] = []
  for (let value = lower; value <= upper + step / 2; value += step) ticks.push(value)
  return { domain: [lower, upper], ticks }
}

// ── J-curve: DPI and TVPI over time, history solid and forecast dashed ────────
//
// ONE axis, in multiples of called capital. Called capital and distributions in dollars belong on
// the cash-flow chart beside this one, not on a second axis here. The simulation's spread sits
// behind the forecast line as two bands of the TVPI hue at two opacities — a sequential encoding of
// "how likely", not a second series — and the legend names the lines; the caption names the bands.

// RVPI and PIC (paid-in over committed) join TVPI and DPI as lines, drawn the same way — solid to
// date, dashed forecast. RVPI is what is still held; PIC is how much of the commitment is in.
// Violet, not the palette's amber: amber sits beside DPI's orange (ΔE 14, below the 15 a reader with
// full colour vision needs) — checked with the dataviz palette validator against the other three lines.
const RVPI_LINE_HUE = 'hsl(var(--cat-7))'
const PIC_HUE = INVEST_NEW

export function JCurveChart({ actual, schedule, simulation, netOfCarry, multiple, committed, years: yearRange }: {
  committed: number
  /** The page's date range, in calendar years: the chart shows only these. */
  years?: { first: number; last: number } | null
  actual: ActualPoint[]
  schedule: ForecastSchedule
  simulation: SimulationResult | null
  netOfCarry: boolean
  multiple: (v: number | null) => string
}) {
  const data = useMemo(() => {
    const rows = new Map<number, Record<string, number | [number, number] | null | string>>()
    // The source series is quarterly. Use the latest observation in each calendar year so this
    // chart has the same annual cadence as the cash-flow chart beside it.
    for (const p of actual) {
      const year = Math.floor(p.x)
      rows.set(year, {
        x: year, label: String(year), tvpiActual: p.tvpi, dpiActual: p.dpi,
        rvpiActual: p.tvpi != null && p.dpi != null ? p.tvpi - p.dpi : null,
        picActual: committed > 0 && p.paidIn != null ? p.paidIn / committed : null,
      })
    }
    const simByYear = new Map((simulation?.years ?? []).map(y => [y.year, y]))
    for (const y of schedule.years) {
      const x = y.calendarYear
      const sim = simByYear.get(y.year)
      const row = rows.get(x) ?? { x, label: String(x) }
      // Year 0 is today: the forecast starts from the last actual point, so the two lines meet.
      row.tvpiForecast = y.tvpi
      row.dpiForecast = y.dpi
      row.rvpiForecast = y.rvpi
      row.picForecast = committed > 0 ? y.cumCalled / committed : null
      row.label = String(x)
      if (sim) {
        row.tvpiOuter = [sim.tvpi.p10, sim.tvpi.p90]
        row.tvpiInner = [sim.tvpi.p25, sim.tvpi.p75]
      }
      rows.set(x, row)
    }
    return Array.from(rows.values())
      .filter(r => !yearRange || ((r.x as number) >= yearRange.first && (r.x as number) <= yearRange.last))
      .sort((a, b) => (a.x as number) - (b.x as number))
  }, [actual, schedule, simulation, committed, yearRange])

  const hasForecast = schedule.years.length > 1
  const hasBand = !!simulation && simulation.stated
  const yMax = useMemo(() => {
    const values: number[] = []
    for (const row of data) {
      for (const key of ['tvpiActual', 'dpiActual', 'rvpiActual', 'picActual', 'tvpiForecast', 'dpiForecast', 'rvpiForecast', 'picForecast', 'tvpiOuter'] as const) {
        const value = row[key]
        if (typeof value === 'number') values.push(value)
        else if (Array.isArray(value)) values.push(...value)
      }
    }
    const highest = Math.max(1, ...values.filter(Number.isFinite))
    return Math.max(1, Math.ceil(highest * 1.08))
  }, [data])
  const yTicks = useMemo(() => Array.from({ length: yMax + 1 }, (_, index) => index), [yMax])

  return (
    <ChartCard title={`${netOfCarry ? 'LP net' : 'Gross fund'} multiples by year`}>
      {!hasForecast ? (
        <EmptyPlot label="State the pacing assumptions to see the J-curve." />
      ) : (
        <>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
              <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} tick={AXIS} tickLine={false} axisLine={false} tickFormatter={(v: number) => String(Math.round(v))} allowDecimals={false} className="text-muted-foreground" />
              <YAxis domain={[0, yMax]} ticks={yTicks} allowDataOverflow tick={AXIS} tickLine={false} axisLine={false} width={40} tickFormatter={(v: number) => `${v.toFixed(1)}x`} className="text-muted-foreground" />
              <Tooltip
                contentStyle={tooltipStyle}
                labelFormatter={(_l, payload) => String((payload?.[0]?.payload as { label?: string } | undefined)?.label ?? '')}
                formatter={(v: any, n: any) => {
                  if (Array.isArray(v)) return [`${multiple(v[0])} – ${multiple(v[1])}`, n]
                  return [multiple(v as number), n]
                }}
              />
              <ReferenceLine y={1} stroke="hsl(var(--border))" />
              {hasBand && <Area dataKey="tvpiOuter" name="TVPI, 10th–90th percentile" stroke="none" fill={TVPI_BAND_OUTER} isAnimationActive={false} connectNulls legendType="none" />}
              {hasBand && <Area dataKey="tvpiInner" name="TVPI, 25th–75th percentile" stroke="none" fill={TVPI_BAND_INNER} isAnimationActive={false} connectNulls legendType="none" />}
              <Line type="monotone" dataKey="tvpiActual" name="TVPI to date" stroke={TVPI_HUE} strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls isAnimationActive={false} legendType="none" />
              <Line type="monotone" dataKey="tvpiForecast" name="TVPI forecast" stroke={TVPI_HUE} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 2 }} activeDot={{ r: 4 }} connectNulls isAnimationActive={false} legendType="none" />
              <Line type="monotone" dataKey="dpiActual" name="DPI to date" stroke={DPI_HUE} strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls isAnimationActive={false} legendType="none" />
              <Line type="monotone" dataKey="dpiForecast" name="DPI forecast" stroke={DPI_HUE} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 2 }} activeDot={{ r: 4 }} connectNulls isAnimationActive={false} legendType="none" />
              <Line type="monotone" dataKey="rvpiActual" name="RVPI to date" stroke={RVPI_LINE_HUE} strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls isAnimationActive={false} legendType="none" />
              <Line type="monotone" dataKey="rvpiForecast" name="RVPI forecast" stroke={RVPI_LINE_HUE} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 2 }} activeDot={{ r: 4 }} connectNulls isAnimationActive={false} legendType="none" />
              <Line type="monotone" dataKey="picActual" name="PIC to date" stroke={PIC_HUE} strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls isAnimationActive={false} legendType="none" />
              <Line type="monotone" dataKey="picForecast" name="PIC forecast" stroke={PIC_HUE} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 2 }} activeDot={{ r: 4 }} connectNulls isAnimationActive={false} legendType="none" />
            </ComposedChart>
          </ResponsiveContainer>
          {/* A legend of our own: recharts' would list six entries for what are two series
              (each drawn twice, solid then dashed), and the bands are not series at all. */}
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <li className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded" style={{ background: TVPI_HUE }} /> TVPI</li>
            <li className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded" style={{ background: DPI_HUE }} /> DPI</li>
            <li className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded" style={{ background: RVPI_LINE_HUE }} /> RVPI</li>
            <li className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded" style={{ background: PIC_HUE }} /> PIC (paid in ÷ committed)</li>
            {hasBand && <li className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm" style={{ background: TVPI_BAND_INNER }} /> TVPI range (simulated)</li>}
          </ul>
        </>
      )}
    </ChartCard>
  )
}

// ── Cash flows by year ───────────────────────────────────────────────────────
//
// Called capital drawn below the line, proceeds returned above it, with the cumulative net position
// as a line — all in dollars, one axis. Called capital keeps the fund page's "invested" hue and
// proceeds its own; the net line is ink.

/** The plan's own yearly figures and simulated range (lib/forecast/plan-returns.ts), when the entity has a plan. */
export interface PlanCashFlows {
  years: { calendarYear: number; called: number; distributed: number; carry: number; invested: number }[]
  /** Distributions paid by the end of each year (from the plan's start), across the simulated runs. */
  band: { calendarYear: number; p10: number; p50: number; p90: number }[] | null
  /** The same range month by month, for a monthly or quarterly chart. */
  bandByMonth?: { month: string; p10: number; p50: number; p90: number }[] | null
}

/**
 * The page's own periods (the Forecast page's date range and Month/Quarter/Year), from the same
 * series the statements read: calls, distributions and carry per period, actual or forecast.
 */
export interface HeadlinePeriod { label: string; year: number; yearEnd: boolean; lastMonth: string; actual: boolean; called: number; distributed: number; carry: number }

export function CashFlowChart({ actual, schedule, accounting, fmt, fmtFull, plan, periods }: { actual: ActualCashFlow[]; schedule: ForecastSchedule; accounting: boolean; fmt: Fmt; fmtFull: Fmt; plan?: PlanCashFlows | null; periods?: HeadlinePeriod[] | null }) {
  const data = useMemo(() => {
    // On the page's timescale: its periods, with the simulated range placed at each year's last
    // period (the band joins them, so it reads the same monthly, quarterly or annually).
    if (periods?.length) {
      const rows: { label: string; called: number; distributed: number; carry: number; fees: number; expenses: number; expensesRaw: number; invested: number; period: 'Actual' | 'Forecast'; low?: number; spread?: number; median?: number; planned?: number }[] = []
      // Every period reads the range at its own last month, so the band follows the timing as well
      // as the amount at any interval. It starts where the plan does, on top of what was paid before.
      const monthly = plan?.bandByMonth ?? []
      const band = new Map(monthly.map(b => [b.month, b]))
      const firstBandMonth = monthly.length ? monthly[0].month : null
      const paidBefore = firstBandMonth ? periods.filter(p => p.lastMonth < firstBandMonth).reduce((s, p) => s + p.distributed + p.carry, 0) : 0
      let toDate = 0
      for (const p of periods) {
        toDate += p.distributed + p.carry
        const b = band.get(p.lastMonth)
        rows.push({
          label: p.label, called: -p.called, distributed: p.distributed, carry: p.carry, fees: 0, expenses: 0, expensesRaw: 0, invested: 0,
          period: p.actual ? 'Actual' : 'Forecast',
          ...(b ? { low: paidBefore + b.p10, spread: Math.max(0, b.p90 - b.p10), median: paidBefore + b.p50 } : {}),
          ...(band.size ? { planned: roundTo(toDate) } : {}),
        })
      }
      return rows
    }
    const rows: { label: string; called: number; distributed: number; carry: number; fees: number; expenses: number; expensesRaw: number; invested: number; period: 'Actual' | 'Forecast'; low?: number; spread?: number; median?: number; planned?: number }[] = actual.map(y => ({
      label: String(y.year),
      called: -y.called,
      distributed: y.distributed,
      carry: y.carriedInterest,
      fees: 0,
      expenses: accounting ? 0 : -y.expenses,
      expensesRaw: y.expenses,
      invested: y.invested,
      period: 'Actual',
    }))
    // With a plan, the forecast years are the plan's own — its calls, distributions and carry, as the
    // fund forecast works them out monthly — added to the year's actuals where the year is part-way.
    if (plan) {
      for (const y of plan.years) {
        const label = String(y.calendarYear)
        const existing = rows.find(r => r.label === label)
        const add = { called: -y.called, distributed: roundTo(y.distributed - y.carry), carry: y.carry, invested: y.invested }
        if (existing) Object.assign(existing, { called: existing.called + add.called, distributed: existing.distributed + add.distributed, carry: existing.carry + add.carry, invested: existing.invested + add.invested, period: 'Forecast' as const })
        else rows.push({ label, ...add, fees: 0, expenses: 0, expensesRaw: 0, period: 'Forecast' })
      }
      // The simulated range, as distributions paid to date: when AND how much in one band (10th–90th
      // percentile), with the median and the plan's own forecast as lines.
      if (plan.band?.length) {
        let planned = 0
        const byYear = new Map(plan.years.map(y => [y.calendarYear, y.distributed]))
        for (const b of plan.band) {
          planned += byYear.get(b.calendarYear) ?? 0
          const row = rows.find(r => r.label === String(b.calendarYear))
          if (row) Object.assign(row, { low: b.p10, spread: Math.max(0, b.p90 - b.p10), median: b.p50, planned: roundTo(planned) })
        }
      }
      return rows
    }
    return schedule.years.slice(1).reduce<typeof rows>((forecastRows, y) => {
    forecastRows.push({
      label: String(y.calendarYear),
      called: -(accounting ? y.called : y.invested),
      distributed: y.distributed,
      carry: accounting ? (y.carriedInterest ?? 0) : 0,
      fees: y.fees,
      expenses: accounting ? 0 : -(y.fees + y.expenses),
      expensesRaw: y.expenses,
      invested: y.invested,
      period: 'Forecast',
    })
    return forecastRows
    }, rows)
  }, [actual, schedule, accounting, plan, periods])

  const hasBand = data.some(row => row.spread != null)
  const outflowLabel = accounting ? 'Called' : 'Invested'
  const inflowLabel = accounting ? 'Distributed' : 'Proceeds'
  const cashScale = useMemo(() => {
    const minimum = Math.min(0, ...data.map(row => row.called + row.expenses))
    const maximum = Math.max(0, ...data.map(row => Math.max(row.distributed + row.carry, (row.low ?? 0) + (row.spread ?? 0), row.planned ?? 0)))
    return niceCurrencyScale(minimum, maximum)
  }, [data])

  return (
    <ChartCard title={`Actual and forecast ${accounting ? 'cash flows' : 'investment flows'}${periods?.length ? '' : ' by year'}`}>
      {data.length === 0 ? (
        <EmptyPlot label="State the pacing assumptions to see the cash flows." />
      ) : (
        <>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }} stackOffset="sign">
              <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
              <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} className="text-muted-foreground" />
              <YAxis domain={cashScale.domain} ticks={cashScale.ticks} allowDataOverflow tick={AXIS} tickLine={false} axisLine={false} width={48} tickFormatter={v => fmt(v as number)} className="text-muted-foreground" />
              <Tooltip
                cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
                contentStyle={tooltipStyle}
                labelFormatter={(label, payload) => `${label} · ${(payload?.[0]?.payload as { period?: string } | undefined)?.period ?? ''}`}
                formatter={(v: any, n: any, item: any) => {
                  if (n === outflowLabel && accounting) return [`${fmtFull(Math.abs(v as number))} · ${fmtFull(item?.payload?.invested ?? 0)} invested, ${fmtFull(item?.payload?.fees ?? 0)} fees, ${fmtFull((item?.payload?.expensesRaw ?? 0))} expenses`, n]
                  if (n === 'Expenses') return [fmtFull(Math.abs(v as number)), n]
                  return [fmtFull(v as number), n]
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <ReferenceLine y={0} stroke="hsl(var(--border))" />
              <Bar dataKey="called" name={outflowLabel} stackId="flow" fill={INVEST_NEW} maxBarSize={28} radius={[0, 0, 4, 4]} stroke={HUE.surface} strokeWidth={2} isAnimationActive={false} />
              {!accounting && <Bar dataKey="expenses" name="Expenses" stackId="flow" fill={HUE.chart4} maxBarSize={28} radius={[0, 0, 4, 4]} stroke={HUE.surface} strokeWidth={2} isAnimationActive={false} />}
              <Bar dataKey="distributed" name={inflowLabel} stackId="flow" fill={PROCEEDS_HUE} maxBarSize={28} radius={[4, 4, 0, 0]} stroke={HUE.surface} strokeWidth={2} isAnimationActive={false} />
              {accounting && <Bar dataKey="carry" name="Carried interest" stackId="flow" fill={HUE.chart4} maxBarSize={28} radius={[4, 4, 0, 0]} stroke={HUE.surface} strokeWidth={2} isAnimationActive={false} />}
              {hasBand && <Area dataKey="low" stackId="band" stroke="none" fill="transparent" legendType="none" tooltipType="none" connectNulls isAnimationActive={false} />}
              {hasBand && <Area dataKey="spread" name="Distributed to date, 10th–90th percentile" stackId="band" stroke="none" fill={PROCEEDS_HUE} fillOpacity={0.15} tooltipType="none" connectNulls isAnimationActive={false} />}
              {hasBand && <Line dataKey="median" name="Distributed to date, median" stroke={PROCEEDS_HUE} strokeWidth={2} strokeDasharray="4 4" dot={false} connectNulls isAnimationActive={false} />}
              {hasBand && <Line dataKey="planned" name="Distributed to date, forecast" stroke={HUE.ink} strokeWidth={2} dot={false} isAnimationActive={false} />}
            </ComposedChart>
          </ResponsiveContainer>
        </>
      )}
    </ChartCard>
  )
}

// ── Distribution of outcomes ─────────────────────────────────────────────────
//
// A histogram of final TVPI across every run — one hue, because the bars are one series — with the
// median and the target as reference lines. Columns are counts of runs, so the height reads as
// likelihood directly.

export function OutcomeHistogram({ simulation, target, multiple }: { simulation: SimulationResult | null; target: number; multiple: (v: number | null) => string }) {
  const data = useMemo(() => (simulation?.histogram ?? []).map(b => ({
    label: `${b.from.toFixed(1)}x`,
    from: b.from,
    to: b.to,
    count: b.count,
    share: simulation ? b.count / simulation.runs : 0,
  })), [simulation])

  const median = simulation?.final.tvpi.p50 ?? null
  const medianLabel = median != null ? data.find(d => median >= d.from && median < d.to)?.label ?? null : null
  const targetLabel = target > 0 ? data.find(d => target >= d.from && target < d.to)?.label ?? null : null

  return (
    <ChartCard title="Range of simulated outcomes">
      {!simulation || !simulation.stated ? (
        <EmptyPlot label="State a loss rate or a dispersion to run the simulation." />
      ) : (
        <>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data} margin={{ top: 16, right: 8, bottom: 0, left: 8 }} barCategoryGap={2}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
              <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} interval="preserveStartEnd" className="text-muted-foreground" />
              <YAxis tick={AXIS} tickLine={false} axisLine={false} width={40} tickFormatter={(v: number) => `${Math.round((v / simulation.runs) * 100)}%`} className="text-muted-foreground" />
              <Tooltip
                cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
                contentStyle={tooltipStyle}
                labelFormatter={(l, payload) => { const p = payload?.[0]?.payload as { from: number; to: number } | undefined; return p ? `${multiple(p.from)} to ${multiple(p.to)} TVPI` : String(l) }}
                formatter={(v: any) => [`${v} of ${simulation.runs} runs · ${Math.round(((v as number) / simulation.runs) * 100)}%`, 'Runs']}
              />
              {medianLabel && <ReferenceLine x={medianLabel} stroke={HUE.ink} strokeDasharray="4 4" label={{ value: `Median ${multiple(median)}`, position: 'top', fontSize: 11, fill: HUE.ink }} />}
              {targetLabel && targetLabel !== medianLabel && <ReferenceLine x={targetLabel} stroke={HUE.muted} strokeDasharray="4 4" label={{ value: `Target ${multiple(target)}`, position: 'insideTopRight', fontSize: 11, fill: HUE.muted }} />}
              <Bar dataKey="count" name="Runs" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                {data.map(d => <Cell key={d.label} fill={TVPI_HUE} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </>
      )}
    </ChartCard>
  )
}

// ── Outcomes at fund exit ────────────────────────────────────────────────────
//
// The simulation's final multiple at five percentiles, as columns — emphasis form, the median in
// the multiples hue and the four others in de-emphasis grey, so the eye lands on the middle case and
// reads the rest as its spread (the Range of return outcomes chart's vocabulary). ONE axis: the net
// IRR is a different measure, so it rides in the tooltip and the line under the plot, not on a
// second scale. Direct labels on every column — five is few enough, and they are the figures the
// table used to give.

const OUTCOME_PERCENTILES = [
  { key: 'p10', label: '10th' },
  { key: 'p25', label: '25th' },
  { key: 'p50', label: 'Median' },
  { key: 'p75', label: '75th' },
  { key: 'p90', label: '90th' },
] as const
const SPREAD_FILL = 'hsl(var(--muted-foreground) / 0.35)'

export function ExitOutcomesChart({ simulation, netOfCarry, target, multiple }: { simulation: SimulationResult | null; netOfCarry: boolean; target: number; multiple: (v: number | null) => string }) {
  const data = useMemo(() => simulation ? OUTCOME_PERCENTILES.map(p => ({
    label: p.label,
    value: simulation.final.dpi[p.key],
    irr: simulation.final.netIrr?.[p.key] ?? null,
    isMedian: p.key === 'p50',
  })) : [], [simulation])
  const pct = (v: number | null) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`)
  const measure = netOfCarry ? 'Net multiple' : 'Gross multiple'
  const yMax = Math.max(1, Math.ceil(Math.max(target, ...data.map(d => d.value)) * 1.15 * 2) / 2)

  return (
    <ChartCard title={`${netOfCarry ? 'LP net' : 'Gross fund'} outcomes at fund exit`}>
      {!simulation || !simulation.stated ? (
        <EmptyPlot label="State a loss rate or a dispersion to run the simulation." />
      ) : (
        <>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data} margin={{ top: 20, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
              <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} className="text-muted-foreground" />
              <YAxis domain={[0, yMax]} tick={AXIS} tickLine={false} axisLine={false} width={40} tickFormatter={(v: number) => `${v.toFixed(1)}x`} className="text-muted-foreground" />
              <Tooltip
                cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
                contentStyle={tooltipStyle}
                labelFormatter={l => (l === 'Median' ? 'Median run' : `${l} percentile`)}
                formatter={(v: any, _n: any, item: any) => [
                  `${multiple(v as number)}${item?.payload?.irr != null ? ` · ${pct(item.payload.irr)} net IRR` : ''}`,
                  measure,
                ]}
              />
              <ReferenceLine y={1} stroke="hsl(var(--border))" />
              {target > 0 && <ReferenceLine y={target} stroke={HUE.muted} strokeDasharray="4 4" label={{ value: `Target ${multiple(target)}`, position: 'insideTopLeft', fontSize: 11, fill: HUE.muted }} />}
              <Bar dataKey="value" name={measure} maxBarSize={32} radius={[4, 4, 0, 0]} isAnimationActive={false}>
                {data.map(d => <Cell key={d.label} fill={d.isMedian ? TVPI_HUE : SPREAD_FILL} />)}
                <LabelList
                  dataKey="value"
                  content={(props: any) => (
                    <text x={props.x + props.width / 2} y={props.y - 6} textAnchor="middle" fontSize={11} fill={data[props.index]?.isMedian ? HUE.ink : HUE.muted} style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {multiple(props.value as number)}
                    </text>
                  )}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p className="mt-1 text-xs text-muted-foreground">
            {measure} across {simulation.runs.toLocaleString()} simulated runs, by percentile.
            {simulation.final.netIrr && <> Net IRR: <span className="tabular-nums">{pct(simulation.final.netIrr.p10)}</span> (10th) · <span className="tabular-nums">{pct(simulation.final.netIrr.p50)}</span> (median) · <span className="tabular-nums">{pct(simulation.final.netIrr.p90)}</span> (90th).</>}
          </p>
        </>
      )}
    </ChartCard>
  )
}

const roundTo = (n: number) => Math.round(n * 100) / 100
