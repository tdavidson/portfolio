'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Loader2, Landmark, ClipboardList, ArrowRight, Search, X } from 'lucide-react'
import { useCurrency, formatCurrency, formatCurrencyFull } from '@/components/currency-context'
import { useVehicle, useFundSeg } from '@/components/accounting-vehicle'
import { SortTh, nextSort, compareVals, type SortState } from '@/components/sortable-th'
import { Metric as MetricBox } from '@/components/ui/metric'
import { CapitalCharts } from '@/components/capital-charts'

// The fund overview: performance per vehicle, DERIVED FROM THE LEDGER.
//
// This is what used to be the Funds page, where the numbers were typed in — commitments,
// called capital and distributions were hand-entered `fund_cash_flows` rows, cash-on-hand was
// a hand-entered figure, and carry was ESTIMATED with a heuristic because there was no way to
// know the real number.
//
// There is now. Every figure here comes from the capital accounts, and an LP's account is
// already net of the carry the close accrued to the GP — so "net to LP" is exact rather than
// approximated, and there is nothing to type in and nothing to keep in sync.

interface Metrics {
  committed: number; paidIn: number; uncalled: number; distributions: number
  nav: number; totalValue: number
  dpi: number | null; rvpi: number | null; tvpi: number | null; irr: number | null
}
interface Vehicle {
  vehicle: string
  /** Stable registry id — the detail page routes on it. Null for legacy portfolio_group-only vehicles. */
  id: string | null
  vintageYear: number | null
  source: 'ledger' | 'events'
  lpCount: number
  fund: Metrics
  lp: Metrics
  // Absent when the viewer lacks gp_economics — the API omits them rather than zeroing them, so
  // "no carry" and "not allowed to see the carry" stay distinguishable. `lp` is already net of it.
  gp?: Metrics
  carryAccrued?: number
}

type Lens = 'lp' | 'fund'

const moic = (v: number | null) => (v == null ? '—' : `${v.toFixed(2)}x`)
const irrPct = (v: number | null) => {
  if (v == null) return '—'
  const p = v * 100
  return `${(Object.is(p, -0) ? 0 : p).toFixed(1)}%`
}

