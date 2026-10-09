'use client'

// The LPs page — the LIVE cross-vehicle aggregate, and the working surface for LP reporting.
//
// It rolls every LP up to the investor, live, as of any date, and carries the report toolset
// that used to live only on a frozen snapshot: search, per-vehicle filtering, Excel export,
// report-card printing, per-investor rename / grouping / individual cards, notes, the AI
// analyst, and a report header/footer. Sharing freezes a snapshot first (the portal is
// document-based), then shares that.

import Link from 'next/link'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, ChevronRight, ChevronDown, Calendar, Search, X, Download, FileText, Settings, Pencil, Users, Trash2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { useCurrency, formatCurrencyFull } from '@/components/currency-context'
import { useConfirm } from '@/components/confirm-dialog'
import { useFeatureVisibility, useIsAdmin, useLpPortalEnabled } from '@/components/feature-visibility-context'
import { PortfolioGroupFilter } from '@/components/lp-portfolio-group-filter'
import { LpSharePanel } from '@/components/lp-share-control'
import { AnalystToggleButton } from '@/components/analyst-button'
import { AnalystPanel } from '@/components/analyst-panel'
import { AnalystDomainScope } from '@/components/analyst-scope'
import { PortfolioNotesProvider, PortfolioNotesButton, PortfolioNotesPanel } from '@/components/portfolio-notes'
import { RenameInvestorDialog } from '@/components/lp/rename-investor-dialog'
import { lpRatios } from '@/lib/lp-metrics'
import { SortTh, nextSort, compareVals, type SortState } from '@/components/sortable-th'
import { Metric as Stat } from '@/components/ui/metric'
import { CapitalCharts } from '@/components/capital-charts'
import { known } from '@/lib/charts/capital'

interface LiveRow {
  entity_id: string
  entity_name: string
  investor_id: string
  investor_name: string
  portfolio_group: string
  source: 'ledger' | 'events'
  lookThroughVia?: string
  commitment: number
  called_capital: number | null
  paid_in_capital: number | null
  distributions: number | null
  nav: number | null
  total_value: number | null
  outstanding_balance: number | null
  dpi: number | null
  rvpi: number | null
  tvpi: number | null
  irr: number | null
}
interface Payload {
  asOf: string | null
  rows: LiveRow[]
}
interface InvestorMeta { id: string; name: string; parent_id: string | null }

interface Totals {
  commitment: number; paid_in_capital: number | null; distributions: number | null; nav: number | null
  total_value: number | null; outstanding_balance: number | null
  pctFunded: number | null; dpi: number | null; rvpi: number | null; tvpi: number | null; irr: number | null
}

