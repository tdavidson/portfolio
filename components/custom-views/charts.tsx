'use client'

/**
 * The chart blocks of a custom view, on the shared chart primitives (components/ui/chart.tsx).
 * One component per chart type; each takes a block exactly as resolve.ts shaped it.
 *
 * Colour follows DESIGN.md: one measure takes one colour (the categorical first slot); a series
 * takes the categorical slots in order; a loss is the destructive colour.
 */

import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, LineChart, Pie, PieChart,
  Scatter, ScatterChart, XAxis, YAxis, ZAxis,
} from 'recharts'
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { ChartCard, EmptyPlot, HUE } from '@/components/fund-chart-kit'
import type { CustomBlock } from '@/lib/mcp-apps/payload'
import { axisFormatter, formatValue } from './format'

// The categorical palette: the same eight slots every theme defines.
const FILL = [1, 2, 3, 4, 5, 6, 7, 8].map(n => `hsl(var(--cat-${n}))`)
const fill = (i: number) => FILL[i] ?? HUE.muted
const LOSS = 'hsl(var(--destructive))'
const TICK = { fontSize: 11 }

type Props = { block: CustomBlock; currency: string }

function figures(block: CustomBlock, currency: string) {
  return {
    fmt: (v: number) => formatValue(v, block.format, currency),
    tick: axisFormatter(block.format, currency),
  }
}

const legend = <ChartLegend verticalAlign="top" align="left" content={<ChartLegendContent />} />

/** Rows Recharts can read: s0, s1… per series, so a series called "label" cannot collide. */
function seriesRows(block: CustomBlock) {
  const names = block.series ?? []
  return (block.points ?? []).map(p => {
    const row: Record<string, string | number> = { label: p.label, value: p.value }
    names.forEach((_, i) => { row[`s${i}`] = p.values?.[i] ?? 0 })
    return row
  })
}

function BarsChart({ block, currency, vertical }: Props & { vertical: boolean }) {
  const { fmt, tick } = figures(block, currency)
  const names = block.series ?? []
  const data = seriesRows(block)
  const stackId = block.stack === 'grouped' ? undefined : 'stack'
  const tooltip = <ChartTooltip formatter={(val: any, name: any) => [fmt(val as number), names.length ? name : block.label]} content={<ChartTooltipContent />} />
  const bars = names.length
    ? names.map((name, i) => (
      <Bar key={i} dataKey={`s${i}`} name={name} stackId={stackId} fill={fill(i)} stroke={stackId ? HUE.surface : undefined} strokeWidth={stackId ? 1 : 0} radius={stackId ? 0 : 2} isAnimationActive={false} />
    ))
    : (
      <Bar dataKey="value" name={block.label} radius={2} isAnimationActive={false}>
        {data.map((p, i) => <Cell key={i} fill={(p.value as number) < 0 ? LOSS : fill(0)} />)}
      </Bar>
    )
  if (vertical) {
    return (
      <ChartContainer height={names.length ? 280 : 250}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis tick={TICK} className="tabular-nums" tickLine={false} axisLine={false} width={64} tickFormatter={tick} />
          {tooltip}
          {names.length > 0 && legend}
          {bars}
        </BarChart>
      </ChartContainer>
    )
  }
  // Horizontal: category labels read in full. Grouped series need a taller row each.
  const rowHeight = names.length && !stackId ? Math.min(14 * names.length + 10, 60) : 28
  const height = Math.max(160, Math.min(data.length, 30) * rowHeight + (names.length ? 56 : 24))
  return (
    <ChartContainer height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, bottom: 0, left: 4 }}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" tick={TICK} className="tabular-nums" tickLine={false} axisLine={false} tickFormatter={tick} />
        <YAxis type="category" dataKey="label" tick={TICK} tickLine={false} axisLine={false} width={120} interval={0} />
        {tooltip}
        {names.length > 0 && legend}
        {bars}
      </BarChart>
    </ChartContainer>
  )
}

