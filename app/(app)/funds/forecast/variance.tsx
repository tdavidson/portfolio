'use client'

import { useMemo, useState } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, Cell, ReferenceLine,
} from 'recharts'
import { ChartCard, EmptyPlot, AXIS, tooltipStyle, HUE } from '@/components/fund-chart-kit'
import { cn } from '@/lib/utils'
import type { VarianceResponse } from '@/lib/forecast/service'
import type { VarianceCell } from '@/lib/forecast/variance'

type Fmt = (v: number | null) => string

const BASE = HUE.chart4
const COMPARE = HUE.chart1
const FAVORABLE = 'hsl(var(--success))'
const UNFAVORABLE = 'hsl(var(--destructive))'

const pct = (c: VarianceCell | null) => (c?.pct == null ? '—' : `${c.pct > 0 ? '+' : ''}${(c.pct * 100).toFixed(1)}%`)

/** Signed difference with a word, so favourable/unfavourable never rests on colour alone. */
function Diff({ c, fmt }: { c: VarianceCell | null; fmt: Fmt }) {
  if (!c) return <span className="text-muted-foreground">—</span>
  return (
    <span className={cn(c.favorable === true && 'text-success', c.favorable === false && 'text-destructive')}
      title={c.favorable == null ? 'On plan' : c.favorable ? 'Favourable' : 'Unfavourable'}>
      {c.diff > 0 ? '+' : ''}{fmt(c.diff)}
    </span>
  )
}

export function VarianceSection({ data, fmt, short, baseLabel, compareLabel }: {
  data: VarianceResponse
  fmt: Fmt
  short: Fmt
  baseLabel: string
  compareLabel: string
}) {
  const [focus, setFocus] = useState<string>('expenses')

  const focusCells = useMemo(() => {
    if (focus === 'revenue') return data.revenue
    if (focus === 'expenses') return data.expenses
    if (focus === 'net') return data.netIncome
    return data.lines.find(l => l.accountId === focus)?.cells ?? []
  }, [data, focus])

  const comparison = data.periods.map((p, i) => ({
    label: p.partial ? `${p.label}*` : p.label,
    base: focusCells[i]?.base ?? null,
    compare: focusCells[i]?.compare ?? null,
  }))

  const byAccount = data.lines
    .filter(l => l.total && l.total.diff !== 0)
    .sort((a, b) => Math.abs(b.total!.diff) - Math.abs(a.total!.diff))
    .slice(0, 10)
    .map(l => ({ label: `${l.code} ${l.name}`, diff: l.total!.diff, favorable: l.total!.favorable }))

  const hasPeriods = data.periods.some(p => p.months.length > 0)

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title={`${compareLabel} vs ${baseLabel}`}
          action={
            <select className="h-8 rounded-md border border-input bg-background px-2 text-sm" value={focus} onChange={e => setFocus(e.target.value)} aria-label="Line">
              <option value="revenue">Total revenue</option>
              <option value="expenses">Total expenses</option>
              <option value="net">Net income</option>
              {data.lines.map(l => <option key={l.accountId} value={l.accountId}>{l.code} {l.name}</option>)}
            </select>
          }
        >
          {!hasPeriods ? <EmptyPlot label="No comparable months in this range" /> : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={comparison} margin={{ top: 8, right: 8, left: 8, bottom: 0 }} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
                <YAxis tick={AXIS} tickLine={false} axisLine={false} width={64} tickFormatter={v => short(v)} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: any, name: any) => [fmt(v as number), name]} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="base" name={baseLabel} fill={BASE} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                <Bar dataKey="compare" name={compareLabel} fill={COMPARE} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title="Largest variances by account">
          {!byAccount.length ? <EmptyPlot label="No variances in this range" /> : (
            <ResponsiveContainer width="100%" height={Math.max(240, byAccount.length * 28 + 32)}>
              <BarChart data={byAccount} layout="vertical" margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={v => short(v)} />
                <YAxis type="category" dataKey="label" tick={AXIS} tickLine={false} axisLine={false} width={150} />
                <ReferenceLine x={0} stroke={HUE.muted} />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(v: any, _n: any, item: any) => [`${(v as number) > 0 ? '+' : ''}${fmt(v as number)} · ${item?.payload?.favorable ? 'favourable' : 'unfavourable'}`, 'Variance']}
                />
                <Bar dataKey="diff" radius={4} isAnimationActive={false}>
                  {byAccount.map(d => <Cell key={d.label} fill={d.favorable ? FAVORABLE : UNFAVORABLE} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      </div>

      <div className="overflow-x-auto rounded-card border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="sticky left-0 z-10 min-w-[14rem] bg-muted px-3 py-2 text-left font-medium">Account</th>
              {data.periods.map(p => (
                <th key={p.key} className="min-w-[8rem] px-3 py-2 text-right font-medium">
                  <div>{p.label}</div>
                  <div className="text-xs font-normal text-muted-foreground">
                    {p.months.length === 0 ? 'Not compared' : p.partial ? `${p.months.length} mo compared` : `${baseLabel} → ${compareLabel}`}
                  </div>
                </th>
              ))}
              <th className="min-w-[8rem] px-3 py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {(['income', 'expense'] as const).map(type => (
              <VarianceGroup key={type} label={type === 'income' ? 'Revenue' : 'Expenses'} data={data} type={type} fmt={fmt}
                total={type === 'income' ? data.revenue : data.expenses} grand={type === 'income' ? data.totals.revenue : data.totals.expenses} />
            ))}
            <tr className="border-b bg-muted/30">
              <td className="sticky left-0 z-10 bg-card px-3 py-2 font-semibold">Net income</td>
              {data.netIncome.map((c, i) => <VCell key={i} c={c} fmt={fmt} strong />)}
              <VCell c={data.totals.netIncome} fmt={fmt} strong />
            </tr>
            <tr className="border-b">
              <td className="sticky left-0 z-10 bg-card px-3 py-2 font-medium">Ending cash</td>
              {data.endingCash.map((c, i) => <VCell key={i} c={c} fmt={fmt} />)}
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Difference is {compareLabel.toLowerCase()} minus {baseLabel.toLowerCase()}; green is favourable (revenue above, expense below), red unfavourable.
        Percentages are recomputed from summed dollars. * = only some months of the period have actuals.
      </p>
    </div>
  )
}

