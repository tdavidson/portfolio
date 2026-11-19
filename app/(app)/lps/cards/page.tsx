'use client'

// Live LP report cards — the batch surface for the LIVE report (not a frozen snapshot).
// Pick which investors to print, optionally exclude vehicles, then either print all the
// selected cards into one PDF (browser print) or download one PDF per investor as a zip
// (server-rendered with embedded fonts). Same card layout as the snapshot batch; only the
// data is live. Mirrors the old snapshot /batch page's capabilities.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Loader2, ArrowLeft, Printer, FileDown, Calendar, Search, X, CheckSquare, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PortfolioGroupFilter } from '@/components/lp-portfolio-group-filter'
import { LpReportCard, REPORT_CARD_PRINT_CSS, type ReportCardRow, type ReportCardTotals } from '@/components/lp-report-card'
import { formatAsOf } from '@/lib/report-card-footer'

interface Investor { investorId: string; investorName: string; rows: ReportCardRow[]; asOf: string | null }
interface Payload {
  fund: { name: string; logo: string | null; address: string | null }
  currency: string
  description: string | null
  footer: string | null
  asOf: string | null
  investors: Investor[]
}

const add = (a: number | null, b: number | null): number | null => a == null || b == null ? null : a + b
const ratio = (n: number | null, d: number | null): number | null => (n != null && d != null && d > 0 ? n / d : null)

function totalsOf(rows: ReportCardRow[]): ReportCardTotals {
  const t = rows.reduce<Pick<ReportCardTotals, 'commitment' | 'paidInCapital' | 'distributions' | 'nav' | 'totalValue'>>((a, r) => ({
    commitment: a.commitment + r.commitment,
    paidInCapital: add(a.paidInCapital, r.paidInCapital),
    distributions: add(a.distributions, r.distributions),
    nav: add(a.nav, r.nav),
    totalValue: add(a.totalValue, r.totalValue),
  }), { commitment: 0, paidInCapital: 0, distributions: 0, nav: 0, totalValue: 0 })
  return {
    ...t,
    pctFunded: ratio(t.paidInCapital, t.commitment),
    dpi: ratio(t.distributions, t.paidInCapital),
    rvpi: ratio(t.nav, t.paidInCapital),
    tvpi: ratio(add(t.distributions, t.nav), t.paidInCapital),
  }
}

