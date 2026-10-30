'use client'

import { useMemo, useState } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, ArrowLeftRight, Download } from 'lucide-react'
import type { ActivityKind, ActivityLine } from '@/lib/portal/activity'
import { Metric } from '@/components/ui/metric'
import { toCsv } from '@/lib/accounting/csv'

export interface ActivityViewData {
  currency: string
  lines: ActivityLine[]
  /** More than one of the investor's own entities has activity: show which one each line is. */
  multipleEntities: boolean
}

type Filter = 'all' | 'calls' | 'distributions' | 'transfers'
const FILTERS: { value: Filter; label: string; kinds: ActivityKind[] }[] = [
  { value: 'all', label: 'All', kinds: [] },
  { value: 'calls', label: 'Capital calls', kinds: ['contribution', 'reinvestment'] },
  { value: 'distributions', label: 'Distributions', kinds: ['distribution'] },
  { value: 'transfers', label: 'Transfers', kinds: ['transfer_in', 'transfer_out', 'secondary_purchase', 'secondary_sale'] },
]

/** Money in to the fund from the investor's side. */
const PAID_IN: ActivityKind[] = ['contribution', 'reinvestment']
const RECEIVED: ActivityKind[] = ['distribution']

function money(v: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format(v)
  } catch {
    return `${currency} ${v.toFixed(2)}`
  }
}
function fmtDate(s: string | null | undefined): string {
  if (!s) return ''
  const d = new Date(s.length <= 10 ? `${s}T00:00:00` : s)
  return isNaN(d.getTime()) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function KindIcon({ kind }: { kind: ActivityKind }) {
  const cls = 'h-4 w-4 shrink-0 text-muted-foreground'
  if (PAID_IN.includes(kind)) return <ArrowUpFromLine className={cls} aria-hidden />
  if (RECEIVED.includes(kind)) return <ArrowDownToLine className={cls} aria-hidden />
  return <ArrowLeftRight className={cls} aria-hidden />
}

/**
 * LP-portal Activity: each of the investor's own capital movements, newest first, with a filter by
 * kind and vehicle and a CSV download of what is shown. Presentational only.
 */
export function ActivityView({ data }: { data: ActivityViewData }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [vehicle, setVehicle] = useState<string>('')
  const currency = data.currency || 'USD'
  const vehicles = useMemo(() => Array.from(new Set(data.lines.map(l => l.vehicle))).sort(), [data.lines])

  const shown = useMemo(() => {
    const kinds = FILTERS.find(f => f.value === filter)!.kinds
    return data.lines.filter(l => (kinds.length === 0 || kinds.includes(l.kind)) && (!vehicle || l.vehicle === vehicle))
  }, [data.lines, filter, vehicle])

  const paidIn = shown.filter(l => PAID_IN.includes(l.kind)).reduce((s, l) => s + l.amount, 0)
  const received = shown.filter(l => RECEIVED.includes(l.kind)).reduce((s, l) => s + l.amount, 0)
  const hasQuarterly = shown.some(l => l.detail === 'quarterly')

  function download() {
    const header = ['Date', 'Activity', 'Vehicle', ...(data.multipleEntities ? ['Account'] : []), 'Amount', 'Basis']
    const rows = shown.map(l => [
      l.date, l.label, l.vehicle, ...(data.multipleEntities ? [l.entityName] : []), l.amount,
      l.detail === 'quarterly' ? `Change since ${l.since}` : 'Transaction',
    ])
    const blob = new Blob([toCsv([header, ...rows])], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'activity.csv'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Your capital calls, distributions and transfers, newest first.</p>
      </div>

      {data.lines.length === 0 ? (
        <div className="rounded-card border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">No activity has been shared with you yet.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Metric label="Paid in" value={money(paidIn, currency)} sub="Capital calls shown below" />
            <Metric label="Received" value={money(received, currency)} sub="Distributions shown below" />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border bg-card p-0.5" role="tablist" aria-label="Activity type">
              {FILTERS.map(f => (
                <button
                  key={f.value}
                  role="tab"
                  aria-selected={filter === f.value}
                  onClick={() => setFilter(f.value)}
                  className={`rounded-md px-3 py-1.5 text-sm ${filter === f.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            {vehicles.length > 1 && (
              <select
                value={vehicle}
                onChange={e => setVehicle(e.target.value)}
                aria-label="Vehicle"
                className="h-9 rounded-lg border bg-card px-3 text-sm"
              >
                <option value="">All vehicles</option>
                {vehicles.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            )}
            <button onClick={download} className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg border bg-card px-3 text-sm hover:bg-muted">
              <Download className="h-4 w-4" /> Download CSV
            </button>
          </div>

          <div className="rounded-card border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="hidden sm:table-cell px-4 py-2.5 font-medium">Date</th>
                  <th className="px-4 py-2.5 font-medium">Activity</th>
                  <th className="hidden sm:table-cell px-4 py-2.5 font-medium">Vehicle</th>
                  {data.multipleEntities && <th className="hidden sm:table-cell px-4 py-2.5 font-medium">Account</th>}
                  <th className="px-4 py-2.5 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(l => (
                  <tr key={`${l.vehicle}|${l.entityId}|${l.date}|${l.kind}`} className="border-b last:border-0">
                    <td className="hidden sm:table-cell px-4 py-3 whitespace-nowrap tabular-nums text-muted-foreground align-top">{fmtDate(l.date)}</td>
                    <td className="px-4 py-3 align-top">
                      <div className="flex items-center gap-2">
                        <KindIcon kind={l.kind} />
                        <span className="font-medium">{l.label}</span>
                      </div>
                      {l.detail === 'quarterly' && (
                        <div className="ml-6 text-xs text-muted-foreground">Quarterly change since {fmtDate(l.since)}</div>
                      )}
                      <div className="ml-6 text-xs text-muted-foreground sm:hidden">
                        <span className="tabular-nums">{fmtDate(l.date)}</span> · {l.vehicle}
                        {data.multipleEntities ? <> · {l.entityName}</> : null}
                      </div>
                    </td>
                    <td className="hidden sm:table-cell px-4 py-3 align-top">{l.vehicle}</td>
                    {data.multipleEntities && <td className="hidden sm:table-cell px-4 py-3 align-top text-muted-foreground">{l.entityName}</td>}
                    <td className="px-4 py-3 text-right tabular-nums font-medium align-top whitespace-nowrap">{money(l.amount, currency)}</td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">Nothing matches this filter.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {hasQuarterly && (
            <p className="text-xs text-muted-foreground">
              Where your fund reports quarter-end figures rather than individual transactions, a line shows the change in
              capital called or distributed since the previous statement.
            </p>
          )}
        </>
      )}
    </div>
  )
}
