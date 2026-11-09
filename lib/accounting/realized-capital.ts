// The American (deal-by-deal) capital base, from the portfolio's own records.
//
// Under an American waterfall a distribution owes the LPs back the capital in every deal REALIZED
// so far — sold, partly sold or written off — plus those deals' share of fees and expenses, before
// the GP takes carry. Which deals have realized, and how much cost each realization took out, is
// in `investment_transactions` (the portfolio tracker is the source of truth for exits; the ledger
// pools realized gains). The math is in the fund engine (`realizedCapitalFromDeals`); this module
// only reads the rows.

import type { SupabaseClient } from '@supabase/supabase-js'
import { realizedCapitalFromDeals, type DealHistory, type RealizedCapital } from '@portfolio/fund-engine'
import { computeCapitalAccounts, type CapitalPosting } from './capital-account'
import { roundCents } from './ledger'
import { investmentsAfterTransfers, isCostTransfer } from '@/lib/portfolio/cost-transfer-math'

const CLOSED = new Set(['exited', 'written-off'])

interface TxnRow {
  company_id: string
  portfolio_group: string | null
  transaction_type: string
  transaction_date: string | null
  investment_cost?: number | null
  fee_amount?: number | null
  cost_basis_exited?: number | null
}

/** Each deal the vehicle holds, as at `asOf`, from its transaction rows. Pure. */
export function dealHistories(
  txns: TxnRow[],
  companies: { id: string; status: string | null }[],
  group: string,
  asOf: string,
): DealHistory[] {
  const byCompany = new Map<string, TxnRow[]>()
  for (const t of txns) {
    if (t.portfolio_group !== group || !t.transaction_date || t.transaction_date > asOf) continue
    const list = byCompany.get(t.company_id) ?? []
    list.push(t)
    byCompany.set(t.company_id, list)
  }
  const status = new Map(companies.map(c => [c.id, c.status]))
  const out: DealHistory[] = []
  for (const [companyId, rows] of Array.from(byCompany.entries())) {
    // A cost transfer is not a realization: in is capital in this deal from its date, out shrinks
    // this deal's capital (investmentsAfterTransfers).
    const investments = investmentsAfterTransfers(
      rows
        .filter(t => t.transaction_type === 'investment')
        .map(t => ({ date: t.transaction_date!, amount: roundCents(Number(t.investment_cost ?? 0) + Number(t.fee_amount ?? 0)) }))
        .filter(i => i.amount > 0),
      rows.filter(isCostTransfer).map(t => ({ date: t.transaction_date!, amount: roundCents(Number(t.investment_cost ?? 0)) })),
    )
    if (investments.length === 0) continue
    const realizations = rows
      .filter(t => t.transaction_type === 'proceeds')
      .map(t => ({ date: t.transaction_date!, costExited: t.cost_basis_exited == null ? null : Math.abs(Number(t.cost_basis_exited)) }))
    // A deal closed out by status alone (a write-off with no proceeds row) realizes what is left on
    // the date of its last transaction — the latest date the records give for it.
    const closedOn = CLOSED.has(String(status.get(companyId) ?? ''))
      ? rows.map(t => t.transaction_date!).sort().at(-1) ?? null
      : null
    out.push({ companyId, investments, realizations, closedOn })
  }
  return out
}

/**
 * The two things the realized base is measured from, besides the deals: the LPs' share of
 * contributions, and the fund's fees and expenses to spread over the deals by cost. Pure.
 */
export function dealByDealBasis(
  capitalPostings: CapitalPosting[],
  recipientIds: Set<string>,
  asOf: string,
): { lpShare: number; expenses: number } {
  const accounts = computeCapitalAccounts(capitalPostings, { end: asOf })
  let all = 0
  let lp = 0
  let expenses = 0
  for (const [id, a] of Array.from(accounts.entries())) {
    all += a.contributions
    if (!recipientIds.has(id)) lp += a.contributions
    expenses += -(a.managementFees + a.expenses) // stored negative on the account
  }
  return { lpShare: all > 0 ? lp / all : 0, expenses: Math.max(0, expenses) }
}

/**
 * What a dollar of deal cost is in LP capital: the LPs' share of contributions, grossed up by the
 * fund's fees and expenses spread over the deals by cost. Pure.
 */
export function realizedCapitalFactor(
  capitalPostings: CapitalPosting[],
  recipientIds: Set<string>,
  deals: DealHistory[],
  asOf: string,
): number {
  const { lpShare, expenses } = dealByDealBasis(capitalPostings, recipientIds, asOf)
  return factorOf(lpShare, expenses, deals.reduce((s, d) => s + d.investments.reduce((t, i) => t + i.amount, 0), 0))
}

/** The factor itself, from the LPs' share, the fees and expenses, and the deals' total cost. */
export function factorOf(lpShare: number, expenses: number, cost: number): number {
  if (lpShare <= 0 || cost <= 0) return 0
  return lpShare * (1 + Math.max(0, expenses) / cost)
}

/** The American capital base for a vehicle as at `asOf`. */
export async function loadRealizedCapital(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  capitalPostings: CapitalPosting[],
  recipientIds: Set<string>,
  asOf: string,
): Promise<RealizedCapital[] | { error: string }> {
  const [{ data: txns, error: txnError }, { data: companies, error: companyError }] = await Promise.all([
    admin.from('investment_transactions' as any)
      .select('company_id, portfolio_group, transaction_type, transaction_date, investment_cost, fee_amount, cost_basis_exited')
      .eq('fund_id', fundId)
      .eq('portfolio_group', group),
    admin.from('companies' as any).select('id, status').eq('fund_id', fundId),
  ])
  // Refuse rather than guess: an empty base would hand the GP carry on the first dollar.
  if (txnError || companyError) return { error: 'The deals could not be read, so the deal-by-deal split cannot be worked out.' }
  const deals = dealHistories((txns as any[]) ?? [], (companies as any[]) ?? [], group, asOf)
  const factor = realizedCapitalFactor(capitalPostings, recipientIds, deals, asOf)
  return realizedCapitalFromDeals(deals, { factor })
}
