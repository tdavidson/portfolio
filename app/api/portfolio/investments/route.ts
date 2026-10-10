import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { dbError } from '@/lib/api-error'
import type { InvestmentTransaction, CompanyStatus } from '@/lib/types/database'
import { xirr, type CashFlow } from '@/lib/xirr'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { scopeCompanyRows, scopeGroups, scopeTransactions } from '@/lib/access/scope'
import { generateLiveReport } from '@/lib/accounting/live-report'
import { DEAL_VEHICLE_PREFIX } from '@/lib/portfolio/holding-href'
import { vehiclesCarriedAtLpPositions } from '@/lib/portfolio/deal-vehicles'

// ---------------------------------------------------------------------------
// GET — portfolio-wide investment summary
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const fundId = membership.fund_id

  // Fetch transactions for this fund, optionally filtered by as-of date
  const asOf = req.nextUrl.searchParams.get('asOf')

  let txnQuery = admin
    .from('investment_transactions' as any)
    .select('*')
    .eq('fund_id', fundId)

  if (asOf) {
    txnQuery = txnQuery.lte('transaction_date', asOf)
  }

  const { data: transactions, error: txnError } = await txnQuery
    .order('transaction_date', { ascending: true }) as { data: InvestmentTransaction[] | null; error: { message: string } | null }

  if (txnError) return dbError(txnError, 'portfolio-investments')

  // Fetch companies for names, statuses, and portfolio groups
  // Every holding — companies, fund holdings and digital assets — with its kind. All three are
  // investments on the schedule (plans/spec-ledger-one-writer.md §6), and each opens on its own
  // /companies/[id] page.
  const { data: companies, error: compError } = await admin
    .from('companies')
    .select('id, name, status, portfolio_group, holding_type')
    .eq('fund_id', fundId) as { data: { id: string; name: string; status: CompanyStatus; portfolio_group: string[] | null; holding_type: 'company' | 'fund' | 'crypto' | null }[] | null; error: { message: string } | null }

  if (compError) return dbError(compError, 'portfolio-investments-companies')

  // Only the caller's entities: their companies, their entities' transactions (plus company-wide
  // price signals), and only their entities named on each company.
  const scope = await loadEntityScopeForUser(admin, user.id)
  const names = (scope ? scope.vehicleNames : [])
  const companyMap = new Map(scopeCompanyRows(companies ?? [], (scope ? scope.companyIds : []))
    .map(c => [c.id, { ...c, portfolio_group: scopeGroups(c.portfolio_group, names) }]))

  // Group transactions by company
  const byCompany = new Map<string, InvestmentTransaction[]>()
  for (const txn of scopeTransactions(transactions ?? [], scope ? scope.vehicleNames : [])) {
    const list = byCompany.get(txn.company_id) ?? []
    list.push(txn)
    byCompany.set(txn.company_id, list)
  }

  // A fund holding or digital asset with no transactions yet (just created, nothing bought) still
  // belongs on the list, with zero figures — otherwise it appears on no list at all.
  for (const c of Array.from(companyMap.values())) {
    if ((c.holding_type === 'fund' || c.holding_type === 'crypto') && !byCompany.has(c.id)) byCompany.set(c.id, [])
  }

  let portfolioInvested = 0
  let portfolioRealized = 0
  let portfolioUnrealized = 0
  let portfolioFMV = 0

  // Collect all cash flows for portfolio-level IRR + per-group IRR
  const allCashFlows: CashFlow[] = []
  const portfolioGroupCashFlows = new Map<string, CashFlow[]>()
  const asOfDate = asOf ? new Date(asOf) : new Date()

  const companySummaries: {
    companyId: string
    companyName: string
    status: CompanyStatus
    holdingType: 'company' | 'fund' | 'crypto' | 'vehicle'
    portfolioGroup: string[]
    totalInvested: number
    totalRealized: number
    unrealizedValue: number
    fmv: number
    moic: number | null
    irr: number | null
    proceedsReceived: number
    proceedsEscrow: number
    totalCostBasisExited: number
  }[] = []

  for (const [companyId, txns] of Array.from(byCompany.entries())) {
    const company = companyMap.get(companyId)
    if (!company) continue

    const companyDefaultGroup = company.portfolio_group?.[0] ?? ''
    // A fund holding's NAV marks carry no round: each moves the whole position (its 1200-<id>).
    const isFund = company.holding_type === 'fund'

    // First pass: determine company-wide latestSharePrice from unrealized_gain_change and round_info
    let latestSharePrice: number | null = null
    let latestSharePriceDate: string | null = null
    let latestFromConversion = false

    for (const txn of txns) {
      if (txn.transaction_type === 'investment') {
        // Only use positive share prices (skip $0 from SAFEs, warrants, etc.)
        if (txn.share_price != null && txn.share_price > 0 && txn.transaction_date) {
          // Same day as a conversion: the priced round's price wins (computeSummary, the same rule).
          const sameDayRound = txn.transaction_date === latestSharePriceDate && latestFromConversion && !txn.converts_from_txn_id
          if (!latestSharePriceDate || txn.transaction_date > latestSharePriceDate || sameDayRound) {
            latestSharePrice = txn.share_price
            latestSharePriceDate = txn.transaction_date
            latestFromConversion = !!txn.converts_from_txn_id
          }
        }
      }
      if (txn.transaction_type === 'unrealized_gain_change') {
        if (txn.current_share_price != null && txn.transaction_date) {
          if (!latestSharePriceDate || txn.transaction_date >= latestSharePriceDate) {
            latestSharePrice = txn.current_share_price
            latestSharePriceDate = txn.transaction_date
          }
        }
      }
      if (txn.transaction_type === 'round_info') {
        if (txn.share_price != null && txn.transaction_date) {
          if (!latestSharePriceDate || txn.transaction_date >= latestSharePriceDate) {
            latestSharePrice = txn.share_price
            latestSharePriceDate = txn.transaction_date
          }
        }
      }
    }

    // Second pass: group investment and proceeds transactions by portfolio_group
    const groupTxns = new Map<string, InvestmentTransaction[]>()
    for (const txn of txns) {
      if (txn.transaction_type === 'investment' || txn.transaction_type === 'proceeds') {
        const group = txn.portfolio_group ?? companyDefaultGroup
        const list = groupTxns.get(group) ?? []
        list.push(txn)
        groupTxns.set(group, list)
      }
      // Also bucket unrealized_gain_change with round attribution to the correct group
      if (txn.transaction_type === 'unrealized_gain_change' && txn.round_name) {
        // These get processed per-group below via roundMap
        const group = txn.portfolio_group ?? companyDefaultGroup
        const list = groupTxns.get(group) ?? []
        list.push(txn)
        groupTxns.set(group, list)
      }
      // …so a fund's marks are bucketed by entity alongside its calls and distributions — and a
      // company's value-change marks with no round, which move a priced position after its price.
      else if (txn.transaction_type === 'unrealized_gain_change') {
        const group = txn.portfolio_group ?? companyDefaultGroup
        const list = groupTxns.get(group) ?? []
        list.push(txn)
        groupTxns.set(group, list)
      }
    }

    // If no investment/proceeds transactions at all, create a single empty-group entry
    if (groupTxns.size === 0) {
      groupTxns.set(companyDefaultGroup, [])
    }

    // Third pass: compute summary per (company, group) pair
    for (const [group, gTxns] of Array.from(groupTxns.entries())) {
      let totalInvested = 0
      let totalShares = 0
      let totalRealized = 0
      let proceedsReceived = 0
      let proceedsEscrow = 0
      let totalCostBasisExited = 0
      let navMarks = 0

      const groupCashFlows: CashFlow[] = []
      const valueMarks: { date: string; amount: number; round: string | null }[] = []
      const roundMap = new Map<string, { investmentCost: number; sharesAcquired: number; unrealizedValueChange: number; costBasisExited: number }>()

      for (const txn of gTxns) {
        if (txn.transaction_type === 'investment') {
          totalInvested += txn.investment_cost ?? 0
          totalShares += txn.shares_acquired ?? 0

          if (txn.transaction_date && txn.investment_cost) {
            const cf: CashFlow = { date: new Date(txn.transaction_date), amount: -(txn.investment_cost) }
            groupCashFlows.push(cf)
            allCashFlows.push(cf)
          }

          const roundName = txn.round_name ?? 'Unknown'
          const existing = roundMap.get(roundName)
          if (existing) {
            existing.investmentCost += txn.investment_cost ?? 0
            existing.sharesAcquired += txn.shares_acquired ?? 0
          } else {
            roundMap.set(roundName, {
              investmentCost: txn.investment_cost ?? 0,
              sharesAcquired: txn.shares_acquired ?? 0,
              unrealizedValueChange: 0,
              costBasisExited: 0,
            })
          }
        }
        if (txn.transaction_type === 'proceeds') {
          const pr = txn.proceeds_received ?? 0
          const pe = txn.proceeds_escrow ?? 0
          proceedsReceived += pr
          proceedsEscrow += pe
          const proceedsAmount = pr + pe
          totalRealized += proceedsAmount
          if (txn.cost_basis_exited != null) {
            totalCostBasisExited += Math.abs(txn.cost_basis_exited)
          }
          if (txn.round_name && txn.cost_basis_exited != null) {
            const round = roundMap.get(txn.round_name)
            if (round) round.costBasisExited += Math.abs(txn.cost_basis_exited)
          }

          if (txn.transaction_date && proceedsAmount > 0) {
            const cf: CashFlow = { date: new Date(txn.transaction_date), amount: proceedsAmount }
            groupCashFlows.push(cf)
            allCashFlows.push(cf)
          }
        }
        if (txn.transaction_type === 'unrealized_gain_change') {
          if (txn.round_name && txn.unrealized_value_change != null) {
            const round = roundMap.get(txn.round_name)
            if (round) round.unrealizedValueChange += txn.unrealized_value_change
          } else if (isFund) {
            navMarks += txn.unrealized_value_change ?? 0
          }
          if (!isFund && txn.unrealized_value_change != null && txn.current_share_price == null) {
            valueMarks.push({ date: txn.transaction_date ?? '', amount: Number(txn.unrealized_value_change), round: txn.round_name ?? null })
          }
        }
      }

      // Sum per-round FMV using the company-wide share price. Same rules as computeSummary
      // (lib/investments.ts): with no price known, the marks are the valuation — shares x a missing
      // price is not zero, it is unknown — and a round that cost nothing (warrants) is only gone
      // once basis has actually been exited.
      let unrealizedValue = 0
      const pricedRounds = new Set<string>()
      for (const [roundName, round] of Array.from(roundMap.entries())) {
        const isPricedEquity = round.sharesAcquired > 0 && (round.investmentCost > 0)
        const remainingBasis = round.investmentCost - round.costBasisExited
        if (remainingBasis <= 0 && (round.costBasisExited > 0 || round.investmentCost > 0)) {
          // All cost basis exited — no unrealized value
        } else if (isPricedEquity && latestSharePrice != null) {
          const fraction = remainingBasis / round.investmentCost
          unrealizedValue += round.sharesAcquired * fraction * latestSharePrice
          pricedRounds.add(roundName)
        } else {
          unrealizedValue += Math.max(0, remainingBasis + round.unrealizedValueChange)
        }
      }
      // Value-change marks after the latest price move a priced position on from it; marks on or
      // before it are already in the price (computeSummary, lib/investments.ts, the same rule).
      unrealizedValue = Math.max(0, unrealizedValue + valueMarks
        .filter(m => m.round == null || pricedRounds.has(m.round))
        .filter(m => latestSharePriceDate == null || m.date > latestSharePriceDate)
        .reduce((sum, m) => sum + m.amount, 0))
      // A fund holding is carried at remaining cost plus its NAV marks — the 1100-<id> + 1200-<id>
      // the ledger carries — never at cost alone.
      if (isFund) unrealizedValue = Math.max(0, totalInvested - totalCostBasisExited + navMarks)
      let fmv: number
      if (company.status === 'exited') {
        fmv = totalRealized
      } else if (company.status === 'written-off') {
        fmv = 0
      } else {
        fmv = unrealizedValue
      }

      const moic = totalInvested > 0 ? (totalRealized + unrealizedValue) / totalInvested : null

      // Track cash flows per portfolio group for group-level IRR
      // Must happen BEFORE per-company terminal value is pushed into groupCashFlows
      const pgFlows = portfolioGroupCashFlows.get(group) ?? []
      for (const cf of groupCashFlows) pgFlows.push(cf)
      portfolioGroupCashFlows.set(group, pgFlows)

      // Compute per-company IRR (pushes terminal value into groupCashFlows)
      let groupIRR: number | null = null
      if (groupCashFlows.length > 0) {
        const terminalValue = company.status === 'written-off' ? 0 : unrealizedValue
        if (terminalValue > 0 || totalRealized > 0) {
          if (company.status !== 'exited' && terminalValue > 0) {
            groupCashFlows.push({ date: asOfDate, amount: terminalValue })
          }
          groupIRR = xirr(groupCashFlows)
        }
      }

      portfolioInvested += totalInvested
      portfolioRealized += totalRealized
      portfolioUnrealized += unrealizedValue
      portfolioFMV += fmv

      companySummaries.push({
        companyId,
        companyName: company.name,
        status: company.status,
        holdingType: company.holding_type ?? 'company',
        portfolioGroup: [group].filter(Boolean),
        totalInvested,
        totalRealized,
        unrealizedValue,
        fmv,
        moic,
        irr: groupIRR,
        proceedsReceived,
        proceedsEscrow,
        totalCostBasisExited,
      })
    }
  }

  // Deal vehicles carried at their LP positions. A direct deal or an SPV whose holding was never
  // recorded as investment transactions (Triple Lift, PromoteIQ (Direct)) has nothing above — but
  // its LPs' positions say what went in and what it is worth. One row per such vehicle, from the
  // live LP report: paid-in as invested, distributions as proceeds, NAV as fair value.
  //
  // Which ones: lib/portfolio/deal-vehicles.ts (holdings carrying no figures; flips once one does).
  const { data: vehicleRows } = await admin
    .from('fund_vehicles' as any)
    .select('id, name, kind, active')
    .eq('fund_id', fundId) as { data: { id: string; name: string; kind: string; active: boolean | null }[] | null }
  const dealVehicles = vehiclesCarriedAtLpPositions(vehicleRows ?? [], companySummaries)
    .filter(v => scopeGroups([v.name], names).length > 0)
  if (dealVehicles.length > 0) {
    const live = await generateLiveReport(admin, fundId, asOf ?? undefined)
    for (const v of dealVehicles) {
      const rows = live.rows.filter(r => r.portfolio_group === v.name)
      if (rows.length === 0) continue
      const sum = (pick: (r: (typeof rows)[number]) => number | null | undefined) => rows.reduce((s, r) => s + (Number(pick(r)) || 0), 0)
      const invested = sum(r => r.paid_in_capital)
      const distributed = sum(r => r.distributions)
      const nav = sum(r => r.nav)
      if (invested === 0 && distributed === 0 && nav === 0) continue
      portfolioInvested += invested
      portfolioRealized += distributed
      portfolioUnrealized += nav
      portfolioFMV += nav
      companySummaries.push({
        companyId: `${DEAL_VEHICLE_PREFIX}${v.id}`,
        companyName: v.name,
        status: nav <= 0.5 && distributed > 0 ? 'exited' : 'active',
        holdingType: 'vehicle',
        portfolioGroup: [v.name],
        totalInvested: invested,
        totalRealized: distributed,
        unrealizedValue: nav,
        fmv: nav,
        moic: invested > 0 ? (distributed + nav) / invested : null,
        // No dated cash flows here — only the positions' balances — so no IRR.
        irr: null,
        proceedsReceived: distributed,
        proceedsEscrow: 0,
        totalCostBasisExited: 0,
      })
    }
  }

  // Sort by invested amount descending
  companySummaries.sort((a, b) => b.totalInvested - a.totalInvested)

  const portfolioMOIC = portfolioInvested > 0
    ? (portfolioRealized + portfolioUnrealized) / portfolioInvested
    : null

  // Portfolio-level IRR: add total unrealized as terminal cash flow
  let portfolioIRR: number | null = null
  if (allCashFlows.length > 0 && (portfolioUnrealized > 0 || portfolioRealized > 0)) {
    if (portfolioUnrealized > 0) {
      allCashFlows.push({ date: asOfDate, amount: portfolioUnrealized })
    }
    portfolioIRR = xirr(allCashFlows)
  }

  // Build group summaries
  const groupAgg = new Map<string, { totalInvested: number; proceedsReceived: number; proceedsEscrow: number; totalRealized: number; unrealizedValue: number; totalCostBasisExited: number }>()

  for (const cs of companySummaries) {
    const groupName = cs.portfolioGroup[0] ?? ''
    const existing = groupAgg.get(groupName) ?? { totalInvested: 0, proceedsReceived: 0, proceedsEscrow: 0, totalRealized: 0, unrealizedValue: 0, totalCostBasisExited: 0 }
    existing.totalInvested += cs.totalInvested
    existing.proceedsReceived += cs.proceedsReceived
    existing.proceedsEscrow += cs.proceedsEscrow
    existing.totalRealized += cs.totalRealized
    existing.unrealizedValue += cs.unrealizedValue
    existing.totalCostBasisExited += cs.totalCostBasisExited
    groupAgg.set(groupName, existing)
  }

  const groups = Array.from(groupAgg.entries()).map(([group, g]) => {
    const moic = g.totalInvested > 0 ? (g.totalRealized + g.unrealizedValue) / g.totalInvested : null

    // Group-level IRR from aggregated cash flows
    let irr: number | null = null
    const gFlows = portfolioGroupCashFlows.get(group)
    if (gFlows && gFlows.length > 0 && (g.unrealizedValue > 0 || g.totalRealized > 0)) {
      const flows = [...gFlows]
      if (g.unrealizedValue > 0) {
        flows.push({ date: asOfDate, amount: g.unrealizedValue })
      }
      irr = xirr(flows)
    }

    return { group, ...g, moic, irr }
  }).sort((a, b) => b.totalInvested - a.totalInvested)

  return NextResponse.json({
    totalInvested: portfolioInvested,
    totalRealized: portfolioRealized,
    totalUnrealized: portfolioUnrealized,
    totalFMV: portfolioFMV,
    portfolioMOIC,
    portfolioIRR,
    companies: companySummaries,
    groups,
  })
}
