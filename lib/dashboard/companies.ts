import type { PageSupabase } from '@/lib/pages/context'

export interface DashboardCompanyRow {
  id: string
  name: string
  stage: string | null
  status: string
  created_at: string | null
  tags: string[]
  industry: string[] | null
  portfolio_group: string[] | null
  metrics: {
    id: string; name: string; unit: string | null; unit_position: string
    value_type: string; currency: string | null; display_order: number; is_active: boolean
    latest: { value_number: number | null }[]
    latest_numeric: { value_number: number }[]
  }[]
  parsing_reviews: { count: number }[]
  latest_period: { period_year: number; period_quarter: number | null; period_month: number | null }[]
}

/** One RLS-scoped request, with one value per metric and one reporting period per company.
 * Embedded limits apply per parent, so a long history cannot crowd out another company's data.
 * Keep the card endpoint's chronological ordering and the cash sort's existing semantics.
 */
export async function loadDashboardCompanyRows(client: PageSupabase, fundId: string, companyIds: string[] | null) {
  if (companyIds?.length === 0) return []
  let query = client.from('companies').select(`
    id, name, stage, status, created_at, tags, industry, portfolio_group,
    metrics(id, name, unit, unit_position, value_type, currency, display_order, is_active,
      latest:metric_values(value_number), latest_numeric:metric_values(value_number)),
    parsing_reviews(count), latest_period:metric_values(period_year, period_quarter, period_month)
  `).eq('fund_id', fundId).eq('holding_type', 'company')
    .eq('metrics.is_active', true)
    .is('parsing_reviews.resolution', null)
    .order('period_year', { referencedTable: 'metrics.latest', ascending: false })
    .order('period_quarter', { referencedTable: 'metrics.latest', ascending: false, nullsFirst: true })
    .order('period_month', { referencedTable: 'metrics.latest', ascending: false, nullsFirst: true })
    .order('created_at', { referencedTable: 'metrics.latest', ascending: false })
    .limit(1, { referencedTable: 'metrics.latest' })
    .not('metrics.latest_numeric.value_number', 'is', null)
    .order('period_year', { referencedTable: 'metrics.latest_numeric', ascending: false })
    .order('created_at', { referencedTable: 'metrics.latest_numeric', ascending: false })
    .limit(1, { referencedTable: 'metrics.latest_numeric' })
    .order('period_year', { referencedTable: 'latest_period', ascending: false })
    .order('period_quarter', { referencedTable: 'latest_period', ascending: false, nullsFirst: false })
    .order('period_month', { referencedTable: 'latest_period', ascending: false, nullsFirst: false })
    .limit(1, { referencedTable: 'latest_period' })
    .order('name').order('id')
  if (companyIds !== null) query = query.in('id', companyIds)
  const companies: DashboardCompanyRow[] = []
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await query.range(offset, offset + 499).returns<DashboardCompanyRow[]>()
    if (error) throw new Error('Could not load portfolio metrics')
    companies.push(...(data ?? []))
    if ((data?.length ?? 0) < 500) break
  }
  return companies
}
