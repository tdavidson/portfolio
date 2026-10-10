import { createAdminClient } from '@/lib/supabase/admin'
import { xirr, type CashFlow } from '@/lib/xirr'

type Admin = ReturnType<typeof createAdminClient>

export interface CompanyInvestmentSummary {
  companyId: string
  companyName: string
  status: string
  stage: string | null
  industry: string[] | null
  overview: string | null
  whyInvested: string | null
  currentUpdate: string | null
  totalInvested: number
  totalRealized: number
  unrealizedValue: number
  fmv: number
  moic: number | null
}

export interface CompanyMetricData {
  metricName: string
  unit: string | null
  unitPosition: string
  valueType: string
  currency: string | null
  // Values for the requested quarter
  currentValue: number | string | null
  currentLabel: string
  // Previous quarter for comparison
  previousValue: number | string | null
  previousLabel: string | null
  // Year-end: full year values (if is_year_end)
  yearValues?: { label: string; value: number | string | null }[]
}

export interface CompanyLetterData {
  investment: CompanyInvestmentSummary
  metrics: CompanyMetricData[]
  recentNotes: string[]
  latestSummary: string | null
  latestUpdate: string | null
}

export interface FundMetrics {
  committedCapital: number
  paidInCapital: number
  distributions: number
  fmv: number
  dpi: number | null
  rvpi: number | null
  tvpi: number | null
  irr: number | null
}

export interface PortfolioPreview {
  fundName: string
  fundCurrency: string
  periodLabel: string
  portfolioGroup: string
  companies: CompanyLetterData[]
  fundMetrics: FundMetrics | null
  totals: {
    totalInvested: number
    totalFmv: number
    totalRealized: number
    portfolioMoic: number | null
    activeCount: number
    exitedCount: number
    writtenOffCount: number
  }
}

/**
 * Aggregates all portfolio data for a given quarter + portfolio group.
 * Used both for the preview step and for feeding into AI generation.
 */
