'use client'

// Statement review for one vehicle (lib/statement-review, docs/spec/statement-review.md): run the
// tie-out checks on an administrator's package, and read each period's findings with their citations.
// Nothing here changes a figure: a review reports, it doesn't correct.

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Ban, Check, Info, Loader2, Minus, Upload } from 'lucide-react'
import { useCurrency, formatCurrencyPrice } from '@/components/currency-context'
import { useLedgerFetch, useVehicle } from '@/components/accounting-vehicle'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/empty-state'
import { CHECK_LABELS, type CheckOutcome, type Finding, type Severity } from '@/lib/statement-review/types'

interface Summary {
  id: string; periodStart: string; periodEnd: string; input: 'admin_pull' | 'csv' | 'package'
  counts: Record<Severity, number>; partners: number; runAt: string; current: boolean
}
interface Review extends Summary {
  checks: CheckOutcome[]; findings: Finding[]
  materiality: { amount: number; navShare: number }; threshold: number; nav: number | null
}
interface Pull { id: string; asOf: string; source: string; status: 'saved' | 'superseded' }

const SEVERITY: Record<Severity, { Icon: typeof Ban; cls: string; label: string }> = {
  error: { Icon: Ban, cls: 'text-destructive', label: 'Error' },
  warning: { Icon: AlertTriangle, cls: 'text-warning', label: 'Warning' },
  info: { Icon: Info, cls: 'text-muted-foreground', label: 'Info' },
}
const INPUT_LABEL: Record<Summary['input'], string> = { admin_pull: 'Administrator pull', csv: 'CSV', package: 'Package' }

export function ReviewView() {
  const { group } = useVehicle()
  return <VehicleReview key={group} />
}

