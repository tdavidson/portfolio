'use client'

import { useMemo } from 'react'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, ReferenceLine, Cell,
} from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent } from '@/components/ui/chart'
import { ChartCard, EmptyPlot, AXIS, HUE, useAxisMoney } from '@/components/fund-chart-kit'
import type { SeriesResult } from '@/lib/forecast/service'
import { NOT_REVENUE, OTHER_KEY, sourceBreakdown } from './breakdown'

/**
 * Both charts read the series the table reads, period for period — never a second query.
 *
 * Actual vs projected is carried by the MARK, not a new hue: actual periods are solid, forecast
 * periods are a lighter tint of the same slot (bars) or dashed (lines), and a reference line sits
 * at the cutoff. A "mixed" period (a quarter straddling the cutoff) draws as forecast, because
 * part of it is.
 */

type Fmt = (v: number | null) => string

const CASH = HUE.chart3

const isActual = (status: string) => status === 'actual' || status === 'actual_unclosed'

/** The label of the last period that is wholly actual — where the boundary line goes. */
function boundaryLabel(s: SeriesResult): string | null {
  let last: string | null = null
  let sawForecast = false
  for (const p of s.periods) {
    if (isActual(p.status)) last = p.label
    // Trailing no-data periods (the range runs past the actuals) are not a forecast and draw no line.
    else if (p.status === 'forecast' || p.status === 'mixed') sawForecast = true
  }
  return last && sawForecast ? last : null
}

export function CashChart({ series, fmt }: { series: SeriesResult; fmt: Fmt }) {
  const axisMoney = useAxisMoney()
  // Two keys so the forecast run can be dashed; they share the boundary point so the line is unbroken.
  const data = useMemo(() => {
    const lastActual = series.periods.reduce((i, p, idx) => (isActual(p.status) ? idx : i), -1)
    return series.periods.map((p, i) => {
      const ending = series.cash[i]?.ending ?? null
      return {
        label: p.label,
        status: p.status,
        actual: i <= lastActual ? ending : null,
        forecast: i >= lastActual && p.status !== 'none' && (i > lastActual || series.periods.slice(i + 1).some(q => q.status === 'forecast' || q.status === 'mixed')) ? ending : null,
      }
    })
  }, [series])
  const edge = boundaryLabel(series)
  const any = data.some(d => d.actual != null || d.forecast != null)
  return (
    <ChartCard title="Ending cash">
      {!any ? <EmptyPlot label="No cash accounts with activity in this range" /> : (
        <ChartContainer height={240}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={56} tickFormatter={axisMoney} />
            <ChartTooltip
              content={<ChartTooltipContent />}
              formatter={(v: any, name: any) => [fmt(v as number), name === 'actual' ? 'Actual' : 'Forecast']}
            />
            {edge && <ReferenceLine x={edge} stroke={HUE.muted} strokeDasharray="4 4" label={{ value: 'Actuals through', position: 'insideTopLeft', fontSize: 11, fill: HUE.muted }} />}
            <Line type="monotone" dataKey="actual" name="actual" stroke={CASH} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="forecast" name="forecast" stroke={CASH} strokeWidth={2} strokeDasharray="6 4" dot={false} connectNulls={false} isAnimationActive={false} />
          </ComposedChart>
        </ChartContainer>
      )}
    </ChartCard>
  )
}

// Revenue and expenses, the fund's operating P&L, with realized gains (an exit's gain over cost) as
// their own series — unrealized and FX changes are left out. Forecast periods are a lighter tint. A
// single exit would dwarf every month, so the scale is set by the ordinary periods and one far
// larger is cut at the edge with its full figure on it.
//
// Each series takes the slot it has on the fund overview's assets chart (fund-chart-kit:
// INCOME_HUE, EXPENSE_HUE, REALIZED_HUE), so revenue, expenses and gains are one colour wherever
// they are plotted. Bare `var()`s here because forecast periods tint them with `/ 0.45`.
const REVENUE_HUE = 'var(--chart-5)'
const EXPENSE_HUE = 'var(--chart-4)'
// Realized gains (an exit's gain over cost) are shown, as their own series: they are what a fund
// earns, just not operating revenue. Unrealized and FX changes stay out.
const GAIN_HUE = 'var(--chart-2)'

/** The smallest 1, 2, 2.5 or 5 × 10ⁿ at or above `v`, so a cut-off scale still ticks in round steps. */
function niceCeil(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v))
  const step = [1, 2, 2.5, 5, 10].find(m => m * p >= v) ?? 10
  return step * p
}

