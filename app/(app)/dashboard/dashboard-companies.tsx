'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { ArrowDownAZ, ArrowUpZA, ArrowDown, ArrowUp, LayoutGrid, Table2, CalendarDays, Search, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DashboardTable } from './dashboard-table'
import { AddCompanyButton } from '@/components/add-company-button'
import { useCurrency, getCurrencySymbol, formatCurrency as formatCompactCurrency } from '@/components/currency-context'
import { EntityPicker } from './entity-picker'
import { companyInSelection, type EntityOption } from '@/lib/dashboard/entity-selection'
import { isNewCompany } from '@/lib/investments'
import { searchCompanies } from '@/lib/dashboard/company-search'
import { useAppNavigate } from '@/components/app-runtime'
import type { PortfolioSheetState } from '@/components/portfolio-sheet'
import type { SheetRow } from '@/lib/portfolio/sheet'

interface ActiveMetric {
  id: string
  name: string
  unit: string | null
  unit_position: string
  value_type: string
  currency: string | null
  latestValue?: number | null
}

interface Company {
  id: string
  name: string
  stage: string | null
  status: string
  createdAt?: string | null
  tags: string[]
  industry: string[] | null
  aliases?: string[]
  portfolioGroup: string[] | null
  lastReportAt: string | null
  openReviews: number
  activeMetrics: ActiveMetric[]
  latestCash: number | null
  firstInvestmentDate: string | null
  moic: number | null
  grossIrr: number | null
  totalInvested: number | null
  totalRealized: number | null
  unrealizedValue: number | null
}

/** A fund holding (companies.holding_type = 'fund'): a card in the same grid as the companies. */
interface FundHolding {
  id: string
  name: string
  status: string
  createdAt?: string | null
  tags: string[]
  aliases?: string[]
  portfolioGroup: string[] | null
  /** First capital call, in the viewer's entities. */
  firstInvestmentDate: string | null
}

type GridItem = (Company & { kind: 'company' }) | (FundHolding & { kind: 'fund' })

interface Props {
  companies: Company[]
  fundHoldings?: FundHolding[]
  /** The portfolio sheet the page fetched: a fund card's NAV, multiple and commitment. */
  fundFigures?: PortfolioSheetState
  view: 'cards' | 'table'
  onViewChange: (view: 'cards' | 'table') => void
  canAdd?: boolean
  /** The entity selection, held by the page so the holdings sheet follows it too. */
  entities: {
    options: EntityOption[]
    excluded: string[]
    hasSaved: boolean
    onChange: (excluded: string[], hasSaved: boolean) => void
  }
}

type SortMode = 'alpha' | 'investDate' | null

function formatMetricValue(v: number | null, metric: ActiveMetric, fundCurrency: string): string {
  if (v === null) return '\u2014'
  // A negative amount reads in accounting parentheses, as every money figure in the app does.
  if (v < 0 && metric.value_type === 'currency') return `(${formatMetricValue(-v, metric, fundCurrency)})`
  const metricCurrency = metric.currency ?? fundCurrency
  const effectiveUnit = metric.unit ?? (metric.value_type === 'currency' ? getCurrencySymbol(metricCurrency) : null)
  const effectivePos = metric.unit ? metric.unit_position : 'prefix'
  let str: string
  if (Math.abs(v) >= 1_000_000) str = `${(v / 1_000_000).toFixed(1)}M`
  else if (Math.abs(v) >= 1_000) str = `${(v / 1_000).toFixed(0)}K`
  else str = v.toLocaleString()
  if (effectiveUnit && effectivePos === 'prefix') return `${effectiveUnit}${str}`
  if (metric.value_type === 'percentage') return `${str}%`
  if (effectiveUnit && effectivePos === 'suffix') return `${str} ${effectiveUnit}`
  return str
}

function formatCurrency(v: number): string {
  const neg = v < 0
  const abs = Math.abs(v)
  let str: string
  if (abs >= 1_000_000) str = `$${(abs / 1_000_000).toFixed(1)}M`
  else if (abs >= 1_000) str = `$${(abs / 1_000).toFixed(0)}K`
  else str = `$${abs.toLocaleString()}`
  return neg ? `(${str})` : str
}