function VehicleReview() {
  const lf = useLedgerFetch()
  const currency = useCurrency()
  const money = (v: number | undefined) => (v == null ? '—' : formatCurrencyPrice(v, currency))

  const [reviews, setReviews] = useState<Summary[] | null>(null)
  const [pulls, setPulls] = useState<Pull[]>([])
  const [selected, setSelected] = useState<Review | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<Severity | 'all'>('all')
  // Run inputs.
  const [mode, setMode] = useState<'admin_pull' | 'csv'>('csv')
  const [periodEnd, setPeriodEnd] = useState('')
  const [pullId, setPullId] = useState('')
  const [csv, setCsv] = useState<string | null>(null)
  const [csvName, setCsvName] = useState('')
  const [amount, setAmount] = useState('')
  const [navShare, setNavShare] = useState('')

  const open = useCallback(async (id: string) => {
    const res = await lf(`/api/accounting/statement-review?id=${encodeURIComponent(id)}`)
    const d = await res.json().catch(() => ({}))
    if (res.ok) { setSelected(d); setFilter('all') } else setError(d.error ?? 'Could not open the review.')
  }, [lf])

  // `openLatest`: open the latest period's review once the list is in (the first load only; after a
  // run, the review just run stays open).
  const load = useCallback(async (openLatest: boolean) => {
    const [r, p] = await Promise.all([
      lf('/api/accounting/statement-review').then(x => (x.ok ? x.json() : null)).catch(() => null),
      lf('/api/accounting/admin-figures').then(x => (x.ok ? x.json() : null)).catch(() => null),
    ])
    const list: Summary[] = r?.reviews ?? []
    setReviews(list)
    const saved: Pull[] = (p?.recordSource === 'admin' ? p.pulls ?? [] : []).filter((x: Pull) => x.status === 'saved')
    setPulls(saved)
    if (openLatest && saved.length) { setMode('admin_pull'); setPullId(saved[0].id) }
    const first = list.find(x => x.current)
    if (openLatest && first) open(first.id)
  }, [lf, open])
  useEffect(() => { load(true) }, [load])

  async function run() {
    setBusy(true); setError(null)
    try {
      const materiality = amount || navShare ? { amount: amount || undefined, nav_share: navShare || undefined } : undefined
      const body = mode === 'admin_pull'
        ? { input: 'admin_pull', pull_id: pullId, materiality }
        : { input: 'csv', csv, file_name: csvName, period_end: periodEnd, materiality }
      const res = await lf('/api/accounting/statement-review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error ?? 'The review could not run.'); return }
      setSelected(d); setFilter('all')
      await load(false)
    } finally { setBusy(false) }
  }

  if (reviews === null) return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>

  const canRun = mode === 'admin_pull' ? !!pullId : !!csv && !!periodEnd
  const shown = selected ? selected.findings.filter(f => filter === 'all' || f.severity === filter) : []

  return (
    <div className="space-y-6">
      <section className="rounded-card border p-4 space-y-3">
        <div>
          <h2 className="text-base font-medium">Run a review</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Checks that the statements foot, that the partners add up to the fund, that each capital account rolls forward,
            that this period carries on from the last review, and that every partner is there. The figures themselves are never changed.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted-foreground space-y-1">
            <span className="block">Figures from</span>
            <select value={mode} onChange={e => setMode(e.target.value as typeof mode)} className="h-9 rounded-md border border-input bg-background px-2 text-sm">
              {pulls.length > 0 && <option value="admin_pull">A saved administrator pull</option>}
              <option value="csv">A partner capital schedule (CSV)</option>
            </select>
          </label>
          {mode === 'admin_pull' ? (
            <label className="text-xs text-muted-foreground space-y-1">
              <span className="block">Pull</span>
              <select value={pullId} onChange={e => setPullId(e.target.value)} className="h-9 rounded-md border border-input bg-background px-2 text-sm tabular-nums">
                {pulls.map(p => <option key={p.id} value={p.id}>{p.asOf} · {p.source}</option>)}
              </select>
            </label>
          ) : (
            <>
              <label className="text-xs text-muted-foreground space-y-1">
                <span className="block">Period end</span>
                <Input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} className="h-9 w-40" />
              </label>
              <label className="inline-flex h-9 cursor-pointer items-center gap-1 rounded-md border border-input px-3 text-sm">
                <Upload className="h-4 w-4" /> {csvName || 'Choose CSV'}
                <input type="file" accept=".csv,text/csv,text/tab-separated-values" className="sr-only" onChange={async e => {
                  const f = e.target.files?.[0]
                  if (!f) return
                  setCsvName(f.name); setCsv(await f.text())
                }} />
              </label>
            </>
          )}
          <label className="text-xs text-muted-foreground space-y-1">
            <span className="block">Materiality (amount)</span>
            <Input value={amount} onChange={e => setAmount(e.target.value)} placeholder={selected ? String(selected.materiality.amount) : '0'} className="h-9 w-32 tabular-nums" />
          </label>
          <label className="text-xs text-muted-foreground space-y-1">
            <span className="block">or share of NAV</span>
            <Input value={navShare} onChange={e => setNavShare(e.target.value)} placeholder={selected ? `${(selected.materiality.navShare * 100).toFixed(2)}%` : '0.1%'} className="h-9 w-24 tabular-nums" />
          </label>
          <Button size="sm" onClick={run} disabled={busy || !canRun}>
            {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null} Run checks
          </Button>
        </div>
        {mode === 'csv' && (
          <p className="text-xs text-muted-foreground">
            One row per partner, with columns such as Name, Commitment, Beginning capital, Contributions, Distributions, Income,
            Expenses, Management fee, Realized gain, Unrealized gain, Carried interest, Ending capital and Unfunded. Allocations are
            signed as they change the account, so expenses are negative. A Total row is checked against the partners.
          </p>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </section>

      {reviews.length === 0 ? (
        <EmptyState>No reviews yet. Run the checks on this period&apos;s package above to see what ties out and what to ask the administrator.</EmptyState>
      ) : (
        <section className="rounded-card border p-4 space-y-2">
          <h2 className="text-base font-medium">Periods</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="text-left font-normal py-1">Period</th>
                  <th className="text-left font-normal">From</th>
                  <th className="text-right font-normal">Partners</th>
                  <th className="text-right font-normal">Errors</th>
                  <th className="text-right font-normal">Warnings</th>
                  <th className="text-right font-normal">Info</th>
                  <th className="text-left font-normal pl-3">Run</th>
                </tr>
              </thead>
              <tbody>
                {reviews.map(r => (
                  <tr key={r.id} onClick={() => open(r.id)}
                    className={`border-t cursor-pointer hover:bg-muted/50 ${selected?.id === r.id ? 'bg-muted/50' : ''} ${r.current ? '' : 'text-muted-foreground'}`}>
                    <td className="py-1 tabular-nums">{r.periodEnd}{r.current ? '' : ' (earlier run)'}</td>
                    <td>{INPUT_LABEL[r.input]}</td>
                    <td className="text-right tabular-nums">{r.partners}</td>
                    <td className={`text-right tabular-nums ${r.counts.error ? 'text-destructive' : ''}`}>{r.counts.error}</td>
                    <td className={`text-right tabular-nums ${r.counts.warning ? 'text-warning' : ''}`}>{r.counts.warning}</td>
                    <td className="text-right tabular-nums">{r.counts.info}</td>
                    <td className="pl-3 tabular-nums text-muted-foreground">{r.runAt.slice(0, 16).replace('T', ' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {selected && (
        <section className="rounded-card border p-4 space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-medium">
              <span className="tabular-nums">{selected.periodStart} to {selected.periodEnd}</span>
            </h2>
            <p className="text-xs text-muted-foreground">
              Materiality {money(selected.threshold)}{selected.nav != null ? ` against NAV of ${money(selected.nav)}` : ''}. Differences of a cent or less are rounding.
            </p>
          </div>

          <ul className="grid gap-1 sm:grid-cols-2">
            {selected.checks.map(c => {
              const n = selected.findings.filter(f => f.check === c.check && f.severity !== 'info').length
              return (
                <li key={c.check} className="flex items-start gap-2 text-sm">
                  {!c.ran ? <Minus className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                    : n ? <AlertTriangle className="h-4 w-4 mt-0.5 text-warning shrink-0" />
                    : <Check className="h-4 w-4 mt-0.5 text-success shrink-0" />}
                  <span>
                    <span className="font-medium">{CHECK_LABELS[c.check]}</span>
                    <span className="text-muted-foreground">
                      {c.ran ? ` · ${c.compared} compared${n ? `, ${n} to look at` : ''}` : ' · not run'}
                    </span>
                    {c.note && <span className="block text-xs text-muted-foreground">{c.note}</span>}
                  </span>
                </li>
              )
            })}
          </ul>

          {selected.findings.length === 0 ? (
            <p className="text-sm text-muted-foreground">No findings: everything the checks could compare ties out.</p>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1">
                {(['all', 'error', 'warning', 'info'] as const).map(s => (
                  <Button key={s} size="sm" variant={filter === s ? 'secondary' : 'ghost'} onClick={() => setFilter(s)}>
                    {s === 'all' ? `All (${selected.findings.length})` : `${SEVERITY[s].label} (${selected.counts[s]})`}
                  </Button>
                ))}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      <th className="text-left font-normal py-1 w-8"><span className="sr-only">Severity</span></th>
                      <th className="text-left font-normal">Finding</th>
                      <th className="text-right font-normal">Stated</th>
                      <th className="text-right font-normal">Expected</th>
                      <th className="text-right font-normal">Difference</th>
                      <th className="text-left font-normal pl-3">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((f, i) => {
                      const S = SEVERITY[f.severity]
                      return (
                        <tr key={i} className="border-t align-top">
                          <td className="py-2"><S.Icon className={`h-4 w-4 ${S.cls}`} aria-label={S.label} /></td>
                          <td className="py-2 pr-3">
                            <span className="block text-xs text-muted-foreground">{CHECK_LABELS[f.check]} · {f.subject.label}</span>
                            {f.message}
                          </td>
                          <td className="py-2 text-right tabular-nums whitespace-nowrap">{money(f.stated)}</td>
                          <td className="py-2 text-right tabular-nums whitespace-nowrap">{money(f.expected)}</td>
                          <td className="py-2 text-right tabular-nums whitespace-nowrap">{money(f.difference)}</td>
                          <td className="py-2 pl-3 text-xs text-muted-foreground">
                            {f.cites.length === 0 ? '—' : f.cites.map((c, j) => (
                              <span key={j} className="block">{c.document}{c.page ? `, p. ${c.page}` : ''}{c.label ? `: ${c.label}` : ''}</span>
                            ))}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