const moicX = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(2)}x`)
const pctX = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)

const add = (a: number | null, b: number | null): number | null => a == null || b == null ? null : a + b

function total(rows: LiveRow[]): Totals {
  const t = rows.reduce<Omit<Totals, 'pctFunded' | 'dpi' | 'rvpi' | 'tvpi' | 'irr'>>((a, r) => ({
    commitment: a.commitment + r.commitment, paid_in_capital: add(a.paid_in_capital, r.paid_in_capital),
    distributions: add(a.distributions, r.distributions), nav: add(a.nav, r.nav),
    total_value: add(a.total_value, r.total_value), outstanding_balance: add(a.outstanding_balance, r.outstanding_balance),
  }), { commitment: 0, paid_in_capital: 0, distributions: 0, nav: 0, total_value: 0, outstanding_balance: 0 })
  const rr = lpRatios({ commitment: t.commitment, paidIn: t.paid_in_capital, distributions: t.distributions, nav: t.nav })
  return {
    ...t,
    ...rr,
    // IRR is not additive across vehicles, so it is only shown when an investor has a single
    // vehicle position (then it is exactly that row's IRR). Multi-vehicle investors show "—".
    irr: rows.length === 1 ? rows[0].irr : null,
  }
}

export default function LpsPage() {
  return (
    <PortfolioNotesProvider pageContext="lps">
      <LpsInner />
    </PortfolioNotesProvider>
  )
}

function LpsInner() {
  const currency = useCurrency()
  const fmt = (v: number | null) => formatCurrencyFull(v, currency)
  const isAdmin = useIsAdmin()
  const fv = useFeatureVisibility()
  const lpPortalEnabled = useLpPortalEnabled()
  const confirm = useConfirm()

  const [asOf, setAsOf] = useState('')
  const [applied, setApplied] = useState('')
  const [data, setData] = useState<Payload | null>(null)
  const [meta, setMeta] = useState<InvestorMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortState>({ key: 'commitment', dir: 'desc' })
  const onSort = (key: string) => setSort(s => nextSort(s, key, key === 'name' ? 'asc' : 'desc'))
  const [excludedGroups, setExcludedGroups] = useState<Set<string>>(new Set())
  const [exporting, setExporting] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null)
  const [delErr, setDelErr] = useState<string | null>(null)
  const [grouping, setGrouping] = useState<{ id: string; name: string } | null>(null)
  const [shareOpen, setShareOpen] = useState(false)

  const load = useCallback(async (date: string) => {
    setLoading(true); setError(null)
    try {
      const [repRes, invRes] = await Promise.all([
        fetch(`/api/lps/live-report${date ? `?asOf=${date}` : ''}`),
        fetch('/api/lps/investors'),
      ])
      const rep = await repRes.json()
      if (!repRes.ok) throw new Error(rep.error || 'Failed to build the report')
      setData(rep)
      if (invRes.ok) {
        const inv = await invRes.json()
        setMeta((Array.isArray(inv) ? inv : inv.investors ?? []).map((i: any) => ({ id: i.id, name: i.name, parent_id: i.parent_id ?? null })))
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { load(applied) }, [load, applied])

  const allGroups = useMemo(
    () => Array.from(new Set((data?.rows ?? []).map(r => r.portfolio_group))).sort(),
    [data],
  )

  // Rows after the vehicle filter.
  const visibleRows = useMemo(
    () => (data?.rows ?? []).filter(r => !excludedGroups.has(r.portfolio_group)),
    [data, excludedGroups],
  )

  // Roll up to the investor, honoring parent grouping: a child investor's rows fold into its
  // parent so a family/institution shows as one line. Then apply the search.
  const parentOf = useMemo(() => new Map(meta.map(m => [m.id, m.parent_id])), [meta])
  const nameOf = useMemo(() => new Map(meta.map(m => [m.id, m.name])), [meta])

  const investors = useMemo(() => {
    const roll = (id: string) => { // resolve to the topmost parent
      let cur = id, guard = 0
      while (parentOf.get(cur) && guard++ < 20) cur = parentOf.get(cur)!
      return cur
    }
    const byInvestor = new Map<string, { id: string; name: string; rows: LiveRow[] }>()
    for (const r of visibleRows) {
      const top = roll(r.investor_id)
      const cur = byInvestor.get(top) ?? { id: top, name: nameOf.get(top) ?? r.investor_name, rows: [] }
      cur.rows.push(r)
      byInvestor.set(top, cur)
    }
    let list = Array.from(byInvestor.values()).map(i => ({ ...i, totals: total(i.rows) }))
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(i => i.name.toLowerCase().includes(q) || i.rows.some(r => r.entity_name.toLowerCase().includes(q)))
    }
    const val = (i: typeof list[number]) => (sort.key === 'name' ? i.name : (i.totals as any)[sort.key] as number | null)
    return list.sort((a, b) => compareVals(val(a), val(b), sort.dir) || a.name.localeCompare(b.name))
  }, [visibleRows, parentOf, nameOf, search, sort])

  const grand = useMemo(() => total(visibleRows), [visibleRows])

  // The charts draw the investors the table lists (vehicle filter and search applied), rolled up
  // the same way, so a bar and its table row are always the same figure.
  const capitalPositions = useMemo(
    () => investors.map(i => ({
      key: i.id, name: i.name, committed: i.totals.commitment, called: known(i.totals.paid_in_capital),
      distributions: known(i.totals.distributions), nav: known(i.totals.nav),
    })),
    [investors],
  )

  // Delete a ghost LP (from a rename/migration): removes the investor's entities. The endpoint
  // refuses any entity with ledger activity, but a tracking LP has none — so we surface the LP's
  // figures in the confirm and require an explicit destructive OK, to avoid deleting a real one.
  async function deleteInvestor(inv: { id: string; name: string; rows: LiveRow[]; totals: Totals }) {
    setDelErr(null)
    const t = inv.totals
    const hasCapital = [t.commitment, t.paid_in_capital, t.distributions, t.nav].some(v => v == null || Math.abs(v) > 0.5)
    const ok = await confirm({
      title: `Delete “${inv.name}”?`,
      description: hasCapital
        ? `This LP still shows commitment ${fmt(t.commitment)}, called ${fmt(t.paid_in_capital)}, distributions ${fmt(t.distributions)}, NAV ${fmt(t.nav)}. Deleting removes the investor and its ${inv.rows.length} position(s) and can’t be undone — only do this for a duplicate/ghost.`
        : `No capital on this LP. Deleting removes the investor and its ${inv.rows.length} empty position(s). Can’t be undone.`,
      confirmLabel: 'Delete LP',
      variant: 'destructive',
    })
    if (!ok) return
    const ids = Array.from(new Set(inv.rows.map(r => r.entity_id)))
    let firstErr: string | null = null
    for (const id of ids) {
      const res = await fetch(`/api/lps/entities?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok && !firstErr) {
        const d = await res.json().catch(() => ({} as any))
        firstErr = d?.error ?? 'Could not delete'
      }
    }
    if (firstErr) setDelErr(`Couldn’t fully delete “${inv.name}”: ${firstErr}`)
    load(applied)
  }

  // How many vehicles the filter currently admits. When it's more than one, an investor's row has
  // to say WHICH vehicle it is — otherwise a single-vehicle LP is indistinguishable from any other
  // and there's nothing to expand to find out. With one vehicle in scope the answer is the filter
  // itself, so saying it on every row would just be noise.
  const scopedGroups = useMemo(
    () => allGroups.filter(g => !excludedGroups.has(g)),
    [allGroups, excludedGroups],
  )
  const showVehicleOnRow = scopedGroups.length > 1

  const toggle = (id: string) => setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  async function exportExcel() {
    setExporting(true)
    try {
      const res = await fetch('/api/lps/export/excel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ live: true, asOfDate: applied || undefined }),
      })
      if (!res.ok) return
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `LP Report${applied ? ` ${applied}` : ''}.xlsx`; a.click()
      URL.revokeObjectURL(url)
    } finally { setExporting(false) }
  }


  return (
    <div className="px-4 md:pl-8 md:pr-4 pt-4 md:pt-8 pb-8 w-full">
      {/* Row 1 — title, notes, analyst. Full width above the body; the Analyst panel opens
          beside the body below, matching /dashboard and the accounting pages. */}
      <div className="flex items-start justify-between gap-3 mb-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Partners</h1>
          <p className="text-sm text-muted-foreground max-w-3xl">
            Partner capital across all vehicles.
          </p>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <PortfolioNotesButton />
          <AnalystToggleButton />
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
        <div className="flex-1 min-w-0 w-full space-y-6">
          {/* Row 2 — search, filter, as-of, actions. */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search investors..."
                className="w-40 md:w-56 border border-input rounded pl-7 pr-6 py-1.5 text-sm bg-transparent placeholder:text-muted-foreground"
              />
              {search && <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="h-3 w-3" /></button>}
            </div>
            {allGroups.length > 1 && (
              <PortfolioGroupFilter
                allGroups={allGroups}
                excludedGroups={excludedGroups}
                onToggle={g => setExcludedGroups(prev => { const n = new Set(prev); n.has(g) ? n.delete(g) : n.add(g); return n })}
                onToggleAll={() => setExcludedGroups(prev => prev.size === 0 ? new Set(allGroups) : new Set())}
              />
            )}
            {/* Action buttons sit on the LEFT; the As-of date is pushed to the RIGHT to match the
                other LP capital pages. */}
            <Button size="sm" variant="outline" className="text-muted-foreground" onClick={exportExcel} disabled={exporting || investors.length === 0}>
              <Download className="h-4 w-4 mr-1" />{exporting ? 'Exporting…' : 'Export'}
            </Button>
            <Button size="sm" variant="outline" className="text-muted-foreground" asChild>
              <Link href="/lps/cards"><FileText className="h-4 w-4 mr-1" /> PDFs</Link>
            </Button>
            {isAdmin && (
              <Button size="sm" variant="outline" className="text-muted-foreground" onClick={() => setSettingsOpen(true)}>
                <Settings className="h-4 w-4 mr-1" /> Settings
              </Button>
            )}
            {/* Gate on the portal MASTER switch (like every other share/publish affordance), not on
                lp_portal_access — sharing into a portal that's off is a no-op that mints an orphan
                snapshot before the "portal is off" notice ever shows. */}
            {isAdmin && lpPortalEnabled && (
              <Button size="sm" variant="outline" className="text-muted-foreground" onClick={() => setShareOpen(true)} disabled={investors.length === 0}>
                <Users className="h-4 w-4 mr-1" /> Share
              </Button>
            )}

            <span className="flex-1" />

            <label className="text-xs text-muted-foreground flex items-center gap-1"><Calendar className="h-3 w-3" /> As of</label>
            {/* Changing the date rebuilds immediately — no separate apply button. Default (empty)
                is the latest data; "Latest" resets back to it. */}
            <Input type="date" value={asOf} onChange={e => { setAsOf(e.target.value); setApplied(e.target.value) }} className="h-9 w-40" />
            {applied && <Button size="sm" variant="ghost" onClick={() => { setAsOf(''); setApplied('') }}>Latest</Button>}
          </div>

          {error && <Card><CardContent className="p-4 text-destructive text-sm">{error}</CardContent></Card>}

          {loading && !data ? (
            <div className="flex items-center py-16 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin mr-2" /> Deriving from the ledger…</div>
          ) : data ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <Stat label="Commitment" value={fmt(grand.commitment)} />
                <Stat label="Called" value={fmt(grand.paid_in_capital)} />
                <Stat label="Distributions" value={fmt(grand.distributions)} />
                <Stat label="NAV" value={fmt(grand.nav)} />
                <Stat label="TVPI" value={grand.tvpi != null ? `${grand.tvpi.toFixed(2)}x` : '—'} />
              </div>

              <CapitalCharts positions={capitalPositions} noun="partners" />

              {delErr && (
                <div className="mb-2 flex items-center justify-between gap-3 rounded-md border border-destructive bg-destructive-subtle px-3 py-2 text-sm text-destructive dark:bg-destructive-subtle/40">
                  <span>{delErr}</span>
                  <button onClick={() => setDelErr(null)} className="shrink-0 hover:opacity-70"><X className="h-3.5 w-3.5" /></button>
                </div>
              )}

              <Card>
                <CardContent className="p-0 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-xs text-muted-foreground">
                      <tr className="border-b bg-muted/40">
                        <SortTh label="Investor" sortKey="name" sort={sort} onSort={onSort} />
                        <SortTh label="Commitment" sortKey="commitment" sort={sort} onSort={onSort} align="right" />
                        <SortTh label="Called" sortKey="paid_in_capital" sort={sort} onSort={onSort} align="right" />
                        <SortTh label="Unfunded" sortKey="outstanding_balance" sort={sort} onSort={onSort} align="right" />
                        <SortTh label="% Funded" sortKey="pctFunded" sort={sort} onSort={onSort} align="right" />
                        <SortTh label="Distributions" sortKey="distributions" sort={sort} onSort={onSort} align="right" />
                        <SortTh label="NAV" sortKey="nav" sort={sort} onSort={onSort} align="right" />
                        <SortTh label="DPI" sortKey="dpi" sort={sort} onSort={onSort} align="right" />
                        <SortTh label="RVPI" sortKey="rvpi" sort={sort} onSort={onSort} align="right" />
                        <SortTh label="TVPI" sortKey="tvpi" sort={sort} onSort={onSort} align="right" />
                        <SortTh label="IRR" sortKey="irr" sort={sort} onSort={onSort} align="right" />
                      </tr>
                    </thead>
                    <tbody>
                      {investors.map(inv => {
                        const open = expanded.has(inv.id)
                        const multi = inv.rows.length > 1
                        return (
                          <Fragment key={inv.id}>
                            <tr className={`border-b group ${multi ? 'cursor-pointer hover:bg-muted/20' : 'hover:bg-muted/10'}`} onClick={() => multi && toggle(inv.id)}>
                              <td className="px-3 py-1.5 font-medium">
                                <span className="flex items-center gap-1">
                                  {multi ? (open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />) : <span className="w-3.5 shrink-0" />}
                                  {/* Long names truncate at a fixed cap rather than wrapping or collapsing the column. */}
                                  <span className="truncate max-w-[240px]" title={inv.name}>{inv.name}</span>
                                  {multi && <span className="text-xs text-muted-foreground font-normal ml-1 shrink-0">({inv.rows.length})</span>}
                                  {/* One vehicle, several in scope: there is no expander to open, so the
                                      vehicle is named here. Otherwise the row is silent about the one
                                      thing the filter makes ambiguous. */}
                                  {!multi && showVehicleOnRow && (
                                    <span
                                      className="text-xs text-muted-foreground font-normal ml-1.5 truncate max-w-[160px]"
                                      title={inv.rows[0]?.portfolio_group}
                                    >
                                      &middot; {inv.rows[0]?.portfolio_group}
                                    </span>
                                  )}
                                  {/* Edit actions sit right next to the name, revealed on row hover. */}
                                  {isAdmin && (
                                    <span className="flex items-center gap-1.5 ml-2 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                                      <Link href={`/lps/cards/${inv.id}`} title="Report card" className="hover:text-foreground"><FileText className="h-3.5 w-3.5" /></Link>
                                      <button onClick={() => setRename({ id: inv.id, name: inv.name })} title="Rename" className="hover:text-foreground"><Pencil className="h-3.5 w-3.5" /></button>
                                      <button onClick={() => setGrouping({ id: inv.id, name: inv.name })} title="Group under another investor" className="hover:text-foreground"><Users className="h-3.5 w-3.5" /></button>
                                      <button onClick={() => deleteInvestor(inv)} title="Delete this LP (for duplicates/ghosts)" className="hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
                                    </span>
                                  )}
                                </span>
                              </td>
                              <Money v={inv.totals.commitment} fmt={fmt} />
                              <Money v={inv.totals.paid_in_capital} fmt={fmt} />
                              <Money v={inv.totals.outstanding_balance} fmt={fmt} />
                              <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{pctX(inv.totals.pctFunded)}</td>
                              <Money v={inv.totals.distributions} fmt={fmt} />
                              <Money v={inv.totals.nav} fmt={fmt} />
                              <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{moicX(inv.totals.dpi)}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{moicX(inv.totals.rvpi)}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{moicX(inv.totals.tvpi)}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{pctX(inv.totals.irr)}</td>
                            </tr>
                            {open && inv.rows.map(r => (
                              <tr key={`${inv.id}-${r.entity_id}-${r.portfolio_group}`} className="border-b bg-muted/10 text-muted-foreground">
                                <td className="px-3 py-1.5 pl-10 text-xs">
                                  {/* The `via [associate]` badge sits OUTSIDE the truncating span (shrink-0) so it
                                      is never clipped — otherwise a long "group · entity" label eats the width and
                                      the attribution disappears, making a look-through row read as a direct LP. */}
                                  <span className="flex items-center gap-1 min-w-0">
                                    <span className="truncate max-w-[300px]" title={`${r.portfolio_group}${r.entity_name !== inv.name ? ` · ${r.entity_name}` : ''}`}>
                                      {r.portfolio_group}
                                      {r.entity_name !== inv.name && <span className="ml-1">· {r.entity_name}</span>}
                                    </span>
                                    {r.lookThroughVia && <Badge variant="secondary" className="shrink-0 text-[10px] py-0 px-1">via {r.lookThroughVia}</Badge>}
                                  </span>
                                </td>
                                <Money v={r.commitment} fmt={fmt} small />
                                <Money v={r.paid_in_capital} fmt={fmt} small />
                                <Money v={r.outstanding_balance} fmt={fmt} small />
                                <td className="px-3 py-1.5 text-right tabular-nums text-xs">{pctX(r.commitment > 0 && r.paid_in_capital != null ? r.paid_in_capital / r.commitment : null)}</td>
                                <Money v={r.distributions} fmt={fmt} small />
                                <Money v={r.nav} fmt={fmt} small />
                                <td className="px-3 py-1.5 text-right tabular-nums text-xs">{moicX(r.dpi)}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums text-xs">{moicX(r.rvpi)}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums text-xs">{moicX(r.tvpi)}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums text-xs">{pctX(r.irr)}</td>
                              </tr>
                            ))}
                          </Fragment>
                        )
                      })}
                      {investors.length === 0 && (
                        <tr><td colSpan={11} className="p-8 text-center text-muted-foreground">
                          {search ? 'No investors match your search.' : 'No LP capital found. Track a vehicle’s positions or book its history.'}
                        </td></tr>
                      )}
                    </tbody>
                    {investors.length > 0 && (
                      <tfoot>
                        <tr className="border-t-2 font-medium bg-muted/30">
                          <td className="px-3 py-1.5">Total</td>
                          <Money v={grand.commitment} fmt={fmt} />
                          <Money v={grand.paid_in_capital} fmt={fmt} />
                          <Money v={grand.outstanding_balance} fmt={fmt} />
                          <td className="px-3 py-1.5 text-right tabular-nums">{pctX(grand.pctFunded)}</td>
                          <Money v={grand.distributions} fmt={fmt} />
                          <Money v={grand.nav} fmt={fmt} />
                          <td className="px-3 py-1.5 text-right tabular-nums">{moicX(grand.dpi)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{moicX(grand.rvpi)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{moicX(grand.tvpi)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{grand.irr != null ? pctX(grand.irr) : '—'}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </CardContent>
              </Card>
            </>
          ) : null}

          {settingsOpen && <ReportSettingsDialog onClose={() => setSettingsOpen(false)} />}
          {rename && <RenameInvestorDialog target={{ investorId: rename.id, name: rename.name }} onClose={() => setRename(null)} onSaved={() => { setRename(null); load(applied) }} />}
          {grouping && <GroupDialog investor={grouping} candidates={investors.map(i => ({ id: i.id, name: i.name }))} onClose={() => setGrouping(null)} onSaved={() => { setGrouping(null); load(applied) }} />}

          {/* Share freezes the current live report into a fixed snapshot, then lets you pick which
              LPs can see it in their portal — the same picker the capital-accounts publish uses.
              No email is sent; LPs see it when they sign in. */}
          {/* Live publish: each checked LP sees their own slice of the LIVE report in their portal —
              always current, no frozen snapshot. */}
          <Dialog open={shareOpen} onOpenChange={setShareOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Publish the live report to LPs</DialogTitle>
                <DialogDescription>
                  Check the LPs who should see their position in their portal. They see the live data — the same as this
                  page, always current — not a frozen statement.
                </DialogDescription>
              </DialogHeader>
              {shareOpen && <LpSharePanel shareEndpoint="/api/lps/live-report/share" />}
            </DialogContent>
          </Dialog>
        </div>

        <PortfolioNotesPanel />
        <AnalystDomainScope domain="lps" />
        <AnalystPanel />
      </div>
    </div>
  )
}

function Money({ v, fmt, small }: { v: number | null; fmt: (n: number | null) => string; small?: boolean }) {
  return <td className={`px-3 py-1.5 text-right tabular-nums whitespace-nowrap ${small ? 'text-xs' : ''}`}>{fmt(v)}</td>
}

// ---------------------------------------------------------------------------
// Dialogs — report settings (fund-level header/footer), rename, group.
// ---------------------------------------------------------------------------

function ReportSettingsDialog({ onClose }: { onClose: () => void }) {
  const [description, setDescription] = useState('')
  const [footer, setFooter] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch('/api/lps/live-settings').then(r => r.json()).then(d => { setDescription(d.description ?? ''); setFooter(d.footer ?? ''); setLoaded(true) })
  }, [])

  async function save() {
    setSaving(true)
    await fetch('/api/lps/live-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description, footer }) })
    setSaving(false); onClose()
  }

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Report settings</DialogTitle>
          <DialogDescription>The header paragraph and footer note printed on every live report card.</DialogDescription>
        </DialogHeader>
        {!loaded ? <div className="py-8 flex justify-center"><Loader2 className="h-4 w-4 animate-spin" /></div> : (
          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">Header paragraph</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)} rows={4}
                placeholder="A short introduction shown at the top of every investor report."
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Footer note</label>
              <textarea value={footer} onChange={e => setFooter(e.target.value)} rows={3}
                placeholder="Leave blank for the default metric definitions."
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving || !loaded}>{saving ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function GroupDialog({ investor, candidates, onClose, onSaved }: {
  investor: { id: string; name: string }
  candidates: { id: string; name: string }[]
  onClose: () => void
  onSaved: () => void
}) {
  const [parentId, setParentId] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const options = candidates.filter(c => c.id !== investor.id)

  async function save(id: string | null) {
    setSaving(true)
    await fetch('/api/lps/investors', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: investor.id, parentId: id }) })
    setSaving(false); onSaved()
  }
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Group &ldquo;{investor.name}&rdquo;</DialogTitle>
          <DialogDescription>Roll this investor&rsquo;s positions up under another investor on the report.</DialogDescription>
        </DialogHeader>
        <select value={parentId} onChange={e => setParentId(e.target.value)} className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm">
          <option value="">Choose an investor…</option>
          {options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <DialogFooter className="flex-wrap gap-2">
          <Button variant="ghost" size="sm" onClick={() => save(null)} disabled={saving}>Ungroup</Button>
          <span className="flex-1" />
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save(parentId || null)} disabled={saving || !parentId}>{saving ? 'Saving…' : 'Group'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
