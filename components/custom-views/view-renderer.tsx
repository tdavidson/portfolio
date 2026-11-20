'use client'

/**
 * Draws a custom view's payload (lib/custom-views/resolve.ts) with the app's own pieces: Metric
 * tiles, the shared chart primitives and the table. It never queries: every block arrives already
 * loaded as the viewer, or marked as not available to them.
 */

import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, XAxis, YAxis } from 'recharts'
import { Metric } from '@/components/ui/metric'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { ChartCard, EmptyPlot, HUE } from '@/components/fund-chart-kit'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatCurrencyAxis, formatCurrencyFull } from '@/components/currency-context'
import { cn } from '@/lib/utils'
import type { CustomBlock, CustomValueFormat, CustomViewPayload } from '@/lib/mcp-apps/payload'

const SPAN: Record<number, string> = {
  3: 'md:col-span-3',
  4: 'md:col-span-4',
  6: 'md:col-span-6',
  8: 'md:col-span-8',
  12: 'md:col-span-12',
}

function formatValue(v: number | string | null | undefined, format: CustomValueFormat | undefined, currency: string): string {
  if (v == null || v === '') return '—'
  if (typeof v === 'string') {
    if (format === 'date' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
      return new Date(`${v.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    }
    return v
  }
  // Negatives in accounting parentheses everywhere, as every figure in the app is.
  const paren = (s: string) => (v < 0 ? `(${s})` : s)
  switch (format) {
    case 'currency': return formatCurrencyFull(v, currency)
    case 'percent': return paren(`${Math.abs(v).toFixed(1)}%`)
    case 'multiple': return `${v.toFixed(2)}x`
    case 'text': return String(v)
    default: return paren(Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 }))
  }
}

function axisFormatter(format: CustomValueFormat | undefined, currency: string) {
  return (v: number) => (format === 'currency' ? formatCurrencyAxis(v, currency) : formatValue(v, format, currency))
}

function Unavailable({ block }: { block: CustomBlock }) {
  return (
    <div className="rounded-card border border-dashed bg-card p-4">
      <p className="text-sm font-medium">{block.label || 'Block'}</p>
      <p className={cn('mt-1 text-sm', block.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
        {block.message ?? 'Not available.'}
      </p>
    </div>
  )
}

function ChartBlock({ block, currency }: { block: CustomBlock; currency: string }) {
  const points = block.points ?? []
  const fmt = (v: number) => formatValue(v, block.format, currency)
  const tick = axisFormatter(block.format, currency)
  if (points.length === 0) return <ChartCard title={block.label}><EmptyPlot label="Nothing to chart." /></ChartCard>
  if (block.type === 'bar') {
    // Horizontal bars: category labels read in full, and one series takes one colour.
    const height = Math.max(160, Math.min(points.length, 30) * 28 + 24)
    return (
      <ChartCard title={block.label}>
        <ChartContainer height={height}>
          <BarChart data={points} layout="vertical" margin={{ top: 4, right: 12, bottom: 0, left: 4 }}>
            <CartesianGrid horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 11 }} className="tabular-nums" tickLine={false} axisLine={false} tickFormatter={tick} />
            <YAxis type="category" dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={120} interval={0} />
            <ChartTooltip formatter={(val: any) => [fmt(val as number), block.label]} content={<ChartTooltipContent />} />
            <Bar dataKey="value" radius={2} isAnimationActive={false}>
              {points.map((p, i) => <Cell key={i} fill={p.value < 0 ? 'hsl(var(--destructive))' : HUE.chart1} />)}
            </Bar>
          </BarChart>
        </ChartContainer>
      </ChartCard>
    )
  }
  return (
    <ChartCard title={block.label}>
      <ChartContainer height={220}>
        <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} className="tabular-nums" tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 11 }} className="tabular-nums" tickLine={false} axisLine={false} width={64} tickFormatter={tick} />
          <ChartTooltip formatter={(val: any) => [fmt(val as number), block.label]} content={<ChartTooltipContent />} />
          <Line type="monotone" dataKey="value" stroke={HUE.chart1} strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ChartContainer>
    </ChartCard>
  )
}

function TableBlock({ block, currency }: { block: CustomBlock; currency: string }) {
  const columns = block.columns ?? []
  const rows = block.rows ?? []
  const numeric = (f: CustomValueFormat) => f !== 'text' && f !== 'date'
  return (
    <div className="rounded-card border bg-card">
      <p className="px-4 pt-4 pb-2 text-sm font-medium">{block.label}</p>
      {rows.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">No rows.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map(c => <TableHead key={c.key} className={cn(numeric(c.format) && 'text-right')}>{c.label}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={i}>
                  {columns.map(c => (
                    <TableCell key={c.key} className={cn(numeric(c.format) && 'text-right tabular-nums')}>
                      {formatValue(r[c.key], c.format, currency)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {block.truncated && <p className="px-4 pb-3 text-caption text-muted-foreground">Showing the first rows only.</p>}
    </div>
  )
}

function Block({ block, currency }: { block: CustomBlock; currency: string }) {
  if (block.status !== 'ok') return <Unavailable block={block} />
  switch (block.type) {
    case 'kpi':
      return <Metric label={block.label} value={formatValue(block.value, block.format, currency)} sub={block.sub} />
    case 'bar':
    case 'line':
      return <ChartBlock block={block} currency={currency} />
    case 'table':
      return <TableBlock block={block} currency={currency} />
    case 'text':
      return (
        <div className="space-y-2 py-1">
          {block.label && <p className="text-sm font-medium">{block.label}</p>}
          {String(block.text ?? '').split(/\n\s*\n/).map((p, i) => (
            <p key={i} className="text-sm text-muted-foreground whitespace-pre-line">{p}</p>
          ))}
        </div>
      )
  }
}

export function CustomViewRenderer({ payload }: { payload: CustomViewPayload }) {
  const currency = payload.branding.currency || 'USD'
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
      {payload.data.blocks.map(b => (
        <div key={b.id} className={cn('min-w-0', SPAN[b.span] ?? 'md:col-span-12')}>
          <Block block={b} currency={currency} />
        </div>
      ))}
    </div>
  )
}