function LinesChart({ block, currency, area }: Props & { area: boolean }) {
  const { fmt, tick } = figures(block, currency)
  const names = block.series ?? []
  const data = seriesRows(block)
  const keys = names.length ? names.map((name, i) => ({ key: `s${i}`, name, color: fill(i) })) : [{ key: 'value', name: block.label, color: fill(0) }]
  const axes = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="label" tick={TICK} className="tabular-nums" tickLine={false} axisLine={false} interval="preserveStartEnd" />
      <YAxis tick={TICK} className="tabular-nums" tickLine={false} axisLine={false} width={64} tickFormatter={tick} />
      <ChartTooltip formatter={(val: any, name: any) => [fmt(val as number), name]} content={<ChartTooltipContent />} />
      {names.length > 0 && legend}
    </>
  )
  const margin = { top: 8, right: 8, bottom: 0, left: 8 }
  if (area) {
    return (
      <ChartContainer height={names.length ? 260 : 220}>
        <AreaChart data={data} margin={margin}>
          {axes}
          {keys.map(k => (
            <Area key={k.key} type="monotone" dataKey={k.key} name={k.name} stackId={names.length ? 'stack' : undefined} stroke={k.color} fill={k.color} fillOpacity={names.length ? 0.55 : 0.18} strokeWidth={2} isAnimationActive={false} />
          ))}
        </AreaChart>
      </ChartContainer>
    )
  }
  return (
    <ChartContainer height={names.length ? 260 : 220}>
      <LineChart data={data} margin={margin}>
        {axes}
        {keys.map(k => <Line key={k.key} type="monotone" dataKey={k.key} name={k.name} stroke={k.color} strokeWidth={2} dot={false} isAnimationActive={false} />)}
      </LineChart>
    </ChartContainer>
  )
}