export function FundOverview() {
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrency(v, currency)
  const fmtFull = (v: number) => formatCurrencyFull(v, currency)
  const router = useRouter()
  const { setVehicle } = useVehicle()
  const fundSeg = useFundSeg()

  // Clicking a vehicle selects it (localStorage-backed context the whole section reads) and opens
  // its detail page — the lead page for the fund. Admin (/funds/status) is reached from there.
  // Route on the stable id (like companies and LPs); a legacy vehicle without one falls back to
  // its name, which the detail page resolves the same way.
  const openVehicle = (v: Vehicle) => {
    setVehicle(v.vehicle, v.id)
    router.push(`/funds/${v.id ?? encodeURIComponent(v.vehicle)}`)
  }

  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [loading, setLoading] = useState(true)
  const [asOf, setAsOf] = useState('')
  const [lens, setLens] = useState<Lens>('lp')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortState>({ key: 'committed', dir: 'desc' })
  const onSort = (key: string) => setSort(s => nextSort(s, key, key === 'vehicle' ? 'asc' : 'desc'))

  const load = useCallback(() => {
    setLoading(true)
    const qs = asOf ? `?asOf=${asOf}` : ''
    fetch(`/api/accounting/fund-economics${qs}`)
      .then(r => (r.ok ? r.json() : { vehicles: [] }))
      .then(d => setVehicles(d.vehicles ?? []))
      .finally(() => setLoading(false))
  }, [asOf])
  useEffect(() => { load() }, [load])

  if (loading) {
    return (
      <div className="rounded-card border p-6 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Deriving fund performance from the ledger…
      </div>
    )
  }

  // A vehicle with no capital of any kind — commitment, paid-in, distributions or NAV all
  // zero — has nothing to report yet (it exists, but no LP capital has been recorded against
  // it). Showing it is a row of dashes that adds noise, so it is left out.
  const live = vehicles.filter(v =>
    v.fund.committed !== 0 || v.fund.paidIn !== 0 || v.fund.distributions !== 0 || v.fund.nav !== 0
  )
  if (live.length === 0) return <OnboardingEmptyState />

  // The Net-to-LP / Whole-fund toggle only means something when there IS a GP class to carve
  // out. Tracking vehicles cut over from an LP snapshot have only LP-class partners, so net-to-LP
  // and whole-fund are identical and the toggle would look dead. Show it only when it changes a
  // number.
  const hasGpSplit = live.some(v => (v.gp?.paidIn ?? 0) !== 0 || (v.gp?.nav ?? 0) !== 0 || (v.carryAccrued ?? 0) !== 0)
  const effectiveLens: Lens = hasGpSplit ? lens : 'fund'
  const m = (v: Vehicle) => (effectiveLens === 'lp' ? v.lp : v.fund)

  // Search + source filters apply to both the table and the metric boxes, so the totals always
  // describe exactly what's shown.
  const q = search.trim().toLowerCase()
  const filtered = live.filter(v =>
    (!q || v.vehicle.toLowerCase().includes(q))
  )
  const sortVal = (v: Vehicle): number | string | null =>
    sort.key === 'vehicle' ? v.vehicle : sort.key === 'vintageYear' ? v.vintageYear : (m(v) as any)[sort.key] as number | null
  const sorted = [...filtered].sort((a, b) => compareVals(sortVal(a), sortVal(b), sort.dir) || a.vehicle.localeCompare(b.vehicle))

  const totals = filtered.reduce((acc, v) => {
    const x = m(v)
    acc.committed += x.committed; acc.paidIn += x.paidIn; acc.uncalled += x.uncalled
    acc.distributions += x.distributions; acc.nav += x.nav; acc.totalValue += x.totalValue
    acc.carry += v.carryAccrued ?? 0
    return acc
  }, { committed: 0, paidIn: 0, uncalled: 0, distributions: 0, nav: 0, totalValue: 0, carry: 0 })

  // Ratios computed AFTER summing — never averaged across vehicles.
  const tTvpi = totals.paidIn > 0 ? totals.totalValue / totals.paidIn : null
  const tDpi = totals.paidIn > 0 ? totals.distributions / totals.paidIn : null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Left: filters, to balance the "As of" control on the right. */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search vehicles…"
              className="h-8 w-48 pl-8 pr-8 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>


          {/* Net to LP is the honest default: what an LP would actually receive, now exact rather
              than a carry estimate. Only shown when a GP class exists to carve out — otherwise the
              two lenses are identical and the control looks dead. */}
          {hasGpSplit && (
            <div className="inline-flex rounded-md border p-0.5 text-xs">
              {(['lp', 'fund'] as Lens[]).map(l => (
                <button
                  key={l}
                  onClick={() => setLens(l)}
                  className={`px-2 py-1 rounded ${lens === l ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
                >
                  {l === 'lp' ? 'Net to LP' : 'Whole fund'}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Label to the LEFT of the input, on one line. */}
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          As of
          <input
            type="date"
            value={asOf}
            onChange={e => setAsOf(e.target.value)}
            className="h-8 px-2 rounded-md border border-input bg-background text-sm"
          />
        </label>
      </div>

      {/* Metric boxes — same Card treatment as an LP snapshot, so the two pages read as one. */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
        <MetricBox label="Committed" value={fmt(totals.committed)} />
        <MetricBox label="Called" value={fmt(totals.paidIn)} />
        <MetricBox label="Distributed" value={fmt(totals.distributions)} />
        <MetricBox label="NAV" value={fmt(totals.nav)} />
        <MetricBox label="TVPI" value={moic(tTvpi)} />
        <MetricBox label="DPI" value={moic(tDpi)} />
      </div>

      {/* Charts — the vehicles the table lists, through the same lens. They open on multiples:
          vehicles differ in size by design, so dollars would mostly rank them by size. */}
      <CapitalCharts
        positions={filtered.map(v => {
          const x = m(v)
          return { key: v.vehicle, name: v.vehicle, committed: x.committed, called: x.paidIn, distributions: x.distributions, nav: x.nav }
        })}
        noun="vehicles"
        defaultScale="multiple"
        onSelect={name => { const v = filtered.find(f => f.vehicle === name); if (v) openVehicle(v) }}
      />

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground bg-muted/40">
            <tr>
              <SortTh label="Vehicle" sortKey="vehicle" sort={sort} onSort={onSort} />
              <SortTh label="Vintage" sortKey="vintageYear" sort={sort} onSort={onSort} />
              <SortTh label="Committed" sortKey="committed" sort={sort} onSort={onSort} align="right" />
              <SortTh label="Called" sortKey="paidIn" sort={sort} onSort={onSort} align="right" />
              <SortTh label="Not called" sortKey="uncalled" sort={sort} onSort={onSort} align="right" />
              <SortTh label="Distributed" sortKey="distributions" sort={sort} onSort={onSort} align="right" />
              <SortTh label="NAV" sortKey="nav" sort={sort} onSort={onSort} align="right" />
              <SortTh label="DPI" sortKey="dpi" sort={sort} onSort={onSort} align="right" />
              <SortTh label="RVPI" sortKey="rvpi" sort={sort} onSort={onSort} align="right" />
              <SortTh label="TVPI" sortKey="tvpi" sort={sort} onSort={onSort} align="right" />
              <SortTh label="IRR" sortKey="irr" sort={sort} onSort={onSort} align="right" />
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr><td colSpan={11} className="px-3 py-8 text-center text-muted-foreground">No vehicles match your filters.</td></tr>
            )}
            {sorted.map(v => {
              const x = m(v)
              return (
                <tr key={v.vehicle} className="border-t hover:bg-muted/30">
                  <td className="px-3 py-2 font-medium">
                    <button onClick={() => openVehicle(v)} title={v.vehicle} className="text-left hover:underline hover:text-foreground truncate max-w-[220px] block">
                      {v.vehicle}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground tabular-nums">{v.vintageYear ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtFull(x.committed)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtFull(x.paidIn)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{fmtFull(x.uncalled)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtFull(x.distributions)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtFull(x.nav)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{moic(x.dpi)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{moic(x.rvpi)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium">{moic(x.tvpi)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{irrPct(x.irr)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground max-w-3xl">
        Every figure is derived from the capital accounts.{' '}
        {effectiveLens === 'lp' ? (
          <>
            <strong>Net to LP</strong> is the LP-class partners&rsquo; own accounts, so the GP&rsquo;s carry
            {totals.carry !== 0 && <> ({fmtFull(totals.carry)} accrued)</>} is already deducted.
          </>
        ) : (
          <><strong>Whole fund</strong> is every partner, GP included.</>
        )}{' '}
        Capital is recognised when it is called, so called capital may be
        unfunded.
      </p>
    </div>
  )
}

/** Same card treatment as the LP snapshot metric boxes, so the two pages read as one. */

/**
 * Shown when no vehicle carries any capital yet — so instead of an empty table, explain the
 * two ways to onboard one. They are the same two producers the whole section is built on:
 * capital tracking (events, no books) and the full ledger. Both land in the same capital
 * accounts and feed this overview identically.
 */
function OnboardingEmptyState() {
  const fundSeg = useFundSeg()
  return (
    <div className="rounded-card border p-6 max-w-2xl space-y-5">
      <div className="space-y-1">
        <h2 className="text-base font-medium">No fund capital recorded yet</h2>
        <p className="text-sm text-muted-foreground">
          This overview is derived from the capital accounts, so it fills in once a vehicle has capital against it.
          There are two ways to get there — pick per vehicle, and both feed this page the same way.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-card border p-3 space-y-1.5">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-muted-foreground" />
            <p className="text-sm font-medium">Capital tracking</p>
          </div>
          <p className="text-xs text-muted-foreground">
            No double-entry books. Record what moved each LP&rsquo;s capital — contributions, distributions, marks — and
            the roll-forward, statements and LP report all follow. The quickest way to start, and enough for an SPV or a
            fund whose admin sends a quarterly statement.
          </p>
        </div>
        <div className="rounded-card border p-3 space-y-1.5">
          <div className="flex items-center gap-2">
            <Landmark className="h-4 w-4 text-muted-foreground" />
            <p className="text-sm font-medium">Full ledger</p>
          </div>
          <p className="text-xs text-muted-foreground">
            Double-entry books: a chart of accounts, journal entries, capital calls against a receivable, period closes
            that accrue carry, and financial statements. More to set up, and the complete record.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">Two ways in:</p>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/settings"
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-accent transition-colors"
          >
            Add a vehicle
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
          <Link
            href={fundSeg ? `/funds/${fundSeg}/capital-accounts` : '/funds'}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-accent transition-colors"
          >
            Add LPs &amp; capital
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
          <Link
            href={fundSeg ? `/funds/${fundSeg}/opening-balances` : '/funds'}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-accent transition-colors"
          >
            Import an existing snapshot
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </div>
  )
}