export default function LiveCardsPage() {
  const [asOf, setAsOf] = useState('')
  const [applied, setApplied] = useState('')
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [touched, setTouched] = useState(false) // has the user changed the selection yet?
  const [search, setSearch] = useState('')
  const [excludedGroups, setExcludedGroups] = useState<Set<string>>(new Set())
  const [printing, setPrinting] = useState(false)
  const [zipping, setZipping] = useState(false)

  const load = useCallback((date: string) => {
    setLoading(true)
    fetch(`/api/lps/live-cards${date ? `?asOf=${date}` : ''}`)
      .then(r => (r.ok ? r.json() : null))
      .then(setData)
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => { load(applied) }, [load, applied])

  // Default selection = every investor, until the user picks a subset.
  useEffect(() => {
    if (data && !touched) setSelected(new Set(data.investors.map(i => i.investorId)))
  }, [data, touched])

  const investors = data?.investors ?? []
  const allGroups = useMemo(
    () => Array.from(new Set(investors.flatMap(i => i.rows.map(r => r.portfolioGroup)))).sort(),
    [investors],
  )
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? investors.filter(i => i.investorName.toLowerCase().includes(q)) : investors
  }, [investors, search])

  // Apply the vehicle-exclusion filter to an investor's rows.
  const rowsFor = useCallback((inv: Investor) =>
    excludedGroups.size === 0 ? inv.rows : inv.rows.filter(r => !excludedGroups.has(r.portfolioGroup)),
    [excludedGroups])

  function toggle(id: string) {
    setTouched(true)
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function toggleAll() {
    setTouched(true)
    setSelected(prev => prev.size === investors.length ? new Set() : new Set(investors.map(i => i.investorId)))
  }

  const selectedInvestors = investors.filter(i => selected.has(i.investorId))
  const asOfLabel = data?.asOf ?? undefined

  function printCombined() {
    setPrinting(true)
    setTimeout(() => { window.print(); setPrinting(false) }, 100)
  }

  async function downloadIndividual() {
    setZipping(true)
    try {
      const res = await fetch('/api/lps/export/pdf', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          live: true,
          asOf: applied || undefined,
          investorIds: selectedInvestors.map(i => i.investorId),
          excludedGroups: Array.from(excludedGroups),
          snapshotName: `LP Report${asOfLabel ? ` — ${asOfLabel}` : ''}`,
        }),
      })
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(`PDF generation failed: ${e?.error ?? res.statusText}`); return }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'LP Reports - Individual PDFs.zip'
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setZipping(false)
    }
  }

  return (
    <div className="p-4 md:py-8 md:pl-8 md:pr-4 w-full print:p-0">
      <style>{REPORT_CARD_PRINT_CSS}</style>

      {/* Toolbar (hidden in print) */}
      <div className="no-print">
        {/* Back link above the title, matching the other LP sub-pages. */}
        <Link href="/lps" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-2">
          <ArrowLeft className="h-3.5 w-3.5" /> LPs
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight mb-4">LP Reports</h1>

        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <label className="text-xs text-muted-foreground flex items-center gap-1"><Calendar className="h-3 w-3" /> As of</label>
          <Input type="date" value={asOf} onChange={e => { setAsOf(e.target.value); setApplied(e.target.value) }} className="h-9 w-40" />
          {applied && <Button size="sm" variant="ghost" onClick={() => { setAsOf(''); setApplied('') }}>Latest</Button>}
          <span className="flex-1" />
          {allGroups.length > 1 && (
            <PortfolioGroupFilter
              allGroups={allGroups}
              excludedGroups={excludedGroups}
              onToggle={g => setExcludedGroups(prev => { const n = new Set(prev); n.has(g) ? n.delete(g) : n.add(g); return n })}
              onToggleAll={() => setExcludedGroups(prev => prev.size === 0 ? new Set(allGroups) : new Set())}
            />
          )}
          <Button size="sm" variant="outline" onClick={printCombined} disabled={selected.size === 0 || printing || zipping}>
            {printing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Printer className="h-4 w-4 mr-1" />} Combined PDF
          </Button>
          <Button size="sm" variant="outline" onClick={downloadIndividual} disabled={selected.size === 0 || printing || zipping}>
            {zipping ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <FileDown className="h-4 w-4 mr-1" />}
            {zipping ? 'Generating…' : `Individual PDFs (${selected.size})`}
          </Button>
        </div>

        {zipping && (
          <p className="text-xs text-muted-foreground mb-3">
            Generating {selected.size} individual PDF{selected.size !== 1 ? 's' : ''}. This typically takes {selected.size <= 10 ? '5–15' : selected.size <= 50 ? '15–30' : '30–60'} seconds — keep this tab open.
          </p>
        )}

        {loading && !data ? (
          <div className="flex items-center py-16 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin mr-2" /> Building cards…</div>
        ) : investors.length === 0 ? (
          <p className="text-sm text-muted-foreground">No LP data to print.</p>
        ) : (
          <>
            {/* Search */}
            <div className="relative max-w-xl mb-3">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search investors…"
                className="w-full pl-8 pr-8 py-1.5 text-sm border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {search && (
                <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* Selection list */}
            <div className="border rounded-lg max-w-xl">
              <div className="flex items-center gap-3 px-4 py-2 border-b bg-muted cursor-pointer hover:bg-muted/80" onClick={toggleAll}>
                {selected.size === investors.length ? <CheckSquare className="h-4 w-4 text-primary" /> : <Square className="h-4 w-4 text-muted-foreground" />}
                <span className="text-sm font-medium">Select all ({investors.length} investors)</span>
              </div>
              <div className="max-h-[60vh] overflow-y-auto">
                {filtered.map(inv => (
                  <div key={inv.investorId} className="flex items-center gap-3 px-4 py-2 border-b last:border-b-0 cursor-pointer hover:bg-muted/30" onClick={() => toggle(inv.investorId)}>
                    {selected.has(inv.investorId) ? <CheckSquare className="h-4 w-4 text-primary shrink-0" /> : <Square className="h-4 w-4 text-muted-foreground shrink-0" />}
                    <span className="text-sm truncate">{inv.investorName}</span>
                    <span className="text-xs text-muted-foreground ml-auto shrink-0">{rowsFor(inv).length} inv.</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Printed cards — hidden on screen unless actively printing the combined PDF. */}
      <div className={printing ? 'space-y-8' : 'hidden print:block'}>
        {selectedInvestors.map((inv, i) => {
          const rows = rowsFor(inv)
          if (rows.length === 0) return null
          const excluded = excludedGroups.size === 0 ? [] :
            Array.from(new Set(inv.rows.filter(r => excludedGroups.has(r.portfolioGroup) && r.commitment > 0).map(r => r.portfolioGroup)))
          return (
            <div key={inv.investorId} className={i < selectedInvestors.length - 1 ? 'card-break' : ''}>
              <LpReportCard
                fundName={data!.fund.name}
                fundLogo={data!.fund.logo}
                fundAddress={data!.fund.address}
                investorName={inv.investorName}
                rows={rows}
                totals={totalsOf(rows)}
                description={data!.description}
                footerNote={data!.footer || undefined}
                asOfFormatted={formatAsOf(inv.asOf) ?? undefined}
                excludedNote={excluded}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