export function DashboardCompanies({ companies, fundHoldings = [], fundFigures, view, onViewChange: setView, canAdd, entities }: Props) {
  const [statusFilter, setStatusFilter] = useState<string>('active')
  const [sortMode, setSortMode] = useState<SortMode>('investDate')
  const [alphaSortAsc, setAlphaSortAsc] = useState(true)
  const [investDateSortAsc, setInvestDateSortAsc] = useState(false) // newest first by default
  const [query, setQuery] = useState('')
  const navigate = useAppNavigate()
  const searching = query.trim() !== ''

  // Companies and fund holdings in one list, so a fund sorts, filters and searches like a company.
  const items = useMemo<GridItem[]>(() => [
    ...companies.map(c => ({ ...c, kind: 'company' as const })),
    ...fundHoldings.map(f => ({ ...f, kind: 'fund' as const })),
  ], [companies, fundHoldings])

  const filtered = useMemo(() => {
    // A search is for getting to one holding fast, so it looks past the status and entity filters:
    // an exited company, or one held only by an entity left out of the picker, is still found.
    if (searching) return searchCompanies(query, items)
    let result = items
    if (statusFilter) {
      result = result.filter(c => c.status === statusFilter)
    }
    if (entities.excluded.length > 0) {
      result = result.filter(c => companyInSelection(c.portfolioGroup, entities.options, entities.excluded))
    }
    return result
  }, [items, statusFilter, entities.options, entities.excluded, searching, query])

  function sortCompanies(list: GridItem[]) {
    if (sortMode === 'alpha') {
      return [...list].sort((a, b) =>
        alphaSortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)
      )
    }
    if (sortMode === 'investDate') {
      return [...list].sort((a, b) => {
        const aDate = a.firstInvestmentDate
        const bDate = b.firstInvestmentDate
        if (!aDate && !bDate) return 0
        if (!aDate) return 1
        if (!bDate) return -1
        return investDateSortAsc ? aDate.localeCompare(bDate) : bDate.localeCompare(aDate)
      })
    }
    return list
  }

  // While searching, best match first: Enter opens the first one shown.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sortedFiltered = useMemo(() => (searching ? filtered : sortCompanies(filtered)), [filtered, searching, sortMode, alphaSortAsc, investDateSortAsc])

  return (
    <div>
      {/* Filter bar */}
      {items.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap mb-4">
          {canAdd && <AddCompanyButton />}
          <div className="relative w-full sm:w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && sortedFiltered[0]) { e.preventDefault(); navigate(`/companies/${sortedFiltered[0].id}`) }
                else if (e.key === 'Escape' && query) { e.preventDefault(); setQuery('') }
              }}
              placeholder="Search portfolio…"
              aria-label="Search portfolio companies and funds"
              autoComplete="off"
              spellCheck={false}
              className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-7 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-3 text-xs"
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="exited">Exited</option>
            <option value="written-off">Written off</option>
          </select>
          {entities.options.length > 0 && (
            <EntityPicker
              options={entities.options}
              excluded={entities.excluded}
              hasSaved={entities.hasSaved}
              onChange={entities.onChange}
            />
          )}
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant={sortMode === 'alpha' ? 'secondary' : 'ghost'}
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                if (sortMode === 'alpha') {
                  setAlphaSortAsc(prev => !prev)
                } else {
                  setSortMode('alpha')
                }
              }}
            >
              {alphaSortAsc ? (
                <ArrowDownAZ className="h-3.5 w-3.5" />
              ) : (
                <ArrowUpZA className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button
              variant={sortMode === 'investDate' ? 'secondary' : 'ghost'}
              size="sm"
              className="text-xs gap-1.5 text-muted-foreground hover:text-foreground"
              onClick={() => {
                if (sortMode === 'investDate') {
                  setInvestDateSortAsc(prev => !prev)
                } else {
                  setSortMode('investDate')
                }
              }}
            >
              <CalendarDays className="h-3.5 w-3.5" />
              {investDateSortAsc ? (
                <ArrowUp className="h-3 w-3" />
              ) : (
                <ArrowDown className="h-3 w-3" />
              )}
            </Button>
            <Button variant={view === 'cards' ? 'secondary' : 'ghost'} size="sm" className="text-muted-foreground hover:text-foreground" onClick={() => setView('cards')}>
              <LayoutGrid className="h-3.5 w-3.5" />
            </Button>
            <Button variant={view === 'table' ? 'secondary' : 'ghost'} size="sm" className="text-muted-foreground hover:text-foreground" onClick={() => setView('table')}>
              <Table2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-card border border-dashed p-12 text-center space-y-3">
          {items.length === 0 ? (
            <>
              <p className="text-muted-foreground">No portfolio companies yet.</p>
              {canAdd && <div className="flex justify-center"><AddCompanyButton /></div>}
            </>
          ) : (
            <p className="text-muted-foreground">
              {searching ? <>No companies match “{query.trim()}”.</> : 'No companies match the selected filters.'}
            </p>
          )}
        </div>
      ) : view === 'table' ? (
        // The table carries company KPIs; fund holdings are listed in the funds table below it.
        sortedFiltered.some(c => c.kind === 'company') ? (
          <DashboardTable
            companyIds={sortedFiltered.filter(c => c.kind === 'company').map(c => c.id)}
            grouped={null}
          />
        ) : null
      ) : (
        <CompanyGrid items={sortedFiltered} fundFigures={fundFigures} />
      )}
    </div>
  )
}

