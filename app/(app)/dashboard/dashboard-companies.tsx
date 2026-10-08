'use client'

import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { ArrowDownAZ, ArrowUpZA, ArrowDown, ArrowUp, LayoutGrid, Table2, CalendarDays } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DashboardTable } from './dashboard-table'
import { AddCompanyButton } from '@/components/add-company-button'
import { useCurrency, getCurrencySymbol } from '@/components/currency-context'
import { matchesVehicle, vehicleFilterOptions } from './vehicle-filter'
import { isNewCompany } from '@/lib/investments'

interface ActiveMetric {
  id: string
  name: string
  unit: string | null
  unit_position: string
  value_type: string
  currency: string | null
}

interface Company {
  id: string
  name: string
  stage: string | null
  status: string
  createdAt?: string | null
  tags: string[]
  industry: string[] | null
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

interface Props {
  companies: Company[]
  allGroups: string[]
  canAdd?: boolean
}

type SortMode = 'alpha' | 'investDate' | null

function formatMetricValue(v: number | null, metric: ActiveMetric, fundCurrency: string): string {
  if (v === null) return '\u2014'
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
  return neg ? `-${str}` : str
}

export function DashboardCompanies({ companies, allGroups, canAdd }: Props) {
  const [view, setView] = useState<'cards' | 'table'>('cards')
  const [statusFilter, setStatusFilter] = useState<string>('active')
  const [vehicleFilter, setVehicleFilter] = useState<string>('')
  const [sortMode, setSortMode] = useState<SortMode>('investDate')
  const [alphaSortAsc, setAlphaSortAsc] = useState(true)
  const [investDateSortAsc, setInvestDateSortAsc] = useState(false) // newest first by default

  const filtered = useMemo(() => {
    let result = companies
    if (statusFilter) {
      result = result.filter(c => c.status === statusFilter)
    }
    if (vehicleFilter) {
      result = result.filter(c => matchesVehicle(c, vehicleFilter))
    }
    return result
  }, [companies, statusFilter, vehicleFilter])

  const vehicleOptions = useMemo(() => vehicleFilterOptions(allGroups, companies), [allGroups, companies])

  function sortCompanies(list: Company[]) {
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

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sortedFiltered = useMemo(() => sortCompanies(filtered), [filtered, sortMode, alphaSortAsc, investDateSortAsc])

  return (
    <div>
      {/* Filter bar */}
      {companies.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap mb-4">
          {canAdd && <AddCompanyButton />}
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-3 text-xs"
          >
            <option value="">All Statuses</option>
            <option value="active">Active</option>
            <option value="exited">Exited</option>
            <option value="written-off">Written Off</option>
          </select>
          {vehicleOptions.length > 0 && (
            <select
              value={vehicleFilter}
              onChange={e => setVehicleFilter(e.target.value)}
              aria-label="Filter by vehicle"
              className="h-8 max-w-[14rem] rounded-md border border-input bg-background px-3 text-xs"
            >
              <option value="">All Vehicles</option>
              {vehicleOptions.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
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
          {companies.length === 0 ? (
            <>
              <p className="text-muted-foreground">No portfolio companies yet.</p>
              {canAdd && <div className="flex justify-center"><AddCompanyButton /></div>}
            </>
          ) : (
            <p className="text-muted-foreground">No companies match the selected filters.</p>
          )}
        </div>
      ) : view === 'table' ? (
        <DashboardTable
          companyIds={sortedFiltered.map(c => c.id)}
          grouped={null}
        />
      ) : (
        <CompanyGrid companies={sortedFiltered} />
      )}
    </div>
  )
}

function CompanyGrid({ companies }: { companies: Company[] }) {
  const fundCurrency = useCurrency()
  // Cache of fetched metric values: { [metricId]: number | null }
  const [metricValues, setMetricValues] = useState<Record<string, number | null>>({})
  const [loadingMetrics, setLoadingMetrics] = useState<Set<string>>(new Set())
  const fetchedRef = useRef<Set<string>>(new Set())

  // Get display metrics for a company: cash first, then first non-cash
  const getSelectedMetrics = useCallback((c: Company): [ActiveMetric | null, ActiveMetric | null] => {
    const cashMetric = c.activeMetrics.find(m => m.name.toLowerCase() === 'cash' || /\bcash\b/i.test(m.name)) ?? null
    if (cashMetric) {
      const nonCashMetric = c.activeMetrics.find(m => m !== cashMetric) ?? null
      return [cashMetric, nonCashMetric]
    }
    // No cash metric — show first two by display order
    return [c.activeMetrics[0] ?? null, c.activeMetrics[1] ?? null]
  }, [])

  // Fetch metric values for visible cards
  useEffect(() => {
    const metricsToFetch: { companyId: string; metricId: string }[] = []
    for (const c of companies) {
      if (c.status === 'exited' || c.status === 'written-off') continue
      const [m1, m2] = getSelectedMetrics(c)
      for (const m of [m1, m2]) {
        if (m && !fetchedRef.current.has(m.id)) {
          metricsToFetch.push({ companyId: c.id, metricId: m.id })
          fetchedRef.current.add(m.id)
        }
      }
    }

    if (metricsToFetch.length === 0) return

    setLoadingMetrics(prev => {
      const next = new Set(prev)
      metricsToFetch.forEach(({ metricId }) => next.add(metricId))
      return next
    })

    for (const { companyId, metricId } of metricsToFetch) {
      fetch(`/api/companies/${companyId}/metrics/${metricId}/values`)
        .then(res => res.ok ? res.json() : [])
        .then((values: { value_number: number | null }[]) => {
          const lastVal = values.length > 0 ? values[values.length - 1].value_number : null
          setMetricValues(prev => ({ ...prev, [metricId]: lastVal }))
          setLoadingMetrics(prev => {
            const next = new Set(prev)
            next.delete(metricId)
            return next
          })
        })
        .catch(() => {
          setLoadingMetrics(prev => {
            const next = new Set(prev)
            next.delete(metricId)
            return next
          })
        })
    }
  }, [companies, getSelectedMetrics])

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {companies.map((c) => {
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
                  company={c}
                  metrics={getSelectedMetrics(c)}
                  metricValues={metricValues}
                  loadingMetrics={loadingMetrics}
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

function ActiveMetricDisplay({ company, metrics, metricValues, loadingMetrics, fundCurrency }: {
  company: Company
  metrics: [ActiveMetric | null, ActiveMetric | null]
  metricValues: Record<string, number | null>
  loadingMetrics: Set<string>
  fundCurrency: string
}) {
  const [m1, m2] = metrics

  return (
    <div className="grid grid-cols-2 gap-3 mt-3">
      {[m1, m2].map((metric, i) => {
        if (!metric) return <div key={i} />
        const isLoading = loadingMetrics.has(metric.id)
        const value = metricValues[metric.id] ?? null
        return (
          <div key={metric.id} className="min-w-0">
            <div className="text-[10px] text-muted-foreground truncate mb-0.5">{metric.name}</div>
            <div className="text-xl font-semibold tabular-nums truncate">
              {isLoading ? (
                <span className="text-muted-foreground text-sm">...</span>
              ) : (
                formatMetricValue(value, metric, fundCurrency)
              )}
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
        <div className="text-[10px] text-muted-foreground truncate mb-0.5">Net Gain</div>
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

