import type { PageContext } from '@/lib/pages/context'
import { computeSummary, effectiveCompanyStatus } from '@/lib/investments'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { scopeTransactions } from '@/lib/access/scope'
import type { InvestmentTransaction, CompanyStatus } from '@/lib/types/database'

export type DashboardPageData = Awaited<ReturnType<typeof loadDashboardPage>>

/**
 * The portfolio: every company with its active metrics, latest cash and last reporting period,
 * first investment date, and (for exited or written-off companies) the investment summary.
 */
export async function loadDashboardPage({ supabase, admin, user, page }: PageContext) {
  const isAdmin = page.isAdmin

  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()

  // Only the companies linked to the viewer's entities, and only their entities' transactions. An
  // admin sees every entity (no filter); a member with none sees an empty portfolio.
  const scope = await entityScopeFor(admin, page.access)

  // Fetch companies with their first 2 metrics and review counts
  type CompanyRow = {
    id: string; name: string; stage: string | null; status: string; created_at: string | null
    tags: string[]; industry: string[] | null; portfolio_group: string[] | null
    metrics: { id: string; name: string; unit: string | null; unit_position: string; value_type: string; currency: string | null; display_order: number; is_active: boolean }[]
    parsing_reviews: { id: string; resolution: string | null }[]
  }

  let companiesQuery = supabase
    .from('companies')
    .select(`
      id, name, stage, status, created_at, tags, industry, portfolio_group,
      metrics(id, name, unit, unit_position, value_type, currency, display_order, is_active),
      parsing_reviews(id, resolution)
    `)
    .eq('holding_type', 'company')   // fund holdings have their own surfaces
  if (scope.companyIds !== null) companiesQuery = companiesQuery.in('id', scope.companyIds)
  const { data: companiesRaw } = await companiesQuery.order('name') as { data: CompanyRow[] | null }

  // Find cash metric IDs for each company
  const cashMetricMap = new Map<string, string>()
  for (const c of companiesRaw ?? []) {
    const cashMetric = (c.metrics ?? []).find(m =>
      m.is_active && (m.name.toLowerCase() === 'cash' || /\bcash\b/i.test(m.name))
    )
    if (cashMetric) cashMetricMap.set(c.id, cashMetric.id)
  }

  // Batch fetch latest cash values
  const cashMetricIds = Array.from(cashMetricMap.values())
  const cashValues = new Map<string, number>()
  if (cashMetricIds.length > 0) {
    const { data: cashRows } = await supabase
      .from('metric_values')
      .select('metric_id, value_number')
      .in('metric_id', cashMetricIds)
      .not('value_number', 'is', null)
      .order('period_year', { ascending: false })
      .order('created_at', { ascending: false }) as { data: { metric_id: string; value_number: number }[] | null }

    // Keep only the first (latest) value per metric
    for (const row of cashRows ?? []) {
      if (!cashValues.has(row.metric_id)) {
        cashValues.set(row.metric_id, row.value_number)
      }
    }
  }

  // Batch fetch latest metric period per company
  const { data: latestPeriodRows } = await supabase
    .from('metric_values')
    .select('company_id, period_year, period_quarter, period_month')
    .in('company_id', (companiesRaw ?? []).map(c => c.id))
    .order('period_year', { ascending: false })
    .order('period_quarter', { ascending: false, nullsFirst: false })
    .order('period_month', { ascending: false, nullsFirst: false }) as { data: { company_id: string; period_year: number; period_quarter: number | null; period_month: number | null }[] | null }

  const lastMetricPeriod = new Map<string, string>()
  for (const row of latestPeriodRows ?? []) {
    if (lastMetricPeriod.has(row.company_id)) continue
    if (row.period_month) {
      // Use last day of the month
      const lastDay = new Date(row.period_year, row.period_month, 0)
      lastMetricPeriod.set(row.company_id, lastDay.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }))
    } else if (row.period_quarter) {
      const qLabels = ['Q1', 'Q2', 'Q3', 'Q4']
      lastMetricPeriod.set(row.company_id, `${qLabels[row.period_quarter - 1]} ${row.period_year}`)
    } else {
      lastMetricPeriod.set(row.company_id, `${row.period_year}`)
    }
  }

  const companies = (companiesRaw ?? []).map((c) => {
    const lastReportAt = lastMetricPeriod.get(c.id) ?? null
    const activeMetrics = (c.metrics ?? [])
      .filter((m) => m.is_active)
      .sort((a, b) => a.display_order - b.display_order)
    const openReviews = (c.parsing_reviews ?? []).filter((r) => r.resolution === null).length

    const cashMetricId = cashMetricMap.get(c.id)
    const latestCash = cashMetricId ? cashValues.get(cashMetricId) ?? null : null

    return {
      id: c.id,
      name: c.name,
      stage: c.stage,
      status: c.status,
      createdAt: c.created_at,
      tags: c.tags ?? [],
      industry: c.industry,
      // Which entities hold it — only the viewer's; another fund's holding is not theirs to see.
      portfolioGroup: scope.vehicleNames === null ? c.portfolio_group : (c.portfolio_group ?? []).filter(g => scope.vehicleNames!.includes(g)),
      lastReportAt,
      openReviews,
      activeMetrics: activeMetrics.map(m => ({ id: m.id, name: m.name, unit: m.unit, unit_position: m.unit_position, value_type: m.value_type, currency: m.currency })),
      latestCash,
    }
  })

  // Fetch investment transactions for ALL companies (first investment date + summaries for exited)
  const allCompanyIds = companies.map(c => c.id)
  const { data: allTxns } = await admin
    .from('investment_transactions' as any)
    .select('*')
    .in('company_id', allCompanyIds)
    .order('transaction_date', { ascending: true }) as { data: InvestmentTransaction[] | null }

  // Group transactions by company — only the viewer's entities' rows (plus company-wide price
  // signals), so a shared company's figures are the viewer's position, not every fund's.
  const txnsByCompany = new Map<string, InvestmentTransaction[]>()
  for (const txn of scopeTransactions(allTxns ?? [], scope.vehicleNames)) {
    if (!txnsByCompany.has(txn.company_id)) txnsByCompany.set(txn.company_id, [])
    txnsByCompany.get(txn.company_id)!.push(txn)
  }

  // Compute first investment date per company
  const firstInvestmentDates = new Map<string, string>()
  for (const companyId of Array.from(txnsByCompany.keys())) {
    const txns = txnsByCompany.get(companyId)!
    const investmentTxns = txns.filter((t: InvestmentTransaction) => t.transaction_type === 'investment' && t.transaction_date)
    if (investmentTxns.length > 0) {
      firstInvestmentDates.set(companyId, investmentTxns[0].transaction_date!)
    }
  }

  // The status the transactions support. An 'active' column whose whole position the tracker shows
  // closed out is exited or written off here (display only; the column is not touched).
  const effectiveStatus = new Map<string, CompanyStatus>()
  for (const c of companies) {
    effectiveStatus.set(c.id, effectiveCompanyStatus(txnsByCompany.get(c.id) ?? [], c.status as CompanyStatus))
  }

  // Compute summaries for exited/written-off companies
  const exitedIds = companies
    .filter(c => effectiveStatus.get(c.id) === 'exited' || effectiveStatus.get(c.id) === 'written-off')
    .map(c => c.id)

  const investmentSummaries = new Map<string, { moic: number | null; grossIrr: number | null; totalInvested: number; totalRealized: number; unrealizedValue: number }>()

  for (const id of exitedIds) {
    const txns = txnsByCompany.get(id) ?? []
    const status = effectiveStatus.get(id)!
    if (txns.length > 0) {
      const summary = computeSummary(txns, status)
      investmentSummaries.set(id, { moic: summary.moic, grossIrr: summary.grossIrr, totalInvested: summary.totalInvested, totalRealized: summary.totalRealized, unrealizedValue: summary.unrealizedValue })
    } else {
      investmentSummaries.set(id, { moic: null, grossIrr: null, totalInvested: 0, totalRealized: 0, unrealizedValue: 0 })
    }
  }

  // Attach investment data to company objects
  const companiesWithInvestments = companies.map(c => ({
    ...c,
    status: effectiveStatus.get(c.id) ?? c.status,
    firstInvestmentDate: firstInvestmentDates.get(c.id) ?? null,
    moic: investmentSummaries.get(c.id)?.moic ?? null,
    grossIrr: investmentSummaries.get(c.id)?.grossIrr ?? null,
    totalInvested: investmentSummaries.get(c.id)?.totalInvested ?? null,
    totalRealized: investmentSummaries.get(c.id)?.totalRealized ?? null,
    unrealizedValue: investmentSummaries.get(c.id)?.unrealizedValue ?? null,
  }))

  // The vehicle filter lists only the viewer's entities, never one they cannot see.
  const allGroups = Array.from(new Set(companiesWithInvestments.flatMap(c => c.portfolioGroup ?? [])))
    .filter(g => scope.vehicleNames === null || scope.vehicleNames.includes(g))
    .sort()


  return {
    companies: companiesWithInvestments,
    allGroups,
    canAdd: page.role !== 'viewer',
    isAdmin,
    userId: user.id,
  }
}