export async function aggregatePortfolioData(
  admin: Admin,
  fundId: string,
  year: number,
  quarter: number,
  portfolioGroup: string,
  isYearEnd: boolean
): Promise<PortfolioPreview> {
  // The letter's entity: its notes are the only ones that belong in it (a note on a shared company
  // written for another entity is that entity's).
  const { data: letterVehicles } = await (admin as any)
    .from('fund_vehicles').select('id, name, aliases').eq('fund_id', fundId)
  const letterVehicleId: string | null = (((letterVehicles as any[]) ?? [])
    .find(v => v.name === portfolioGroup || ((v.aliases as string[] | null) ?? []).includes(portfolioGroup))?.id) ?? null

  // Fund info
  const { data: fund } = await admin
    .from('funds')
    .select('name')
    .eq('id', fundId)
    .single()

  const { data: fundSettings } = await admin
    .from('fund_settings')
    .select('currency')
    .eq('fund_id', fundId)
    .maybeSingle()

  const fundCurrency = fundSettings?.currency ?? 'USD'
  const fundName = fund?.name ?? 'Fund'

  // Get companies in this portfolio group
  const { data: allCompanies } = await admin
    .from('companies')
    .select('id, name, status, stage, industry, overview, why_invested, current_update')
    .eq('fund_id', fundId)
    .eq('holding_type', 'company')   // fund holdings have their own surfaces
    .eq('status', 'active')
    .order('name') as { data: {
      id: string; name: string; status: string; stage: string | null
      industry: string[] | null; overview: string | null
      why_invested: string | null; current_update: string | null
    }[] | null }

  // Filter by portfolio group using investment transactions
  const { data: allTransactions } = await admin
    .from('investment_transactions')
    .select('company_id, transaction_type, transaction_date, round_name, investment_cost, share_price, proceeds_received, proceeds_escrow, cost_basis_exited, current_share_price, shares_acquired, unrealized_value_change, portfolio_group, converts_from_txn_id')
    .eq('fund_id', fundId)
    .order('transaction_date', { ascending: true }) as { data: {
      company_id: string; transaction_type: string; transaction_date: string | null
      round_name: string | null; investment_cost: number | null; share_price: number | null
      proceeds_received: number | null; proceeds_escrow: number | null
      cost_basis_exited: number | null; current_share_price: number | null
      shares_acquired: number | null; unrealized_value_change: number | null
      // NOTE: scalar text on investment_transactions (only companies.portfolio_group
      // is text[]). Must be compared with ===, never .includes() — on a string that
      // is a substring test, and "<X> SPV II" contains "<X> SPV".
      portfolio_group: string | null
      converts_from_txn_id: string | null
    }[] | null }

  // Determine which companies belong to this portfolio group
  const companyIdsInGroup = new Set<string>()
  for (const t of allTransactions ?? []) {
    if (t.portfolio_group === portfolioGroup) {
      companyIdsInGroup.add(t.company_id)
    }
  }

  // Also include companies that have no transactions but are assigned to this group
  // (via company-level portfolio_group field)
  const { data: companyGroupAssignments } = await admin
    .from('companies')
    .select('id, portfolio_group')
    .eq('fund_id', fundId)
    // fund holdings have their own surfaces
    .eq('holding_type', 'company') as { data: { id: string; portfolio_group: string[] | null }[] | null }

  for (const c of companyGroupAssignments ?? []) {
    if (c.portfolio_group?.includes(portfolioGroup)) {
      companyIdsInGroup.add(c.id)
    }
  }

  const companies = (allCompanies ?? []).filter(c => companyIdsInGroup.has(c.id))

  // Also get exited/written-off companies in this group
  const { data: inactiveCompanies } = await admin
    .from('companies')
    .select('id, name, status, stage, industry, overview, why_invested, current_update')
    .eq('fund_id', fundId)
    .eq('holding_type', 'company')   // fund holdings have their own surfaces
    .in('status', ['exited', 'written-off']) as { data: typeof allCompanies }

  const allGroupCompanies = [
    ...companies,
    ...(inactiveCompanies ?? []).filter(c => companyIdsInGroup.has(c.id)),
  ]

  // Compute investment summaries using canonical per-round cost basis logic
  // (matches the portfolio investments API computation)
  const investmentSummaries: CompanyInvestmentSummary[] = []
  for (const c of allGroupCompanies) {
    const txns = (allTransactions ?? []).filter(t => t.company_id === c.id)

    // Determine company-wide latest share price from all transaction types
    let latestSharePrice: number | null = null
    let latestSharePriceDate: string | null = null
    let latestFromConversion = false

    for (const t of txns) {
      if (t.transaction_type === 'investment') {
        if (t.share_price != null && t.share_price > 0 && t.transaction_date) {
          // Same day as a conversion: the priced round's price wins (computeSummary, the same rule).
          const sameDayRound = t.transaction_date === latestSharePriceDate && latestFromConversion && !t.converts_from_txn_id
          if (!latestSharePriceDate || t.transaction_date > latestSharePriceDate || sameDayRound) {
            latestSharePrice = Number(t.share_price)
            latestSharePriceDate = t.transaction_date
            latestFromConversion = !!t.converts_from_txn_id
          }
        }
      }
      if (t.transaction_type === 'unrealized_gain_change' && t.current_share_price != null) {
        if (!latestSharePriceDate || (t.transaction_date ?? '') >= (latestSharePriceDate ?? '')) {
          latestSharePrice = Number(t.current_share_price)
          latestSharePriceDate = t.transaction_date
        }
      }
      if (t.transaction_type === 'round_info') {
        if (t.share_price != null && t.transaction_date) {
          if (!latestSharePriceDate || t.transaction_date >= latestSharePriceDate) {
            latestSharePrice = Number(t.share_price)
            latestSharePriceDate = t.transaction_date
          }
        }
      }
    }

    // Filter to transactions in this portfolio group (exact match — see the note above)
    const groupTxns = txns.filter(t => t.portfolio_group === portfolioGroup)
    // Also include company-wide unrealized_gain_change/round_info (no portfolio_group) for share price
    const companyWideTxns = txns.filter(t =>
      (t.transaction_type === 'unrealized_gain_change' || t.transaction_type === 'round_info') &&
      !t.portfolio_group
    )
    const relevantTxns = [...groupTxns, ...companyWideTxns.filter(t => !groupTxns.includes(t))]

    // Build round map with cost basis tracking
    const valueMarks: { date: string; amount: number; round: string | null }[] = []
    let totalInvested = 0
    let totalRealized = 0
    const roundMap = new Map<string, {
      investmentCost: number
      sharesAcquired: number
      unrealizedValueChange: number
      costBasisExited: number
    }>()

    for (const t of relevantTxns) {
      if (t.transaction_type === 'investment') {
        totalInvested += Number(t.investment_cost ?? 0)
        const roundName = t.round_name ?? 'Unknown'
        const existing = roundMap.get(roundName)
        if (existing) {
          existing.investmentCost += Number(t.investment_cost ?? 0)
          existing.sharesAcquired += Number(t.shares_acquired ?? 0)
        } else {
          roundMap.set(roundName, {
            investmentCost: Number(t.investment_cost ?? 0),
            sharesAcquired: Number(t.shares_acquired ?? 0),
            unrealizedValueChange: 0,
            costBasisExited: 0,
          })
        }
      }
      if (t.transaction_type === 'proceeds') {
        const pr = Number(t.proceeds_received ?? 0)
        const pe = Number(t.proceeds_escrow ?? 0)
        totalRealized += pr + pe
        if (t.round_name && t.cost_basis_exited != null) {
          const round = roundMap.get(t.round_name)
          if (round) round.costBasisExited += Math.abs(Number(t.cost_basis_exited))
        }
      }
      if (t.transaction_type === 'unrealized_gain_change') {
        if (t.round_name && t.unrealized_value_change != null) {
          const round = roundMap.get(t.round_name)
          if (round) round.unrealizedValueChange += Number(t.unrealized_value_change)
        }
        if (t.unrealized_value_change != null && t.current_share_price == null) {
          valueMarks.push({ date: t.transaction_date ?? '', amount: Number(t.unrealized_value_change), round: t.round_name ?? null })
        }
      }
    }

    // Compute per-round unrealized value using remaining basis fraction
    let unrealizedValue = 0
    const pricedRounds = new Set<string>()
    for (const [roundName, round] of Array.from(roundMap.entries())) {
      const isPricedEquity = round.sharesAcquired > 0 && round.investmentCost > 0
      const remainingBasis = round.investmentCost - round.costBasisExited
      // Same rules as computeSummary (lib/investments.ts): no price known means the marks are the
      // valuation, and a zero-cost round (warrants) is only gone once basis has been exited.
      if (remainingBasis <= 0 && (round.costBasisExited > 0 || round.investmentCost > 0)) {
        // All cost basis exited — no unrealized value
      } else if (isPricedEquity && latestSharePrice != null) {
        const fraction = remainingBasis / round.investmentCost
        unrealizedValue += round.sharesAcquired * fraction * latestSharePrice
        pricedRounds.add(roundName)
      } else {
        // Convertible / warrant: remaining basis + unrealized changes
        unrealizedValue += Math.max(0, remainingBasis + round.unrealizedValueChange)
      }
    }
    // Value-change marks after the latest price move a priced position on from it; marks on or
    // before it are already in the price (computeSummary, lib/investments.ts, the same rule).
    unrealizedValue = Math.max(0, unrealizedValue + valueMarks
      .filter(m => m.round == null || pricedRounds.has(m.round))
      .filter(m => latestSharePriceDate == null || m.date > latestSharePriceDate)
      .reduce((sum, m) => sum + m.amount, 0))

    let fmv: number
    if (c.status === 'exited') {
      fmv = totalRealized
    } else if (c.status === 'written-off') {
      fmv = 0
    } else {
      fmv = unrealizedValue
    }
    const moic = totalInvested > 0 ? (totalRealized + unrealizedValue) / totalInvested : null

    investmentSummaries.push({
      companyId: c.id,
      companyName: c.name,
      status: c.status,
      stage: c.stage,
      industry: c.industry,
      overview: c.overview,
      whyInvested: c.why_invested,
      currentUpdate: c.current_update,
      totalInvested,
      totalRealized,
      unrealizedValue,
      fmv,
      moic,
    })
  }

  // Fetch metrics for all companies in the group
  const companyIds = allGroupCompanies.map(c => c.id)
  const { data: allMetrics } = await admin
    .from('metrics')
    .select('id, company_id, name, unit, unit_position, value_type, currency')
    .in('company_id', companyIds.length > 0 ? companyIds : ['__none__'])
    .eq('is_active', true) as { data: {
      id: string; company_id: string; name: string; unit: string | null
      unit_position: string; value_type: string; currency: string | null
    }[] | null }

  const metricIds = (allMetrics ?? []).map(m => m.id)
  const { data: allValues } = await admin
    .from('metric_values')
    .select('metric_id, period_label, period_year, period_quarter, period_month, value_number, value_text')
    .in('metric_id', metricIds.length > 0 ? metricIds : ['__none__'])
    .order('period_year')
    .order('period_quarter', { nullsFirst: true })
    .order('period_month', { nullsFirst: true }) as { data: {
      metric_id: string; period_label: string; period_year: number
      period_quarter: number | null; period_month: number | null
      value_number: number | null; value_text: string | null
    }[] | null }

  // Determine the previous quarter
  const prevQ = quarter === 1 ? 4 : quarter - 1
  const prevY = quarter === 1 ? year - 1 : year

  // Fetch recent notes and summaries per company
  const companyDataMap = new Map<string, CompanyLetterData>()
  for (const c of allGroupCompanies) {
    const inv = investmentSummaries.find(s => s.companyId === c.id)!
    const metrics = (allMetrics ?? []).filter(m => m.company_id === c.id)

    const metricData: CompanyMetricData[] = metrics.map(m => {
      const vals = (allValues ?? []).filter(v => v.metric_id === m.id)
      const currentVals = vals.filter(v => v.period_year === year && v.period_quarter === quarter)
      const prevVals = vals.filter(v => v.period_year === prevY && v.period_quarter === prevQ)
      const current = currentVals[currentVals.length - 1]
      const prev = prevVals[prevVals.length - 1]

      const yearValues = isYearEnd
        ? vals.filter(v => v.period_year === year).map(v => ({
            label: v.period_label,
            value: v.value_number !== null ? v.value_number : v.value_text,
          }))
        : undefined

      return {
        metricName: m.name,
        unit: m.unit,
        unitPosition: m.unit_position,
        valueType: m.value_type,
        currency: m.currency,
        currentValue: current ? (current.value_number !== null ? current.value_number : current.value_text) : null,
        currentLabel: current?.period_label ?? `Q${quarter} ${year}`,
        previousValue: prev ? (prev.value_number !== null ? prev.value_number : prev.value_text) : null,
        previousLabel: prev?.period_label ?? null,
        yearValues,
      }
    })

    // Recent notes
    // '*' and filtered here: vehicle_id exists once the notes migration has run (before it, no row
    // carries the key and every note is kept, as before).
    const { data: companyNotes } = await admin
      .from('company_notes')
      .select('*')
      .eq('company_id', c.id)
      .order('created_at', { ascending: false })
      .limit(50) as { data: { content: string; vehicle_id?: string | null }[] | null }
    const notes = (companyNotes ?? [])
      .filter(n => !('vehicle_id' in n) || (!!letterVehicleId && n.vehicle_id === letterVehicleId))
      .slice(0, 5)

    // Latest summary
    const { data: summary } = await admin
      .from('company_summaries')
      .select('summary_text')
      .eq('company_id', c.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle() as { data: { summary_text: string } | null }

    companyDataMap.set(c.id, {
      investment: inv,
      metrics: metricData,
      recentNotes: (notes ?? []).map(n => n.content),
      latestSummary: summary?.summary_text ?? null,
      latestUpdate: c.current_update,
    })
  }

  // Compute totals
  const activeCompanies = investmentSummaries.filter(s => s.status === 'active')
  const totalInvested = investmentSummaries.reduce((s, c) => s + c.totalInvested, 0)
  const totalFmv = investmentSummaries.reduce((s, c) => s + c.fmv, 0)
  const totalRealized = investmentSummaries.reduce((s, c) => s + c.totalRealized, 0)
  const portfolioMoic = totalInvested > 0 ? totalFmv / totalInvested : null

  // Fund-level cash flow metrics (net, matching funds page computation)
  const { data: cashFlows } = await admin
    .from('fund_cash_flows')
    .select('flow_type, flow_date, amount')
    .eq('fund_id', fundId)
    .eq('portfolio_group', portfolioGroup) as { data: { flow_type: string; flow_date: string; amount: number }[] | null }

  const { data: groupConfig } = await admin
    .from('fund_group_config')
    .select('cash_on_hand, carry_rate, gp_commit_pct')
    .eq('fund_id', fundId)
    .eq('portfolio_group', portfolioGroup)
    .maybeSingle() as { data: { cash_on_hand: number; carry_rate: number; gp_commit_pct: number } | null }

  let fundMetrics: FundMetrics | null = null
  if (cashFlows && cashFlows.length > 0) {
    const cashOnHand = Number(groupConfig?.cash_on_hand ?? 0)
    const carryRate = Number(groupConfig?.carry_rate ?? 0.20)
    const gpCommitPct = Number(groupConfig?.gp_commit_pct ?? 0)

    const committedCapital = cashFlows.filter(f => f.flow_type === 'commitment').reduce((s, f) => s + Number(f.amount), 0)
    const called = cashFlows.filter(f => f.flow_type === 'called_capital').reduce((s, f) => s + Number(f.amount), 0)
    const distributions = cashFlows.filter(f => f.flow_type === 'distribution').reduce((s, f) => s + Number(f.amount), 0)
    const grossResidual = totalFmv
    const grossAssets = grossResidual + cashOnHand

    // Net metrics: carry and GP commit adjustments
    const gpCapital = called * gpCommitPct
    const lpCapital = called - gpCapital
    const lpDistributions = distributions * (1 - gpCommitPct)
    const lpRemainingCapital = lpCapital - lpDistributions
    const estimatedCarry = Math.max(0, carryRate * (grossAssets * (1 - gpCommitPct) - lpRemainingCapital))
    const netResidual = grossAssets - estimatedCarry
    const totalValue = distributions + netResidual

    const dpi = called > 0 ? distributions / called : null
    const rvpi = called > 0 ? netResidual / called : null
    const tvpi = called > 0 ? totalValue / called : null

    // Net IRR via XIRR
    const xirrFlows: CashFlow[] = []
    for (const cf of cashFlows) {
      if (cf.flow_type === 'called_capital') {
        xirrFlows.push({ date: new Date(cf.flow_date), amount: -Number(cf.amount) })
      }
      if (cf.flow_type === 'distribution') {
        xirrFlows.push({ date: new Date(cf.flow_date), amount: Number(cf.amount) })
      }
    }
    if (netResidual > 0) {
      xirrFlows.push({ date: new Date(), amount: netResidual })
    }
    const irr = xirrFlows.length >= 2 ? xirr(xirrFlows) : null

    fundMetrics = { committedCapital, paidInCapital: called, distributions, fmv: netResidual, dpi, rvpi, tvpi, irr }
  }

  const periodLabel = isYearEnd
    ? `Q${quarter} ${year} / Year End ${year}`
    : `Q${quarter} ${year}`

  return {
    fundName,
    fundCurrency,
    periodLabel,
    portfolioGroup,
    companies: allGroupCompanies.map(c => companyDataMap.get(c.id)!),
    fundMetrics,
    totals: {
      totalInvested,
      totalFmv,
      totalRealized,
      portfolioMoic,
      activeCount: activeCompanies.length,
      exitedCount: investmentSummaries.filter(s => s.status === 'exited').length,
      writtenOffCount: investmentSummaries.filter(s => s.status === 'written-off').length,
    },
  }
}