function VarianceGroup({ label, data, type, fmt, total, grand }: {
  label: string
  data: VarianceResponse
  type: 'income' | 'expense'
  fmt: Fmt
  total: (VarianceCell | null)[]
  grand: VarianceCell | null
}) {
  return (
    <>
      <tr className="border-b">
        <td className="sticky left-0 z-10 bg-card px-3 pt-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</td>
        <td colSpan={data.periods.length + 1} />
      </tr>
      {data.lines.filter(l => l.type === type).map(l => (
        <tr key={l.accountId} className="border-b hover:bg-accent/40">
          <td className="sticky left-0 z-10 bg-card px-3 py-2"><span className="font-mono text-xs text-muted-foreground">{l.code}</span> {l.name}</td>
          {l.cells.map((c, i) => <VCell key={i} c={c} fmt={fmt} />)}
          <VCell c={l.total} fmt={fmt} />
        </tr>
      ))}
      <tr className="border-b">
        <td className="sticky left-0 z-10 bg-card px-3 py-2 font-medium">Total {label.toLowerCase()}</td>
        {total.map((c, i) => <VCell key={i} c={c} fmt={fmt} />)}
        <VCell c={grand} fmt={fmt} />
      </tr>
    </>
  )
}

function VCell({ c, fmt, strong }: { c: VarianceCell | null; fmt: Fmt; strong?: boolean }) {
  return (
    <td className={cn('px-3 py-2 text-right tabular-nums', strong && 'font-semibold')} title={c ? `${fmt(c.base)} → ${fmt(c.compare)}` : undefined}>
      <div><Diff c={c} fmt={fmt} /></div>
      {c && <div className="text-xs text-muted-foreground">{pct(c)}</div>}
    </td>
  )
}
