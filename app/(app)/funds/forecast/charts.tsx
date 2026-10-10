'use client'

import { useMemo } from 'react'
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine, Cell,
} from 'recharts'
import { ChartCard, EmptyPlot, AXIS, tooltipStyle, HUE } from '@/components/fund-chart-kit'
import type { SeriesResult } from '@/lib/forecast/service'

/**
 * Both charts read the series the table reads, period for period — never a second query.
 *
 * Actual vs projected is carried by the MARK, not a new hue: actual periods are solid, forecast
 * periods are a lighter tint of the same slot (bars) or dashed (lines), and a reference line sits
 * at the cutoff. A "mixed" period (a quarter straddling the cutoff) draws as forecast, because
 * part of it is.
 */

type Fmt = (v: number | null) => string

const REVENUE = HUE.chart1
const REVENUE_FC = 'hsl(var(--chart-1) / 0.45)'
const EXPENSES = HUE.chart2
const EXPENSES_FC = 'hsl(var(--chart-2) / 0.45)'
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
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={64} tickFormatter={v => fmt(v)} />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v: any, name: any) => [fmt(v as number), name === 'actual' ? 'Actual' : 'Forecast']}
            />
            {edge && <ReferenceLine x={edge} stroke={HUE.muted} strokeDasharray="4 4" label={{ value: 'Actuals through', position: 'insideTopLeft', fontSize: 11, fill: HUE.muted }} />}
            <Line type="monotone" dataKey="actual" name="actual" stroke={CASH} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="forecast" name="forecast" stroke={CASH} strokeWidth={2} strokeDasharray="6 4" dot={false} connectNulls={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  )
}

export function PnlChart({ series, fmt }: { series: SeriesResult; fmt: Fmt }) {
  const data = useMemo(
    () => series.periods.map((p, i) => ({
      label: p.label,
      status: p.status,
      revenue: series.revenue[i],
      expenses: series.expenses[i],
      net: series.netIncome[i],
    })),
    [series],
  )
  const edge = boundaryLabel(series)
  const any = data.some(d => d.revenue || d.expenses)
  return (
    <ChartCard title="Revenue, expenses and net income">
      {!any ? <EmptyPlot label="No income or expense in this range" /> : (
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }} barGap={2}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={64} tickFormatter={v => fmt(v)} />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v: any, name: any) => [fmt(v as number), name]}
              labelFormatter={(label: any, payload: any) => {
                const st = payload?.[0]?.payload?.status
                return `${label} · ${st === 'forecast' ? 'forecast' : st === 'mixed' ? 'part forecast' : st === 'actual_unclosed' ? 'actual, not closed' : 'actual'}`
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {edge && <ReferenceLine x={edge} stroke={HUE.muted} strokeDasharray="4 4" />}
            <Bar dataKey="revenue" name="Revenue" radius={[4, 4, 0, 0]} fill={REVENUE} isAnimationActive={false}>
              {data.map(d => <Cell key={d.label} fill={isActual(d.status) ? REVENUE : REVENUE_FC} />)}
            </Bar>
            <Bar dataKey="expenses" name="Expenses" radius={[4, 4, 0, 0]} fill={EXPENSES} isAnimationActive={false}>
              {data.map(d => <Cell key={d.label} fill={isActual(d.status) ? EXPENSES : EXPENSES_FC} />)}
            </Bar>
            <Line type="monotone" dataKey="net" name="Net income" stroke={HUE.ink} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
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
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={data} stackOffset="sign" margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={64} tickFormatter={v => fmt(v)} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: any, name: any) => [fmt(v as number), name]} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <ReferenceLine y={0} stroke={HUE.muted} />
            {edge && <ReferenceLine x={edge} stroke={HUE.muted} strokeDasharray="4 4" />}
            {present.map(f => (
              <Bar key={f.key} dataKey={f.key} name={f.label} stackId="cash" fill={`hsl(${f.hue})`} isAnimationActive={false}>
                {data.map(d => <Cell key={d.label} fill={isActual(d.status) ? `hsl(${f.hue})` : `hsl(${f.hue} / 0.45)`} />)}
              </Bar>
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  )
}
