import { createTransactionLoader } from '@/lib/dashboard/transactions'
import { loadDashboardCompanyRows } from '@/lib/dashboard/companies'
import type { PageContext } from '@/lib/pages/context'
import { computeSummary, effectiveCompanyStatus } from '@/lib/investments'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { scopeTransactions } from '@/lib/access/scope'
import type { InvestmentTransaction, CompanyStatus } from '@/lib/types/database'
import { resolveExcluded } from '@/lib/dashboard/entity-selection'
import { loadActiveEntityOptions, loadFundDefaultExcluded, loadSavedExcluded } from '@/lib/dashboard/entity-selection-load'

export type DashboardPageData = Awaited<ReturnType<typeof loadDashboardPage>>

/**
 * The portfolio: every company with its active metrics, latest cash and last reporting period,
 * first investment date, and (for exited or written-off companies) the investment summary.
 */
export async function loadDashboardPage({ supabase, admin, user, page }: PageContext) {
  const isAdmin = page.isAdmin

  // Only the companies linked to the viewer's entities, and only their entities' transactions. An
  // admin sees every entity (no filter); a member with none sees an empty portfolio.
  const scope = await entityScopeFor(admin, page.access)

  // Start the independent picker reads while the portfolio data loads. Await the whole batch so
  // an error in either path is observed rather than leaving a rejected promise behind.
  const loadTransactions = createTransactionLoader(admin, page.fundId)
  const [{ companiesRaw, allTxns }, entityOptions, savedExcluded, fundDefaultExcluded] = await Promise.all([
    (async () => {
      const companiesRaw = await loadDashboardCompanyRows(supabase, page.fundId, scope.companyIds)
      const allTxns = await loadTransactions(companiesRaw.map(c => c.id))
      return { companiesRaw, allTxns }
    })(),
    loadActiveEntityOptions(admin, page.access, loadTransactions),
    page.role === 'viewer' ? Promise.resolve(null) : loadSavedExcluded(admin, page.fundId, user.id),
    loadFundDefaultExcluded(admin, page.fundId),
  ])
  const latestPeriodRows = companiesRaw.flatMap(c => c.latest_period.map(p => ({ ...p, company_id: c.id })))

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
    const openReviews = c.parsing_reviews?.[0]?.count ?? 0

    const cashMetric = activeMetrics.find(m => /\bcash\b/i.test(m.name))
    const latestCash = cashMetric?.latest_numeric[0]?.value_number ?? null

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
      activeMetrics: activeMetrics.map(m => ({ id: m.id, name: m.name, unit: m.unit, unit_position: m.unit_position, value_type: m.value_type, currency: m.currency, latestValue: m.latest[0]?.value_number ?? null })),
      latestCash,
    }
  })

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

  // The entity picker: the viewer's entities holding an active position (companies, fund holdings,
  // digital assets), and the selection in force — their saved one, else the fund default, else all.
  const selection = resolveExcluded({ options: entityOptions, saved: savedExcluded, fundDefault: fundDefaultExcluded })

  return {
    companies: companiesWithInvestments,
    entityOptions,
    initialExcluded: selection.excluded,
    hasSavedSelection: selection.source === 'saved',
    canAdd: page.role !== 'viewer',
    isAdmin,
    userId: user.id,
  }
}