function CompanyGrid({ items, fundFigures }: { items: GridItem[]; fundFigures?: PortfolioSheetState }) {
  const fundCurrency = useCurrency()
  const fundRows = useMemo(() => {
    const byId = new Map<string, SheetRow>()
    for (const r of fundFigures?.data?.sheet.funds ?? []) if (r.companyId) byId.set(r.companyId, r)
    return byId
  }, [fundFigures])
  const figuresPending = !!fundFigures && !fundFigures.data && !fundFigures.error
  // Get display metrics for a company: cash first, then first non-cash
  const getSelectedMetrics = (c: Company): [ActiveMetric | null, ActiveMetric | null] => {
    const cashMetric = c.activeMetrics.find(m => m.name.toLowerCase() === 'cash' || /\bcash\b/i.test(m.name)) ?? null
    if (cashMetric) {
      const nonCashMetric = c.activeMetrics.find(m => m !== cashMetric) ?? null
      return [cashMetric, nonCashMetric]
    }
    // No cash metric — show first two by display order
    return [c.activeMetrics[0] ?? null, c.activeMetrics[1] ?? null]
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {items.map((c) => {
        if (c.kind === 'fund') {
          return <FundCard key={c.id} fund={c} row={fundRows.get(c.id) ?? null} pending={figuresPending} currency={fundCurrency} />
        }
        const isExited = c.status === 'exited' || c.status === 'written-off'

        return (
          <Link
            key={c.id}
            href={`/companies/${c.id}`}
            className="rounded-card border bg-card p-4 hover:bg-accent/50 transition-colors"
          >
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-sm">{c.name}</span>
                {c.openReviews > 0 && (
                  <span className="rounded-full bg-warning text-white text-[10px] font-semibold leading-none px-1.5 py-0.5 min-w-[18px] text-center">
                    {c.openReviews}
                  </span>
                )}
              </div>
              {isExited ? (
                <ExitedMetricDisplay company={c} />
              ) : c.activeMetrics.length === 0 ? (
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <div className="min-w-0">
                    {isNewCompany(c.firstInvestmentDate, c.createdAt ?? null) ? (
                      <>
                        <div className="text-[10px] text-muted-foreground truncate mb-0.5">No metrics</div>
                        <div className="text-xl font-semibold">New</div>
                      </>
                    ) : (
                      <div className="text-xs text-muted-foreground">No metrics reported</div>
                    )}
                  </div>
                </div>
              ) : (
                <ActiveMetricDisplay
                  metrics={getSelectedMetrics(c)}
                  fundCurrency={fundCurrency}
                />
              )}
              {c.lastReportAt ? (
                <div className="text-[10px] text-muted-foreground mt-2">
                  Last reported: {c.lastReportAt}
                </div>
              ) : c.firstInvestmentDate ? (
                <div className="text-[10px] text-muted-foreground mt-2">
                  Invested: {new Date(c.firstInvestmentDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </div>
              ) : null}
          </Link>
        )
      })}
    </div>
  )
}

function ActiveMetricDisplay({ metrics, fundCurrency }: {
  metrics: [ActiveMetric | null, ActiveMetric | null]
  fundCurrency: string
}) {
  const [m1, m2] = metrics

  return (
    <div className="grid grid-cols-2 gap-3 mt-3">
      {[m1, m2].map((metric, i) => {
        if (!metric) return <div key={i} />
        const value = metric.latestValue ?? null
        return (
          <div key={metric.id} className="min-w-0">
            <div className="text-[10px] text-muted-foreground truncate mb-0.5">{metric.name}</div>
            <div className="text-xl font-semibold tabular-nums truncate">
              {formatMetricValue(value, metric, fundCurrency)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ExitedMetricDisplay({ company }: { company: Company }) {
  const { totalInvested, totalRealized, unrealizedValue, moic } = company
  const netGain = totalInvested != null && totalRealized != null && unrealizedValue != null
    ? (totalRealized + unrealizedValue) - totalInvested
    : null

  return (
    <div className="grid grid-cols-2 gap-3 mt-3">
      <div className="min-w-0">
        <div className="text-[10px] text-muted-foreground truncate mb-0.5">Net gain</div>
        <div className={`text-xl font-semibold tabular-nums truncate ${netGain != null && netGain < 0 ? 'text-destructive' : ''}`}>
          {netGain != null ? formatCurrency(netGain) : '\u2014'}
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-[10px] text-muted-foreground truncate mb-0.5">Gross MOIC</div>
        <div className="text-xl font-semibold tabular-nums truncate">
          {moic != null ? `${moic.toFixed(2)}x` : '\u2014'}
        </div>
      </div>
    </div>
  )
}


/**
 * A fund holding's card, in the company cards' layout: its NAV and multiple where a company shows
 * two metrics, and its commitment where a company shows when it last reported. The figures are the
 * portfolio sheet's (the schedule of investments), summed over the entities in the picker.
 */
function FundCard({ fund, row, pending, currency }: { fund: FundHolding; row: SheetRow | null; pending: boolean; currency: string }) {
  const pctCalled = row && row.commitment > 0 ? Math.round((row.called / row.commitment) * 100) : null
  const value = (text: string) => pending
    ? <div className="h-7 w-16 rounded-md bg-muted animate-pulse" />
    : <div className="text-xl font-semibold tabular-nums truncate">{text}</div>
  const footer = row
    ? [
        row.commitment > 0 ? `Committed ${formatCompactCurrency(row.commitment, currency)}` : null,
        pctCalled != null ? `${pctCalled}% called` : null,
        row.navAsOf ? `NAV as of ${formatShortDate(row.navAsOf)}` : null,
      ].filter(Boolean).join(' · ')
    : fund.firstInvestmentDate
      ? `First call: ${formatShortDate(fund.firstInvestmentDate)}`
      : ''

  return (
    <Link
      href={`/companies/${fund.id}`}
      className="rounded-card border bg-card p-4 hover:bg-accent/50 transition-colors"
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="font-medium text-sm truncate">{fund.name}</span>
        <Badge variant="outline" className="shrink-0 text-[10px] font-normal text-muted-foreground px-1.5 py-0">Fund</Badge>
      </div>
      <div className="grid grid-cols-2 gap-3 mt-3">
        <div className="min-w-0">
          <div className="text-[10px] text-muted-foreground truncate mb-0.5">NAV</div>
          {value(row ? formatCompactCurrency(row.fairValue, currency) : '\u2014')}
        </div>
        <div className="min-w-0">
          <div className="text-[10px] text-muted-foreground truncate mb-0.5">TVPI</div>
          {value(row?.moic != null ? `${row.moic.toFixed(2)}x` : '\u2014')}
        </div>
      </div>
      {footer && <div className="text-[10px] text-muted-foreground mt-2 truncate">{footer}</div>}
    </Link>
  )
}

function formatShortDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}
