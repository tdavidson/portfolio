'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, ClipboardPaste, Trash2, X, BookOpen, ListTree, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useConfirm } from '@/components/confirm-dialog'
import { useCurrency, formatCurrencyFull } from '@/components/currency-context'
import { CapitalRollforwardTable, type Row, type CapitalEdit } from '@/components/accounting/capital-rollforward-table'
import { PeriodPicker } from '@/components/accounting/period-picker'
import { type PeriodPreset } from '@/lib/accounting/statement-period'
import { AnalystToggleButton } from '@/components/analyst-button'
import { AnalystPanel } from '@/components/analyst-panel'

// The capital-accounts API returns the full per-LP Row for BOTH producers (ledger and pasted
// positions), so this surface renders the same table as /funds/[id]/capital-accounts.
interface AcctResp { rows: Row[]; nav: number; source: 'ledger' | 'events'; period?: unknown }

interface Position {
  lpEntityId: string
  name: string
  asOfDate: string
  commitment: number | null
  calledCapital: number | null
  distributions: number | null
  nav: number | null
  irr: number | null
}

export function LpCapitalView({ isAdmin, canOpenStatement = false, initialVehicles }: {
  isAdmin: boolean
  canOpenStatement?: boolean
  initialVehicles?: { id: string | null; name: string }[]
}) {
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrencyFull(v, currency)
  const confirm = useConfirm()

  const [vehicles, setVehicles] = useState<string[]>(() => initialVehicles?.map(v => v.name) ?? [])
  const [group, setGroup] = useState<string>(() => initialVehicles?.[0]?.name ?? '')
  const [acct, setAcct] = useState<AcctResp | null>(null)
  const [positions, setPositions] = useState<Position[]>([])
  const [dates, setDates] = useState<string[]>([]) // most-recent first
  // Full period control — same as /funds. For a vehicle with paste history the presets capture the
  // activity between snapshot dates; for a single snapshot they degenerate to that one balance.
  const [preset, setPreset] = useState<PeriodPreset>('itd')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [asOf, setAsOf] = useState('') // report date; '' = Latest
  const [search, setSearch] = useState('')
  const [delErr, setDelErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(initialVehicles === undefined || initialVehicles.length > 0)
  const [historyLoading, setHistoryLoading] = useState(initialVehicles === undefined || initialVehicles.length > 0)
  const [loadError, setLoadError] = useState(false)
  const [historyError, setHistoryError] = useState(false)
  const [revision, setRevision] = useState(0)
  const load = useCallback(() => setRevision(value => value + 1), [])

  // Registry ids by vehicle name, for the statement links: `/funds/<name>` resolves only for a
  // member who sees every entity, so a member granted some of them needs the id (as FundSwitcher).
  const [vehicleIds, setVehicleIds] = useState<Record<string, string>>(() =>
    Object.fromEntries((initialVehicles ?? []).filter(v => v.id).map(v => [v.name, v.id!]))
  )
  useEffect(() => {
    if (!canOpenStatement || initialVehicles !== undefined) return
    fetch('/api/accounting/vehicle-index')
      .then(r => (r.ok ? r.json() : []))
      .then((v: { id: string | null; name: string }[]) => {
        if (!Array.isArray(v)) return
        setVehicleIds(Object.fromEntries(v.filter(o => o.id).map(o => [o.name, o.id as string])))
      })
      .catch(() => {})
  }, [canOpenStatement, initialVehicles])

  useEffect(() => {
    if (group || initialVehicles !== undefined) return
    const controller = new AbortController()
    setLoading(true)
    setLoadError(false)
    fetch('/api/accounting/vehicles', { signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error('vehicles'); return r.json() })
      .then((v: string[]) => {
        if (controller.signal.aborted) return
        const names = Array.isArray(v) ? v : []
        setVehicles(names)
        if (names.length) setGroup(names[0])
        else { setLoading(false); setHistoryLoading(false) }
      })
      .catch(() => { if (!controller.signal.aborted) { setLoadError(true); setLoading(false) } })
    return () => controller.abort()
  }, [group, revision, initialVehicles])

  // Position history depends on the vehicle, not the selected reporting period. Refresh both
  // resources after edits, but let the statement render as soon as its own request completes.
  useEffect(() => {
    if (!group) return
    const controller = new AbortController()
    setHistoryLoading(true)
    setHistoryError(false)
    setPositions([])
    setDates([])
    fetch(`/api/accounting/positions?group=${encodeURIComponent(group)}`, { signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error('history'); return r.json() })
      .then(p => {
        if (controller.signal.aborted) return
        setPositions(p?.positions ?? [])
        setDates(p?.dates ?? [])
      })
      .catch(() => { if (!controller.signal.aborted) setHistoryError(true) })
      .finally(() => { if (!controller.signal.aborted) setHistoryLoading(false) })
    return () => controller.abort()
  }, [group, revision])

  useEffect(() => {
    if (!group) return
    const controller = new AbortController()
    setLoading(true)
    setLoadError(false)
    const qs = new URLSearchParams({ group })
    if (preset === 'custom') { if (start) qs.set('start', start); if (end) qs.set('end', end) }
    else qs.set('preset', preset)
    if (asOf) qs.set('asOf', asOf)
    fetch(`/api/accounting/capital-accounts?${qs}`, { signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error('accounts'); return r.json() })
      .then(a => { if (!controller.signal.aborted) setAcct(a) })
      .catch(() => { if (!controller.signal.aborted) { setAcct(null); setLoadError(true) } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [group, preset, start, end, asOf, revision])

  // The snapshot an edit writes to: the latest stored position on-or-before the report date (or the
  // latest overall when no date is picked). dates is most-recent-first.
  const resolvedDate = useMemo(() => {
    if (!asOf) return dates[0] ?? ''
    return dates.find(d => d <= asOf) ?? ''
  }, [asOf, dates])

  // Inline edit → rename the LP (entity label + investor sync) and write its position for the shown
  // date, then reload so the derived table refreshes. Throws so the row can surface an error.
  const savePosition = useCallback(async (lpEntityId: string, patch: CapitalEdit) => {
    const origName = acct?.rows.find(r => r.lpEntityId === lpEntityId)?.name
    if (patch.name && patch.name !== origName) {
      const res = await fetch('/api/lps/entities', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: lpEntityId, entityName: patch.name }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error ?? 'Could not rename LP') }
    }
    const asOfDate = resolvedDate || dates[0]
    if (asOfDate) {
      const res = await fetch('/api/accounting/positions', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group, asOfDate, lpEntityId,
          commitment: patch.commitment, calledCapital: patch.calledCapital,
          distributions: patch.distributions, nav: patch.nav, irr: patch.irr,
        }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error ?? 'Could not save figures') }
    }
    load()
  }, [group, resolvedDate, dates, load, acct])

  // Delete a ghost/duplicate LP from this vehicle. Guarded server-side (no ledger activity) + a
  // confirm that surfaces the LP's figures, since a tracking LP has no ledger activity to block on.
  const deleteLp = useCallback(async (lpEntityId: string, name: string) => {
    setDelErr(null)
    const row = acct?.rows.find(r => r.lpEntityId === lpEntityId)
    const hasCapital = !!row && [row.commitment, row.called, row.itd.ending, -row.itd.distributions].some(v => Math.abs(v) > 0.5)
    const ok = await confirm({
      title: `Delete “${name}”?`,
      description: hasCapital
        ? `This LP shows commitment ${fmt(row!.commitment)}, called ${fmt(row!.called)}, NAV ${fmt(row!.itd.ending)}. Deleting removes it and its positions and can’t be undone — only for a duplicate/ghost.`
        : `No capital on this LP. Deleting removes it and its positions. Can’t be undone.`,
      confirmLabel: 'Delete LP', variant: 'destructive',
    })
    if (!ok) return
    const res = await fetch(`/api/lps/entities?id=${encodeURIComponent(lpEntityId)}`, { method: 'DELETE' })
    if (!res.ok) { const d = await res.json().catch(() => ({})); setDelErr(d.error ?? 'Could not delete LP') }
    load()
  }, [acct, confirm, fmt, load])

  return (
    // The panel the header's Analyst button opens, beside the page at lg. It was never rendered
    // here, so the button did nothing on this page.
    <div className="flex flex-col lg:flex-row gap-6 items-start">
    <div className="space-y-4 flex-1 min-w-0 w-full">
      {/* Header — title on the left, the vehicle switcher + Analyst on the right, matching
          /funds/[id]/capital-accounts (FundSubpageChrome). */}
      <div className="flex items-end justify-between gap-3">
        <div className="space-y-1 min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Capital accounts</h1>
          <p className="text-sm text-muted-foreground">
            Limited partner roll-forward per period
            {acct && (
              <span className="ml-1.5 inline-flex items-center gap-1 align-middle">
                · {acct.source === 'ledger' ? <BookOpen className="h-3.5 w-3.5" /> : <ListTree className="h-3.5 w-3.5" />}
                Reported balances and recorded activity
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {vehicles.length <= 1 ? (
            <span className="text-sm font-medium">{group || '—'}</span>
          ) : (
            <select
              value={group}
              onChange={e => { setGroup(e.target.value); setPreset('itd'); setStart(''); setEnd(''); setAsOf('') }}
              className="rounded border bg-transparent px-2 py-1 text-sm"
            >
              {vehicles.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          )}
          <AnalystToggleButton />
        </div>
      </div>

      {/* Action bar — search left; the "As of" date right-aligned. A tracking vehicle navigates its
          stored snapshot dates; an accounting vehicle picks an arbitrary report date. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative max-w-xs w-full sm:w-64">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search LPs…"
            className="w-full pl-8 pr-8 py-1.5 text-sm border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <PeriodPicker
            preset={preset} onPreset={setPreset}
            start={start} end={end} onStart={setStart} onEnd={setEnd}
            asOf={asOf} onAsOf={setAsOf}
            allowAsOf
            title={preset !== 'itd' ? 'Activity within the period, opening with the balance carried in' : 'All activity since inception'}
          />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : loadError ? (
        <p role="alert" className="text-sm text-muted-foreground">Could not load capital accounts. <button type="button" onClick={load} className="underline">Retry</button></p>
      ) : (
        <>
          {/* One table for both producers — the roll-forward plus performance ratios. A pasted
              vehicle's amount columns are editable inputs; an accounting vehicle's are calculated. */}
          {delErr && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-destructive bg-destructive-subtle px-3 py-2 text-sm text-destructive dark:bg-destructive-subtle/40">
              <span>{delErr}</span>
              <button onClick={() => setDelErr(null)} className="shrink-0 hover:opacity-70"><X className="h-3.5 w-3.5" /></button>
            </div>
          )}
          <CapitalRollforwardTable
            rows={acct?.rows ?? []}
            scope={{ preset, start }}
            fmt={fmt}
            search={search}
            metrics
            // Each LP opens its capital statement (and Generate PDF), which reads the ledger — so
            // only for a ledger vehicle. `from=lps` sends the statement's back link here.
            lpHref={canOpenStatement && acct?.source === 'ledger' && group
              ? (id) => `/funds/${vehicleIds[group] ?? encodeURIComponent(group)}/capital-accounts/${id}?from=lps`
              : undefined}
            editable={isAdmin && !historyLoading && !historyError && preset === 'itd' ? { onSave: savePosition, onDelete: deleteLp } : undefined}
          />
          {isAdmin && preset !== 'itd' && (
            <p className="text-xs text-muted-foreground">
              Viewing period activity — switch to <strong>Inception to date</strong> (or click a date in History) to edit a snapshot.
            </p>
          )}
          {isAdmin && preset === 'itd' && resolvedDate && (
            <p className="text-xs text-muted-foreground">
              Editing the snapshot as of <strong>{resolvedDate}</strong>
              {asOf && asOf !== resolvedDate ? ` (nearest paste on or before ${asOf})` : ''} — pick another date in History below to edit it at its root.
            </p>
          )}

          {(
            <>
              {historyLoading && <p role="status" className="text-sm text-muted-foreground">Loading position history…</p>}
              {historyError && <p role="alert" className="text-sm text-muted-foreground">Could not load position history. <button type="button" onClick={load} className="underline">Retry</button></p>}
              {/* The tracked history — one row per stored date; click to view/edit that snapshot. */}
              {dates.length > 0 && (
                <HistoryTable
                  positions={positions}
                  dates={dates}
                  activeDate={resolvedDate}
                  onSelect={d => { setPreset('itd'); setStart(''); setEnd(''); setAsOf(d) }}
                  onDelete={isAdmin ? async (d) => {
                    const ok = await confirm({ title: `Delete the ${d} positions?`, description: 'Removes every LP position stored for this date on this vehicle.', confirmLabel: 'Delete', variant: 'destructive' })
                    if (!ok) return
                    await fetch(`/api/accounting/positions?group=${encodeURIComponent(group)}&asOfDate=${d}`, { method: 'DELETE' })
                    load()
                  } : undefined}
                  fmt={fmt}
                />
              )}

              {isAdmin ? <ImportBox group={group} onImported={load} /> : (
                <p className="text-xs text-muted-foreground">Capital tracking is admin-edited.</p>
              )}
            </>
          )}
        </>
      )}
    </div>
    <AnalystPanel />
    </div>
  )
}

