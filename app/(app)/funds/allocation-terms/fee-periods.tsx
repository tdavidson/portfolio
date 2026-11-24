'use client'

// The management fee schedule, period by period (lib/accounting/fee-periods.ts): every payment the
// terms charge, editable, with per-partner lines (a later closer's catch-up, equalization fees,
// adjustments), posted on its due date and invoiced.
//
// Rates are entered as PERCENTAGES here and stored as fractions, as on the schedule above.

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useLedgerFetch, useVehicle } from '@/components/accounting-vehicle'
import { useCurrency, formatCurrencyFull } from '@/components/currency-context'

type Basis = 'commitments' | 'invested' | 'nav' | 'other'
type Kind = 'fee' | 'catch_up' | 'equalization' | 'adjustment'
interface Line { lpEntityId: string; kind: Kind; amount: number; note: string | null; auto: boolean }
interface Period {
  id: string; start: string; end: string; dueDate: string; rate: number; basis: Basis; basisAmount: number
  gross: number; offset: number; total: number; note: string | null; edited: boolean
  status: 'scheduled' | 'drafted' | 'posted' | 'waived'; postings: { date: string; entryId: string }[]
  lastError: string | null; lines: Line[]
  invoice: { number: string; date: string; status: 'draft' | 'issued' | 'void'; amount: number } | null
}
interface View { periods: Period[]; names: Record<string, string>; manager: { name: string } | null; stale: number; schedule: { monthlyAccrual?: boolean } | null }

const KIND_LABEL: Record<Kind, string> = { fee: 'Fee', catch_up: 'Catch-up', equalization: 'Equalization', adjustment: 'Adjustment' }
const BASIS_LABEL: Record<Basis, string> = { commitments: 'commitments', invested: 'invested capital', nav: 'NAV', other: 'other' }
const STATUS_LABEL: Record<Period['status'], string> = { scheduled: 'Scheduled', drafted: 'Drafted', posted: 'Posted', waived: 'Waived' }
const STATUS_TONE: Record<Period['status'], string> = { scheduled: 'text-muted-foreground', drafted: 'text-warning', posted: 'text-success', waived: 'text-muted-foreground' }

const pct = (fraction: number) => String(Math.round((fraction || 0) * 1000000) / 10000)
const lastDay = (end: string) => { const d = new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10) }
const today = () => new Date().toISOString().slice(0, 10)
const selectCls = 'border border-border rounded-sm bg-background text-foreground px-2 py-1 text-sm'

