import type { PageSupabase } from '@/lib/pages/context'
import type { EntityScope } from '@/lib/access/entity-scope'
import { scopeGroups } from '@/lib/access/scope'

interface TableMetricValue {
  period_year: number
  period_quarter: number | null
  period_month: number | null
  value_number: number | null
  value_text: string | null
}

interface TableCompany {
  id: string; name: string; stage: string | null; industry: string[] | null
  portfolio_group: string[] | null; tags: string[]
  metrics: {
    id: string; name: string; unit: string | null; unit_position: string
    value_type: string; currency: string | null; display_order: number; is_active: boolean
    values: TableMetricValue[]
    latest_numeric: { value_number: number }[]
  }[]
}

/** The table needs reporting history, but only active, authorised companies/metrics. Each
 * history is embedded under its metric so a global row cap cannot starve later companies.
 */
export async function loadDashboardTable(client: PageSupabase, scope: EntityScope) {
  if (scope.companyIds?.length === 0) return []
  let query = client.from('companies').select(`
    id, name, stage, industry, portfolio_group, tags,
    metrics(id, name, unit, unit_position, value_type, currency, display_order, is_active,
      values:metric_values(period_year, period_quarter, period_month, value_number, value_text),
      latest_numeric:metric_values(value_number))
  `).eq('fund_id', scope.access.fundId).eq('holding_type', 'company').eq('status', 'active')
    .eq('metrics.is_active', true)
    .gte('metrics.values.period_year', 2025)
    .order('period_year', { referencedTable: 'metrics.values' })
    .order('period_month', { referencedTable: 'metrics.values', nullsFirst: true })
    .order('created_at', { referencedTable: 'metrics.values', ascending: false })
    .not('metrics.latest_numeric.value_number', 'is', null)
    .order('period_year', { referencedTable: 'metrics.latest_numeric', ascending: false })
    .order('created_at', { referencedTable: 'metrics.latest_numeric', ascending: false })
    .limit(1, { referencedTable: 'metrics.latest_numeric' })
    .order('name').order('id')
  if (scope.companyIds !== null) query = query.in('id', scope.companyIds)
  const companies: TableCompany[] = []
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await query.range(offset, offset + 499).returns<TableCompany[]>()
    if (error) throw new Error('Could not load portfolio table')
    companies.push(...(data ?? []))
    if ((data?.length ?? 0) < 500) break
  }

  // Map monthly/quarterly/annual values to quarters
  function toQuarterKey(year: number, quarter: number): string {
    return `Q${quarter} ${year}`
  }

  function mapToQuarter(v: TableMetricValue): { key: string; month: number } | null {
    if (v.period_month != null) {
      const q = Math.ceil(v.period_month / 3)
      return { key: toQuarterKey(v.period_year, q), month: v.period_month }
    }
    if (v.period_quarter != null) {
      return { key: toQuarterKey(v.period_year, v.period_quarter), month: v.period_quarter * 3 }
    }
    // Annual → Q4
    return { key: toQuarterKey(v.period_year, 4), month: 12 }
  }

  const result = companies.map(c => {
    const activeMetrics = (c.metrics ?? [])
      .filter(m => m.is_active)
      .sort((a, b) => a.display_order - b.display_order)

    const cashMetric = activeMetrics.find(m => /\bcash\b/i.test(m.name))
    const latestCash = cashMetric?.latest_numeric[0]?.value_number ?? null

    return {
      id: c.id,
      name: c.name,
      stage: c.stage,
      industry: c.industry,
      portfolioGroup: scopeGroups(c.portfolio_group, scope.vehicleNames),
      tags: c.tags ?? [],
      latestCash,
      metrics: activeMetrics.map(m => {
        const metricValues = m.values ?? []
        const quarterMap = new Map<string, { value: number | string | null; month: number }>()

        for (const v of metricValues) {
          const mapped = mapToQuarter(v)
          if (!mapped) continue

          const val = m.value_type === 'text' ? v.value_text : v.value_number
          const existing = quarterMap.get(mapped.key)

          // Keep the latest month's value within a quarter
          if (!existing || mapped.month > existing.month) {
            quarterMap.set(mapped.key, { value: val, month: mapped.month })
          }
        }

        const values: Record<string, number | string | null> = {}
        quarterMap.forEach((entry, key) => {
          values[key] = entry.value
        })

        return {
          id: m.id,
          name: m.name,
          unit: m.unit,
          unitPosition: m.unit_position,
          valueType: m.value_type,
          currency: m.currency,
          values,
        }
      }),
    }
  })

  return result
}