// ---------------------------------------------------------------------------
// History table — one row per stored date
// ---------------------------------------------------------------------------

function HistoryTable({
  positions, dates, activeDate, onSelect, onDelete, fmt,
}: {
  positions: Position[]
  dates: string[]
  activeDate: string
  onSelect: (d: string) => void
  onDelete?: (d: string) => void
  fmt: (v: number) => string
}) {
  const byDate = useMemo(() => {
    const m = new Map<string, { lps: number; commitment: number | null; called: number | null; distributions: number | null; nav: number | null }>()
    for (const d of dates) m.set(d, { lps: 0, commitment: 0, called: 0, distributions: 0, nav: 0 })
    for (const p of positions) {
      const agg = m.get(p.asOfDate)
      if (!agg) continue
      agg.lps += 1
      agg.commitment = agg.commitment == null || p.commitment == null ? null : agg.commitment + p.commitment
      agg.called = agg.called == null || p.calledCapital == null ? null : agg.called + p.calledCapital
      agg.distributions = agg.distributions == null || p.distributions == null ? null : agg.distributions + p.distributions
      agg.nav = agg.nav == null || p.nav == null ? null : agg.nav + p.nav
    }
    return m
  }, [positions, dates])

  return (
    <div className="space-y-2">
      <h2 className="text-base font-medium">History</h2>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground bg-muted/40">
            <tr>
              <th className="text-left px-3 py-2 font-medium">As of</th>
              <th className="text-right px-3 py-2 font-medium">LPs</th>
              <th className="text-right px-3 py-2 font-medium">Committed</th>
              <th className="text-right px-3 py-2 font-medium">Called</th>
              <th className="text-right px-3 py-2 font-medium">Distributions</th>
              <th className="text-right px-3 py-2 font-medium">NAV</th>
              {onDelete && <th className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {dates.map(d => {
              const a = byDate.get(d)!
              return (
                <tr key={d} className={`border-t group cursor-pointer hover:bg-muted/20 ${d === activeDate ? 'bg-muted/30' : ''}`} onClick={() => onSelect(d)}>
                  <td className="px-3 py-1.5 font-medium">{d}{d === activeDate && <span className="ml-2 text-[10px] text-muted-foreground">shown above</span>}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{a.lps}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{(a.commitment == null ? '—' : fmt(a.commitment))}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{(a.called == null ? '—' : fmt(a.called))}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{(a.distributions == null ? '—' : fmt(a.distributions))}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{(a.nav == null ? '—' : fmt(a.nav))}</td>
                  {onDelete && (
                    <td className="px-3 py-1.5 text-right" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => onDelete(d)}
                        title={`Delete the entire ${d} set`}
                        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 focus:opacity-100"
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Delete set
                      </button>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Import box
// ---------------------------------------------------------------------------

function ImportBox({ group, onImported }: { group: string; onImported: () => void }) {
  const [asOfDate, setAsOfDate] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function doImport() {
    setBusy(true); setMsg(null)
    const res = await fetch('/api/accounting/positions/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group, asOfDate, data: text }),
    })
    const d = await res.json()
    setBusy(false)
    if (!res.ok) { setMsg(d.error ?? 'Import failed'); return }
    setMsg(`Imported ${d.written} positions as of ${d.asOfDate}.`
      + (d.partnersCreated ? ` ${d.partnersCreated} partner${d.partnersCreated === 1 ? '' : 's'} added to accounting.` : '')
      + (Array.isArray(d.errors) && d.errors.length ? ` ${d.errors.join(' ')}` : ''))
    setText('')
    onImported()
  }

  return (
    <div className="rounded-card border p-4 space-y-3">
      <div className="flex items-center gap-2">
        <ClipboardPaste className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-base font-medium">Import</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Paste a statement — the AI maps the columns (commitment, called/paid-in, distributions, NAV, and Net IRR if present).
        Each import is the cumulative position as of a date; re-importing a date replaces it. The table above is derived
        from the dates you keep. Imported partners are added to this entity&apos;s accounting with their commitment.{' '}
        <a href="/templates/lp-import.csv" download className="underline underline-offset-4 hover:text-foreground">
          Download a template
        </a>{' '}
        (the Vehicle column is ignored here — rows go to the entity you&apos;re viewing).
      </p>
      <label className="text-xs text-muted-foreground flex items-center gap-2">
        As of
        <Input type="date" value={asOfDate} onChange={e => setAsOfDate(e.target.value)} className="h-9 w-40" />
      </label>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        rows={8}
        placeholder="Paste spreadsheet rows (with headers): investor, commitment, called/paid-in, distributions, NAV, Net IRR…"
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={doImport} disabled={busy || !asOfDate || !text.trim()}>
          {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null} Import
        </Button>
        {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      </div>
    </div>
  )
}