export function FeePeriodsTable() {
  const lf = useLedgerFetch()
  const { group } = useVehicle()
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrencyFull(v, currency)
  const [view, setView] = useState<View | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await lf('/api/accounting/fee-periods')
    const d = await r.json().catch(() => ({}))
    if (!r.ok) { setError(d.error ?? 'Could not read the fee schedule'); setView({ periods: [], names: {}, manager: null, stale: 0, schedule: null }); return }
    setView(d)
  }, [lf])
  useEffect(() => { void load() }, [load])

  const act = async (key: string, body: Record<string, unknown>) => {
    setBusy(key); setError(null)
    const r = await lf('/api/accounting/fee-periods', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const d = await r.json().catch(() => ({}))
    setBusy(null)
    if (!r.ok) { setError(d.error ?? 'That did not work'); return false }
    if (Array.isArray(d.warnings) && d.warnings.length) setError(d.warnings.join(' '))
    await load()
    return true
  }

  if (!view) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading the fee schedule…</div>

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-medium">Schedule</p>
        <Button size="sm" variant="outline" className="h-7 text-muted-foreground" disabled={busy === 'generate'} onClick={() => act('generate', { action: 'generate' })}>
          {busy === 'generate' ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
          {view.periods.length === 0 ? 'Create the schedule' : 'Update from the terms'}
        </Button>
        {view.stale > 0 && view.periods.length > 0 && <span className="text-sm text-warning">{view.stale} period{view.stale === 1 ? '' : 's'} would change</span>}
      </div>
      <p className="text-xs text-muted-foreground max-w-3xl">
        Each payment the terms charge. Edit any period (its due date, rate, the capital it&rsquo;s calculated on,
        the fee, or the partners&rsquo; lines, such as a later closer&rsquo;s catch-up or an equalization fee); an
        edited period keeps your changes when the schedule is updated from the terms. Posting books the fee as
        payable{view.manager ? ` to ${view.manager.name}, with its receivable on ${view.manager.name}'s books,` : ''} and
        issues an invoice for the payment.
      </p>
      {error && <p className="text-sm text-warning">{error}</p>}
      {view.periods.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-3 font-medium">Period</th>
                <th className="py-1 pr-3 font-medium">Due</th>
                <th className="py-1 pr-3 font-medium">Rate</th>
                <th className="py-1 pr-3 font-medium text-right">Capital</th>
                <th className="py-1 pr-3 font-medium text-right">Amount</th>
                <th className="py-1 pr-3 font-medium">Status</th>
                <th className="py-1 pr-3 font-medium">Invoice</th>
                <th className="py-1 font-medium" />
              </tr>
            </thead>
            <tbody>
              {view.periods.map(p => {
                const booked = p.postings.length > 0
                const extras = p.lines.filter(l => l.kind !== 'fee').length
                return (
                  <Fragment key={p.id}>
                    <tr className="border-t border-border align-top">
                      <td className="py-1.5 pr-3 whitespace-nowrap tabular-nums">
                        {p.start} – {lastDay(p.end)}
                        {p.edited && p.status !== 'waived' && <span className="ml-1 text-xs text-muted-foreground">edited</span>}
                      </td>
                      <td className="py-1.5 pr-3 whitespace-nowrap tabular-nums">{p.dueDate}</td>
                      <td className="py-1.5 pr-3 whitespace-nowrap">{pct(p.rate)}% of {BASIS_LABEL[p.basis]}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(p.basisAmount)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">
                        {fmt(p.total)}
                        {extras > 0 && <div className="text-xs text-muted-foreground">incl. {extras} extra line{extras === 1 ? '' : 's'}</div>}
                      </td>
                      <td className="py-1.5 pr-3 whitespace-nowrap">
                        <span className={`text-xs ${STATUS_TONE[p.status]}`}>{STATUS_LABEL[p.status]}</span>
                        {p.lastError && <div className="text-sm text-warning max-w-56 whitespace-normal">{p.lastError}</div>}
                      </td>
                      <td className="py-1.5 pr-3 whitespace-nowrap text-xs">
                        {p.invoice && p.invoice.status !== 'void' && group
                          ? <a className="text-primary hover:underline" target="_blank" rel="noreferrer" href={`/api/accounting/fee-periods/invoice?group=${encodeURIComponent(group)}&id=${p.id}`}>
                              {p.invoice.number}{p.invoice.status === 'draft' ? ' (draft)' : ''}
                            </a>
                          : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="py-1.5 whitespace-nowrap text-right">
                        <div className="flex justify-end gap-1">
                          {!booked && p.status !== 'waived' && (
                            <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" onClick={() => setOpen(open === p.id ? null : p.id)}>
                              {open === p.id ? 'Close' : 'Edit'}
                            </Button>
                          )}
                          {p.status === 'scheduled' && p.total > 0 && (
                            <>
                              <Button size="sm" variant="outline" className="h-7" disabled={busy === `draft:${p.id}`} onClick={() => act(`draft:${p.id}`, { action: 'draft', periodId: p.id, all: p.dueDate > today() })}>
                                {busy === `draft:${p.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Draft'}
                              </Button>
                              <Button size="sm" variant="outline" className="h-7" disabled={busy === `post:${p.id}`} onClick={() => act(`post:${p.id}`, { action: 'post', periodId: p.id, all: p.dueDate > today() })}>
                                {busy === `post:${p.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Post'}
                              </Button>
                            </>
                          )}
                          {p.status === 'drafted' && (
                            <Button size="sm" variant="outline" className="h-7" disabled={busy === `post:${p.id}`} onClick={() => act(`post:${p.id}`, { action: 'post', periodId: p.id })}>
                              {busy === `post:${p.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Post drafts'}
                            </Button>
                          )}
                          {view.schedule?.monthlyAccrual && p.status === 'posted' && (
                            <span className="text-xs text-muted-foreground self-center">{p.postings.length} accrued</span>
                          )}
                          {!booked && (p.status === 'waived'
                            ? <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" onClick={() => act(`w:${p.id}`, { action: 'unwaive', periodId: p.id })}>Un-waive</Button>
                            : p.status === 'scheduled' && <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" onClick={() => act(`w:${p.id}`, { action: 'waive', periodId: p.id })}>Waive</Button>)}
                        </div>
                      </td>
                    </tr>
                    {open === p.id && (
                      <tr>
                        <td colSpan={8} className="pb-3">
                          <PeriodEditor
                            period={p} names={view.names} fmt={fmt} busy={busy === `edit:${p.id}`}
                            onSave={async patch => { if (await act(`edit:${p.id}`, { action: 'edit', periodId: p.id, patch })) setOpen(null) }}
                            onReset={async () => { if (await act(`edit:${p.id}`, { action: 'reset', periodId: p.id })) setOpen(null) }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

interface LineRow { lpEntityId: string; kind: Kind; amount: string; note: string }

function PeriodEditor({ period, names, fmt, busy, onSave, onReset }: {
  period: Period
  names: Record<string, string>
  fmt: (v: number) => string
  busy: boolean
  onSave: (patch: Record<string, unknown>) => void
  onReset: () => void
}) {
  const [dueDate, setDueDate] = useState(period.dueDate)
  const [rate, setRate] = useState(pct(period.rate))
  const [basis, setBasis] = useState<Basis>(period.basis)
  const [capital, setCapital] = useState(String(period.basisAmount))
  const [note, setNote] = useState(period.note ?? '')
  const [lines, setLines] = useState<LineRow[]>(period.lines.map(l => ({ lpEntityId: l.lpEntityId, kind: l.kind, amount: String(l.amount), note: l.note ?? '' })))
  const [linesTouched, setLinesTouched] = useState(false)
  const partners = useMemo(() => Object.entries(names).sort((a, b) => a[1].localeCompare(b[1])), [names])
  const total = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0)

  const save = () => {
    const patch: Record<string, unknown> = { dueDate, basis, note }
    const r = Number(rate) / 100, c = Number(capital)
    // Lines typed by hand win; otherwise a new rate or capital re-prices the fee.
    if (linesTouched) {
      patch.lines = lines.filter(l => l.lpEntityId && l.amount.trim() !== '').map(l => ({ lpEntityId: l.lpEntityId, kind: l.kind, amount: Number(l.amount), note: l.note }))
      patch.rate = r
      patch.basisAmount = c
    } else {
      if (Math.abs(r - period.rate) > 1e-9) patch.rate = r
      if (Math.abs(c - period.basisAmount) >= 0.005) patch.basisAmount = c
    }
    onSave(patch)
  }
  const setLine = (i: number, p: Partial<LineRow>) => { setLinesTouched(true); setLines(prev => prev.map((x, j) => (j === i ? { ...x, ...p } : x))) }

  return (
    <div className="rounded-card border border-border p-3 space-y-3 bg-muted/30">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <label className="space-y-1 text-xs font-medium">Due<Input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} /></label>
        <label className="space-y-1 text-xs font-medium">Rate a year
          <div className="relative"><Input inputMode="decimal" value={rate} onChange={e => setRate(e.target.value)} className="tabular-nums" /><span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span></div>
        </label>
        <label className="space-y-1 text-xs font-medium">Of
          <select value={basis} onChange={e => setBasis(e.target.value as Basis)} className={`w-full ${selectCls} py-2`}>
            <option value="commitments">Commitments</option>
            <option value="invested">Invested capital</option>
            <option value="nav">NAV</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="space-y-1 text-xs font-medium">Capital the fee is calculated on<Input inputMode="decimal" value={capital} onChange={e => setCapital(e.target.value)} className="tabular-nums" /></label>
      </div>
      <p className="text-xs text-muted-foreground">
        Changing the rate or capital re-prices the fee as capital × rate × the period&rsquo;s months ÷ 12 and spreads it
        over the partners as before. Edit the lines instead to set each amount yourself.
      </p>
      <div className="space-y-1">
        <p className="text-xs font-medium">Lines</p>
        {lines.map((l, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select value={l.lpEntityId} onChange={e => setLine(i, { lpEntityId: e.target.value })} className={`${selectCls} w-56`}>
              <option value="">Partner…</option>
              {partners.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            <select value={l.kind} onChange={e => setLine(i, { kind: e.target.value as Kind })} className={selectCls}>
              {(Object.keys(KIND_LABEL) as Kind[]).map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
            <Input inputMode="decimal" value={l.amount} onChange={e => setLine(i, { amount: e.target.value })} className="h-8 w-32 text-sm tabular-nums" />
            <Input value={l.note} onChange={e => setLine(i, { note: e.target.value })} placeholder="Note" className="h-8 w-64 text-sm" />
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => { setLinesTouched(true); setLines(prev => prev.filter((_, j) => j !== i)) }}>Remove</Button>
          </div>
        ))}
        <div className="flex items-center gap-3">
          <Button size="sm" variant="outline" className="text-muted-foreground" onClick={() => { setLinesTouched(true); setLines(prev => [...prev, { lpEntityId: '', kind: 'equalization', amount: '', note: '' }]) }}>Add a line</Button>
          <span className="text-xs text-muted-foreground tabular-nums">Total {fmt(Math.round(total * 100) / 100)}</span>
        </div>
      </div>
      <label className="space-y-1 text-xs font-medium block">Note (printed on the invoice)<Input value={note} onChange={e => setNote(e.target.value)} /></label>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save period'}</Button>
        {period.edited && <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={onReset} disabled={busy}>Reset to the terms</Button>}
      </div>
    </div>
  )
}
