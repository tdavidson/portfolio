'use client'

import React, { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import { useCurrency, getCurrencySymbol } from '@/components/currency-context'
import { EmptyState } from '@/components/ui/empty-state'

interface MetricData {
  id: string
  name: string
  unit: string | null
  unitPosition: string
  valueType: string
  currency: string | null
  values: Record<string, number | string | null>
}

interface CompanyData {
  id: string
  name: string
  stage: string | null
  industry: string[] | null
  portfolioGroup: string[] | null
  tags: string[]
  latestCash: number | null
  metrics: MetricData[]
}

interface Props {
  companyIds: string[]
  grouped: [string, string[]][] | null
}

function formatValue(v: number | string | null, metric: MetricData, fundCurrency?: string): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v
  let str: string
  if (Math.abs(v) >= 1_000_000) str = `${(v / 1_000_000).toFixed(1)}M`
  else if (Math.abs(v) >= 1_000) str = `${(v / 1_000).toFixed(0)}K`
  else str = v.toLocaleString()
  const metricCurrency = metric.currency ?? fundCurrency
  const currencySymbol = metricCurrency ? getCurrencySymbol(metricCurrency) : null
  const effectiveUnit = metric.unit ?? (metric.valueType === 'currency' && currencySymbol ? currencySymbol : null)
  const effectivePos = metric.unit ? metric.unitPosition : 'prefix'
  if (effectiveUnit && effectivePos === 'prefix') return `${effectiveUnit}${str}`
  if (metric.valueType === 'percentage') return `${str}%`
  if (effectiveUnit && effectivePos === 'suffix') return `${str} ${effectiveUnit}`
  return str
}

export function DashboardTable({ companyIds, grouped }: Props) {
  const fundCurrency = useCurrency()
  const [data, setData] = useState<CompanyData[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    async function load() {
      try {
        const res = await fetch('/api/dashboard/table-data', { signal: controller.signal })
        if (!res.ok) throw new Error('Portfolio table unavailable')
        if (res.ok) {
          const json = await res.json()
          if (!cancelled) setData(json.companies)
        }
      } catch {
        if (!cancelled) setLoadError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true; controller.abort() }
  }, [])

  // Index companies by ID for fast lookup
  const companyMap = useMemo(() => {
    if (!data) return new Map<string, CompanyData>()
    const map = new Map<string, CompanyData>()
    for (const c of data) map.set(c.id, c)
    return map
  }, [data])

  // Determine quarter columns from all data
  const quarterColumns = useMemo(() => {
    if (!data) return []
    const quarters = new Set<string>()
    for (const c of data) {
      for (const m of c.metrics) {
        for (const key of Object.keys(m.values)) {
          quarters.add(key)
        }
      }
    }
    // Sort chronologically: Q1 2025, Q2 2025, ..., Q1 2026
    return Array.from(quarters).sort((a, b) => {
      const [qa, ya] = a.split(' ')
      const [qb, yb] = b.split(' ')
      const yearDiff = Number(ya) - Number(yb)
      if (yearDiff !== 0) return yearDiff
      return Number(qa[1]) - Number(qb[1])
    })
  }, [data])

  if (loading) {
    return (
      <div className="rounded-card border border-dashed p-12 text-center">
        <p className="text-muted-foreground text-sm">Loading table data…</p>
      </div>
    )
  }

  if (loadError) return <p role="alert" className="text-sm text-muted-foreground">Could not load the portfolio table. Refresh this page to try again.</p>

  if (!data || data.length === 0) {
    return (
      <EmptyState>No data available.</EmptyState>
    )
  }

  const companyColWidth = 110
  const metricColWidth = 100

  function renderCompanyRows(ids: string[]) {
    const rows: React.ReactNode[] = []
    for (const id of ids) {
      const company = companyMap.get(id)
      if (!company) continue
      const metrics = company.metrics.length > 0 ? company.metrics : [null]

      metrics.forEach((metric, mIdx) => {
        rows.push(
          <tr
            key={`${id}-${metric?.id ?? 'empty'}`}
            className={`${mIdx === 0 ? 'border-t border-border' : ''} hover:bg-muted/50`}
          >
            {/* Company name - only on first metric row */}
            <td
              className="sticky left-0 z-10 bg-card px-2 py-1.5 text-xs font-medium truncate"
              style={{ width: companyColWidth, minWidth: companyColWidth }}
            >
              {mIdx === 0 ? (
                <Link href={`/companies/${id}`} className="hover:underline">
                  {company.name}
                </Link>
              ) : null}
            </td>
            {/* Metric name */}
            <td
              className="sticky z-10 bg-card px-2 py-1.5 text-xs text-muted-foreground truncate"
              style={{ left: companyColWidth, width: metricColWidth, minWidth: metricColWidth }}
            >
              {metric ? metric.name : <span className="text-muted-foreground/50">—</span>}
            </td>
            {/* Quarter value cells */}
            {quarterColumns.map(q => (
              <td
                key={q}
                className="px-3 py-1.5 text-xs text-right tabular-nums whitespace-nowrap"
              >
                {metric ? (
                  <span className={metric.values[q] != null ? '' : 'text-muted-foreground/40'}>
                    {formatValue(metric.values[q] ?? null, metric, fundCurrency)}
                  </span>
                ) : (
                  <span className="text-muted-foreground/40">—</span>
                )}
              </td>
            ))}
          </tr>
        )
      })
    }
    return rows
  }

  const totalCols = 2 + quarterColumns.length

  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border">
            <th
              className="sticky left-0 z-20 bg-card px-3 py-2 text-left text-[11px] font-medium text-muted-foreground"
              style={{ width: companyColWidth, minWidth: companyColWidth }}
            >
              Company
            </th>
            <th
              className="sticky z-20 bg-card px-3 py-2 text-left text-[11px] font-medium text-muted-foreground"
              style={{ left: companyColWidth, width: metricColWidth, minWidth: metricColWidth }}
            >
              Metric
            </th>
            {quarterColumns.map(q => (
              <th
                key={q}
                className="px-3 py-2 text-right text-[11px] font-medium text-muted-foreground whitespace-nowrap"
              >
                {q}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grouped ? (
            grouped.map(([groupName, ids]) => {
              const filteredIds = ids.filter(id => companyMap.has(id))
              if (filteredIds.length === 0) return null
              return (
                <React.Fragment key={groupName}>
                  <tr>
                    <td
                      colSpan={totalCols}
                      className="px-3 py-2 text-sm font-medium text-muted-foreground bg-muted/30 border-t border-border"
                    >
                      {groupName}
                    </td>
                  </tr>
                  {renderCompanyRows(filteredIds)}
                </React.Fragment>
              )
            })
          ) : (
            renderCompanyRows(companyIds)
          )}
        </tbody>
      </table>
    </div>
  )
}