export function PnlChart({ series, fmt }: { series: SeriesResult; fmt: Fmt }) {
  const axisMoney = useAxisMoney()
  const { data, cap } = useMemo(() => {
    const revenueLines = series.lines.filter(l => l.type === 'income' && !NOT_REVENUE.has(l.subtype ?? ''))
    const expenseLines = series.lines.filter(l => l.type === 'expense')
    const gainLines = series.lines.filter(l => l.type === 'income' && l.subtype === 'realized_gain')
    const rows = series.periods.map((p, i) => ({
      label: p.label,
      status: p.status,
      revenue: revenueLines.reduce((s, l) => s + (l.values[i] ?? 0), 0),
      gains: gainLines.reduce((s, l) => s + (l.values[i] ?? 0), 0),
      expenses: -expenseLines.reduce((s, l) => s + (l.values[i] ?? 0), 0),
    })).map(r => ({ ...r, up: r.revenue + Math.max(0, r.gains), down: r.expenses + Math.min(0, r.gains) }))
    const mags = rows.flatMap(r => [Math.abs(r.up), Math.abs(r.down)]).filter(v => v > 0).sort((a, b) => a - b)
    const p80 = mags.length ? mags[Math.min(mags.length - 1, Math.floor(mags.length * 0.8))] : 0
    const max = mags[mags.length - 1] ?? 0
    const cap = p80 > 0 && max > 4.5 * p80 ? niceCeil(p80 * 1.5) : null
    return { data: rows, cap }
  }, [series])
  const edge = boundaryLabel(series)
  const any = data.some(d => d.revenue || d.expenses || d.gains)
  const hasGains = data.some(d => Math.abs(d.gains) >= 0.5)
  const clipped = cap ? data.filter(d => Math.abs(d.up) > cap || Math.abs(d.down) > cap) : []
  const fill = (hue: string, status: string) => (isActual(status) ? `hsl(${hue})` : `hsl(${hue} / 0.45)`)
  return (
    <ChartCard title={hasGains ? 'Revenue, gains and expenses' : 'Revenue and expenses'}>
      {!any ? <EmptyPlot label="No revenue or expenses in this range" /> : (
        <ChartContainer height={240}>
          <ComposedChart data={data} stackOffset="sign" margin={{ top: 18, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={56} tickFormatter={axisMoney}
              {...(cap ? { domain: [-cap, cap], ticks: [-cap, -cap / 2, 0, cap / 2, cap], allowDataOverflow: true } : {})} />
            <ChartTooltip
              content={<ChartTooltipContent />}
              formatter={(v: any, name: any) => [fmt(Math.abs(v as number)), name]}
              labelFormatter={(label: any, payload: any) => {
                const st = payload?.[0]?.payload?.status
                return `${label} · ${st === 'forecast' ? 'forecast' : st === 'mixed' ? 'part forecast' : st === 'actual_unclosed' ? 'actual, not closed' : 'actual'}`
              }}
            />
            <ChartLegend verticalAlign="top" align="left" content={<ChartLegendContent />} />
            <ReferenceLine y={0} stroke={HUE.muted} />
            {edge && <ReferenceLine x={edge} stroke={HUE.muted} strokeDasharray="4 4" />}
            {clipped.map(d => {
              // Neighbouring cut bars have no room for a figure each, so those get the marker alone
              // and the tooltip carries the amount.
              const i = data.indexOf(d)
              const crowded = clipped.includes(data[i - 1]) || clipped.includes(data[i + 1])
              const up = Math.abs(d.up) > cap!
              const amount = up ? fmt(d.up) : fmt(Math.abs(d.down))
              return (
                <ReferenceLine key={`clip-${d.label}`} x={d.label} stroke="none"
                  label={{ value: crowded ? (up ? '▲' : '▼') : `${up ? '▲' : '▼'} ${amount}`, position: up ? 'insideTop' : 'insideBottom', fontSize: 10, fill: HUE.muted }} />
              )
            })}
            <Bar dataKey="revenue" name="Revenue" stackId="pnl" fill={`hsl(${REVENUE_HUE})`} radius={[4, 4, 0, 0]} isAnimationActive={false}>
              {data.map(d => <Cell key={d.label} fill={fill(REVENUE_HUE, d.status)} />)}
            </Bar>
            <Bar dataKey="expenses" name="Expenses" stackId="pnl" fill={`hsl(${EXPENSE_HUE})`} radius={[0, 0, 4, 4]} isAnimationActive={false}>
              {data.map(d => <Cell key={d.label} fill={fill(EXPENSE_HUE, d.status)} />)}
            </Bar>
            {hasGains && (
              <Bar dataKey="gains" name="Realized gains" stackId="pnl" fill={`hsl(${GAIN_HUE})`} radius={[4, 4, 0, 0]} isAnimationActive={false}>
                {data.map(d => <Cell key={d.label} fill={fill(GAIN_HUE, d.status)} />)}
              </Bar>
            )}
          </ComposedChart>
        </ChartContainer>
      )}
    </ChartCard>
  )
}

// ── Fund cash timeline: what moved the cash, period by period ───────────────────────────────────
//
// Signed stacked bars on one axis — money in above zero, money out below — in the categorical
// order fixed here (never cycled), so "capital calls" keeps its colour as categories come and go.
// Forecast periods are a lighter tint of each category's slot.

const FLOW_META = [
  { key: 'called', label: 'Capital calls', hue: 'var(--chart-1)' },
  { key: 'proceeds', label: 'Exit proceeds', hue: 'var(--chart-2)' },
  { key: 'invested', label: 'Investments', hue: 'var(--chart-3)' },
  { key: 'distributed', label: 'Distributions', hue: 'var(--chart-4)' },
  { key: 'operating', label: 'Fees and operating', hue: 'var(--chart-5)' },
  { key: 'borrowed', label: 'Borrowings', hue: 'var(--cat-6)' },
  { key: 'repaid', label: 'Loan repayments', hue: 'var(--cat-7)' },
] as const

export function CashFlowTimeline({ series, fmt }: { series: SeriesResult; fmt: Fmt }) {
  const axisMoney = useAxisMoney()
  const flows = series.cashFlows
  const data = useMemo(
    () => series.periods.map((p, i) => ({
      label: p.label,
      status: p.status,
      ...Object.fromEntries(FLOW_META.map(f => [f.key, flows ? flows[f.key][i] : 0])),
    })),
    [series, flows],
  )
  const present = FLOW_META.filter(f => data.some(d => (d as any)[f.key]))
  const edge = boundaryLabel(series)
  return (
    <ChartCard title="Cash flows by source">
      {!present.length ? <EmptyPlot label="No cash movement in this range" /> : (
        <ChartContainer height={260}>
          <ComposedChart data={data} stackOffset="sign" margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={56} tickFormatter={axisMoney} />
            <ChartTooltip content={<ChartTooltipContent />} formatter={(v: any, name: any) => [fmt(v as number), name]} />
            <ChartLegend verticalAlign="top" align="left" content={<ChartLegendContent />} />
            <ReferenceLine y={0} stroke={HUE.muted} />
            {edge && <ReferenceLine x={edge} stroke={HUE.muted} strokeDasharray="4 4" />}
            {present.map(f => (
              <Bar key={f.key} dataKey={f.key} name={f.label} stackId="cash" fill={`hsl(${f.hue})`} isAnimationActive={false}>
                {data.map(d => <Cell key={d.label} fill={isActual(d.status) ? `hsl(${f.hue})` : `hsl(${f.hue} / 0.45)`} />)}
              </Bar>
            ))}
          </ComposedChart>
        </ChartContainer>
      )}
    </ChartCard>
  )
}

// ── Revenue and expenses by source (management company) ─────────────────────────────────────────
//
// One stacked bar per period, each P&L account a segment: the largest five over the range in the
// categorical slots, largest first, and the rest as "Other" in muted ink. Slot order follows size
// over the whole range, so an account keeps its colour across periods. Forecast periods are a
// lighter tint of each slot.

const SOURCE_HUES = ['var(--cat-1)', 'var(--cat-2)', 'var(--cat-3)', 'var(--cat-4)', 'var(--cat-5)']
const OTHER_HUE = 'var(--muted-foreground)'

export function SourceChart({ series, fmt, type }: { series: SeriesResult; fmt: Fmt; type: 'income' | 'expense' }) {
  const axisMoney = useAxisMoney()
  const sources = useMemo(() => sourceBreakdown(series.lines, type), [series, type])
  const data = useMemo(
    () => series.periods.map((p, i) => ({
      label: p.label,
      status: p.status,
      ...Object.fromEntries(sources.map(s => [s.key, s.values[i] ?? 0])),
    })),
    [series, sources],
  )
  const edge = boundaryLabel(series)
  const hue = (key: string, i: number) => (key === OTHER_KEY ? OTHER_HUE : SOURCE_HUES[i] ?? OTHER_HUE)
  const title = type === 'income' ? 'Revenue by source' : 'Expenses by source'
  return (
    <ChartCard title={title}>
      {!sources.length ? <EmptyPlot label={type === 'income' ? 'No revenue in this range' : 'No expenses in this range'} /> : (
        <ChartContainer height={260}>
          <ComposedChart data={data} stackOffset="sign" margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={56} tickFormatter={axisMoney} />
            <ChartTooltip
              content={<ChartTooltipContent />}
              formatter={(v: any, name: any) => [fmt(v as number), name]}
              labelFormatter={(label: any, payload: any) => {
                const st = payload?.[0]?.payload?.status
                return `${label} · ${st === 'forecast' ? 'forecast' : st === 'mixed' ? 'part forecast' : st === 'actual_unclosed' ? 'actual, not closed' : 'actual'}`
              }}
            />
            <ChartLegend verticalAlign="top" align="left" content={<ChartLegendContent />} />
            <ReferenceLine y={0} stroke={HUE.muted} />
            {edge && <ReferenceLine x={edge} stroke={HUE.muted} strokeDasharray="4 4" />}
            {sources.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} stackId="src" fill={`hsl(${hue(s.key, i)})`} isAnimationActive={false}>
                {data.map(d => <Cell key={d.label} fill={isActual(d.status) ? `hsl(${hue(s.key, i)})` : `hsl(${hue(s.key, i)} / 0.45)`} />)}
              </Bar>
            ))}
          </ComposedChart>
        </ChartContainer>
      )}
    </ChartCard>
  )
}