function PieBlock({ block, currency }: Props) {
  const { fmt } = figures(block, currency)
  const data = (block.points ?? []).map(p => ({ name: p.label, value: p.value }))
  const total = data.reduce((s, d) => s + d.value, 0)
  return (
    <div className="grid items-center gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <ChartContainer height={220}>
        <PieChart>
          <ChartTooltip formatter={(val: any, name: any) => [`${fmt(val as number)} · ${total ? ((Number(val) / total) * 100).toFixed(1) : '0'}%`, name]} content={<ChartTooltipContent />} />
          <Pie data={data} dataKey="value" nameKey="name" innerRadius={block.donut ? '58%' : 0} outerRadius="92%" stroke={HUE.surface} strokeWidth={1} isAnimationActive={false}>
            {data.map((_, i) => <Cell key={i} fill={fill(i)} />)}
          </Pie>
        </PieChart>
      </ChartContainer>
      <ul className="space-y-1.5 text-sm">
        {data.map((d, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 flex-none rounded-sm" style={{ background: fill(i) }} />
            <span className="min-w-0 flex-1 truncate">{d.name}</span>
            <span className="tabular-nums text-muted-foreground">{total ? `${((d.value / total) * 100).toFixed(1)}%` : '—'}</span>
            <span className="w-24 text-right tabular-nums">{fmt(d.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ScatterBlock({ block, currency }: Props) {
  const fy = (v: number) => formatValue(v, block.format, currency)
  const fx = (v: number) => formatValue(v, block.xFormat, currency)
  const data = block.dots ?? []
  return (
    <ChartContainer height={260}>
      <ScatterChart margin={{ top: 8, right: 12, bottom: 4, left: 8 }}>
        <CartesianGrid />
        <XAxis type="number" dataKey="x" tick={TICK} className="tabular-nums" tickLine={false} axisLine={false} tickFormatter={axisFormatter(block.xFormat, currency)} />
        <YAxis type="number" dataKey="y" tick={TICK} className="tabular-nums" tickLine={false} axisLine={false} width={64} tickFormatter={axisFormatter(block.format, currency)} />
        <ZAxis range={[48, 48]} />
        <ChartTooltip
          cursor={false}
          content={({ active, payload }: any) => {
            const d = active && payload?.[0]?.payload
            if (!d) return null
            return (
              <div className="rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-sm">
                <p className="font-medium">{d.label}</p>
                <p className="tabular-nums text-muted-foreground">{fx(d.x)} · {fy(d.y)}</p>
              </div>
            )
          }}
        />
        <Scatter data={data} fill={fill(0)} fillOpacity={0.8} isAnimationActive={false} />
      </ScatterChart>
    </ChartContainer>
  )
}

function ComboBlock({ block, currency }: Props) {
  const { fmt, tick } = figures(block, currency)
  const fmt2 = (v: number) => formatValue(v, block.format2, currency)
  const data = (block.points ?? []).map(p => ({ label: p.label, value: p.value, value2: p.value2 ?? 0 }))
  const label2 = block.label2 ?? 'Line'
  return (
    <ChartContainer height={260}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" />
        <YAxis yAxisId="left" tick={TICK} className="tabular-nums" tickLine={false} axisLine={false} width={64} tickFormatter={tick} />
        <YAxis yAxisId="right" orientation="right" tick={TICK} className="tabular-nums" tickLine={false} axisLine={false} width={64} tickFormatter={axisFormatter(block.format2, currency)} />
        <ChartTooltip formatter={(val: any, name: any) => [name === label2 ? fmt2(val as number) : fmt(val as number), name]} content={<ChartTooltipContent />} />
        {legend}
        <Bar yAxisId="left" dataKey="value" name={block.label} fill={fill(0)} radius={2} isAnimationActive={false} />
        <Line yAxisId="right" type="monotone" dataKey="value2" name={label2} stroke={fill(1)} strokeWidth={2} dot={false} isAnimationActive={false} />
      </ComposedChart>
    </ChartContainer>
  )
}

/** Steps from the running total: an invisible base bar, then the change, then the total. */
export function waterfallRows(points: { label: string; value: number }[], total: boolean) {
  let running = 0
  const rows = points.map(p => {
    const start = running
    running += p.value
    return { label: p.label, base: Math.min(start, running), delta: Math.abs(p.value), value: p.value, kind: p.value < 0 ? 'down' : 'up' }
  })
  if (total) rows.push({ label: 'Total', base: Math.min(0, running), delta: Math.abs(running), value: running, kind: 'total' })
  return rows
}

function WaterfallBlock({ block, currency }: Props) {
  const { fmt, tick } = figures(block, currency)
  const data = waterfallRows(block.points ?? [], block.total !== false)
  return (
    <ChartContainer height={260}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval={0} />
        <YAxis tick={TICK} className="tabular-nums" tickLine={false} axisLine={false} width={64} tickFormatter={tick} />
        <ChartTooltip
          formatter={(_val: any, _name: any, item: any) => [fmt(item?.payload?.value ?? 0), item?.payload?.kind === 'total' ? 'Total' : 'Change']}
          content={<ChartTooltipContent />}
        />
        <Bar dataKey="base" stackId="w" fill="transparent" tooltipType="none" isAnimationActive={false} />
        <Bar dataKey="delta" name="delta" stackId="w" radius={2} isAnimationActive={false}>
          {data.map((d, i) => <Cell key={i} fill={d.kind === 'total' ? HUE.ink : d.kind === 'down' ? LOSS : fill(0)} />)}
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}

function FunnelBlock({ block, currency }: Props) {
  const { fmt } = figures(block, currency)
  const points = block.points ?? []
  const max = Math.max(0, ...points.map(p => p.value))
  const first = points[0]?.value ?? 0
  return (
    <div className="space-y-1.5">
      {points.map((p, i) => {
        const width = max > 0 ? Math.max(2, (Math.max(0, p.value) / max) * 100) : 0
        return (
          <div key={i} className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm">
            <span className="truncate">{p.label}</span>
            <div className="flex justify-center">
              <div className="h-6 rounded-sm" style={{ width: `${width}%`, background: fill(0), opacity: 1 - Math.min(i, 6) * 0.1 }} />
            </div>
            <span className="w-28 text-right tabular-nums">
              {fmt(p.value)}
              {i > 0 && first > 0 && <span className="ml-1.5 text-caption text-muted-foreground">{((p.value / first) * 100).toFixed(0)}%</span>}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** Any chart block. */
export function CustomChart({ block, currency }: Props) {
  const empty = block.type === 'scatter' ? (block.dots ?? []).length === 0 : (block.points ?? []).length === 0
  let body: React.ReactNode
  if (empty) body = <EmptyPlot label="Nothing to chart." />
  else switch (block.type) {
    case 'bar': body = <BarsChart block={block} currency={currency} vertical={false} />; break
    case 'column': body = <BarsChart block={block} currency={currency} vertical />; break
    case 'line': body = <LinesChart block={block} currency={currency} area={false} />; break
    case 'area': body = <LinesChart block={block} currency={currency} area />; break
    case 'pie': body = <PieBlock block={block} currency={currency} />; break
    case 'scatter': body = <ScatterBlock block={block} currency={currency} />; break
    case 'combo': body = <ComboBlock block={block} currency={currency} />; break
    case 'waterfall': body = <WaterfallBlock block={block} currency={currency} />; break
    case 'funnel': body = <FunnelBlock block={block} currency={currency} />; break
    default: body = null
  }
  return <ChartCard title={block.label}>{body}</ChartCard>
}
