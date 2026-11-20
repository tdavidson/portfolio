'use client'

/**
 * Draws a custom view's payload (lib/custom-views/resolve.ts) with the app's own pieces: Metric
 * tiles, the shared chart primitives and the table. It never queries: every block arrives already
 * loaded as the viewer, or marked as not available to them.
 */

import { Metric } from '@/components/ui/metric'
import { CustomChart } from './charts'
import { formatValue } from './format'
import { kpiDelta } from '@/lib/custom-views/delta'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import type { CustomBlock, CustomValueFormat, CustomViewPayload } from '@/lib/mcp-apps/payload'

const SPAN: Record<number, string> = {
  3: 'md:col-span-3',
  4: 'md:col-span-4',
  6: 'md:col-span-6',
  8: 'md:col-span-8',
  12: 'md:col-span-12',
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
              {block.totalsRow && (
                <TableRow className="border-t-2 font-medium hover:bg-transparent">
                  {columns.map((c, j) => (
                    <TableCell key={c.key} className={cn(numeric(c.format) && 'text-right tabular-nums')}>
                      {block.totalsRow![c.key] != null ? formatValue(block.totalsRow![c.key], c.format, currency) : j === 0 ? 'Total' : ''}
                    </TableCell>
                  ))}
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
      {block.truncated && <p className="px-4 pb-3 text-caption text-muted-foreground">Showing the first rows only.</p>}
    </div>
  )
}

function PivotTable({ block, currency }: { block: CustomBlock; currency: string }) {
  const p = block.pivot
  const fmt = (v: number | null | undefined) => formatValue(v ?? null, block.format, currency)
  return (
    <div className="rounded-card border bg-card">
      <p className="px-4 pt-4 pb-2 text-sm font-medium">{block.label}</p>
      {!p || p.rows.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">No rows.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{p.rowLabel}</TableHead>
                {p.columns.map(c => <TableHead key={c} className="text-right">{c}</TableHead>)}
                {p.rowTotals && <TableHead className="text-right">Total</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {p.rows.map((r, i) => (
                <TableRow key={r}>
                  <TableCell>{r}</TableCell>
                  {p.cells[i].map((v, j) => <TableCell key={j} className="text-right tabular-nums">{fmt(v)}</TableCell>)}
                  {p.rowTotals && <TableCell className="text-right font-medium tabular-nums">{fmt(p.rowTotals[i])}</TableCell>}
                </TableRow>
              ))}
              {p.columnTotals && (
                <TableRow className="border-t-2 font-medium hover:bg-transparent">
                  <TableCell>Total</TableCell>
                  {p.columnTotals.map((v, j) => <TableCell key={j} className="text-right tabular-nums">{fmt(v)}</TableCell>)}
                  {p.rowTotals && <TableCell className="text-right tabular-nums">{fmt(p.grandTotal)}</TableCell>}
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

function KpiTile({ block, currency }: { block: CustomBlock; currency: string }) {
  const delta = kpiDelta(block.value, block.previous, block.format, v => formatValue(v, block.format, currency))
  const sub = delta || block.previousLabel ? (
    <>
      {delta && (
        <span className={cn('tabular-nums', delta.direction === 'up' ? 'text-success' : delta.direction === 'down' ? 'text-destructive' : '')}>
          {delta.text}
        </span>
      )}
      {block.previousLabel && <span> {delta ? block.previousLabel : `No figure ${block.previousLabel.replace(/^vs /, 'for ')}`}</span>}
      {block.sub && <span className="block">{block.sub}</span>}
    </>
  ) : block.sub
  return <Metric label={block.label} value={formatValue(block.value, block.format, currency)} sub={sub} />
}

function Block({ block, currency }: { block: CustomBlock; currency: string }) {
  if (block.status !== 'ok') return <Unavailable block={block} />
  switch (block.type) {
    case 'kpi':
      return <KpiTile block={block} currency={currency} />
    case 'pivot':
      return <PivotTable block={block} currency={currency} />
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
    default:
      return <CustomChart block={block} currency={currency} />
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
