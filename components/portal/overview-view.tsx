'use client'

import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import type { OverviewMetrics, OverviewTotals, OverviewVehicle } from '@/lib/lp-overview'
import { Metric as MetricBox } from '@/components/ui/metric'

export interface OverviewViewData extends Partial<OverviewMetrics> {
  investorName?: string | null
  currency?: string
  hasData: boolean
}

function fmtMoney(v: number | null, currency: string): string {
  if (v == null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(v || 0)
}
function fmtMultiple(v: number | null | undefined): string {
  return v == null ? '—' : `${v.toFixed(2)}x`
}
function fmtPct(v: number | null | undefined): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`
}
function fmtDate(s: string | null | undefined): string {
  if (!s) return ''
  const d = new Date(s.length <= 10 ? `${s}T00:00:00` : s)
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

/**
 * LP-portal overview dashboard: greeting, headline totals (Committed / Called /
 * Distributed / NAV) and a card per investment vehicle. Presentational only —
 * the live portal and the GP preview both feed it the same shape.
 */
export function OverviewView({ data }: { data: OverviewViewData }) {
  const currency = data.currency || 'USD'
  const name = (data.investorName ?? '').trim()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{name ? `Welcome, ${name}` : 'Your portfolio'}</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {data.hasData
            ? `Your position across all vehicles${data.asOfDate ? `, as of ${fmtDate(data.asOfDate)}` : ''}.`
            : 'A summary of your investments will appear here once your fund publishes figures.'}
        </p>
      </div>

      {!data.hasData || !data.totals ? (
        <div className="rounded-card border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">No performance figures have been shared with you yet.</p>
          <Link href="/portal/snapshots" className="mt-3 inline-flex items-center gap-1 text-sm text-primary hover:underline">
            Browse your documents <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      ) : (
        <>
          {/* Headline totals */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricBox label="Committed" value={fmtMoney(data.totals.commitment, currency)} />
            <MetricBox label="Called" value={fmtMoney(data.totals.called, currency)} />
            <MetricBox label="Distributed" value={fmtMoney(data.totals.distributed, currency)} />
            <MetricBox
              label="Net asset value"
              value={fmtMoney(data.totals.nav, currency)}
              sub={data.totals.tvpi != null ? `${fmtMultiple(data.totals.tvpi)} TVPI · ${fmtMultiple(data.totals.dpi)} DPI` : undefined}
            />
          </div>

          {/* Per-vehicle */}
          {(data.vehicles?.length ?? 0) > 0 && (
            <section className="space-y-3">
              <h2 className="text-base font-semibold">By investment vehicle</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {data.vehicles!.map((v: OverviewVehicle) => (
                  <div key={v.name} className="rounded-card border bg-card p-4">
                    <div className="flex items-baseline justify-between gap-2">
                      <h3 className="font-medium truncate">{v.name}</h3>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {fmtMultiple(v.tvpi)} TVPI
                        {v.irr !== undefined && (
                          <span title={v.irr == null ? 'No IRR yet: it is shown from a year after your first contribution, for one account per vehicle.' : 'Annualized.'}>
                            {' · '}{fmtPct(v.irr)} IRR
                          </span>
                        )}
                      </span>
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                      <Row label="Committed" value={fmtMoney(v.commitment, currency)} />
                      <Row label="Called" value={fmtMoney(v.called, currency)} />
                      <Row label="Distributed" value={fmtMoney(v.distributed, currency)} />
                      <Row label="NAV" value={fmtMoney(v.nav, currency)} />
                    </dl>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular-nums font-medium">{value}</dd>
    </div>
  )
}

// Re-export the totals type for consumers that want to type their data.
export type { OverviewTotals }
