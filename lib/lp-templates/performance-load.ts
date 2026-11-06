// Load one vehicle's ILPA performance data (performance.ts) from the books, the capital call
// register, the credit facility register and the investment tracker.
//
// WHO IS COUNTED. The template states the fee-paying limited partners' share of the fund. So the
// general partner class is left out, and so is any partner the allocation terms exclude from the
// management fee (partner_allocation_terms, category management_fee, participates = false).
//
// HOW EACH FLOW IS TYPED.
//   Contributions   the capital call behind the entry says what it was for (capital_calls.purposes):
//                   investment → Investments, management fee and fund expense → Management
//                   Fees/Partnership Expenses, other → Working Capital. A call that names no purpose,
//                   or a contribution with no call, counts as Investments, and a note says so. The part
//                   of a call that paid facility interest or fees (a register row linked to the call)
//                   is Fund-level Subscription Facility Fees/Interest.
//   Refunds         a contribution reversed (a debit to capital on the call line) is a Return of
//                   Excess Capital Called: Investments.
//   Distributions   Permanent, except recycled proceeds (recallable by definition), which are Recallable.
//   Carry           carry paid to the GP class, and carry accrued but unpaid at the date, in the
//                   fee-paying partners' share of the carry reallocated from the limited partners.
//   NAV             the fee-paying partners' ending capital.
//   Facility        for subscription lines only (ILPA's "fund-level subscription facility"): each draw
//                   a Drawdown typed by its purpose, each repayment a Synthetic Distribution typed by
//                   the draws it retired, and the balance outstanding at the date as the Gross Up. All
//                   in the fee-paying partners' share of commitments, since the line is the fund's.

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundCents } from '@/lib/accounting/ledger'
import { loadReportingCapital } from '@/lib/accounting/reporting-capital'
import { bucketForSourceType, RECYCLED_PROCEEDS_SOURCE } from '@/lib/accounting/capital-account'
import { loadPartnerTerms } from '@/lib/accounting/terms'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { normalizePurposes } from '@/lib/accounting/capital-call-check'
import { txnsForVehicle } from '@/lib/accounting/soi'
import { computeSummary } from '@/lib/investments'
import type { InvestmentTransaction, CompanyStatus } from '@/lib/types/database'
import { facilitiesWithStatus, loadFacilityRegister, type DrawPurpose, type FacilityWithStatus } from '@/lib/accounting/credit-facility'
import { buildIlpaPerformance, portfolioPerformance, type IlpaPerformance, type PerformanceFlow, type PortfolioHolding, type PortfolioPerformance } from './performance'
import { ILPA_PERFORMANCE_ATTRIBUTION, type PerformanceType } from './performance-types'

const DRAWDOWN_TYPE: Record<DrawPurpose, PerformanceType> = {
  investment: 'Fund-level Subscription Facility Drawdown: Investments',
  management_fee: 'Fund-level Subscription Facility Drawdown: Management Fees/Partnership Expenses',
  fund_expense: 'Fund-level Subscription Facility Drawdown: Management Fees/Partnership Expenses',
  working_capital: 'Fund-level Subscription Facility Drawdown: Working Capital',
}

const REPAYMENT_TYPE: Record<DrawPurpose, PerformanceType> = {
  // The template has no working capital repayment row; working capital enters the same returns as
  // investments, so its repayment is typed with them.
  investment: 'Synthetic Distribution: Fund-level Subscription Facility Repayment: Investments',
  working_capital: 'Synthetic Distribution: Fund-level Subscription Facility Repayment: Investments',
  management_fee: 'Synthetic Distribution: Fund-level Subscription Facility Repayment: Management Fees/Partnership Expenses',
  fund_expense: 'Synthetic Distribution: Fund-level Subscription Facility Repayment: Management Fees/Partnership Expenses',
}

const CALL_INVEST: PerformanceType = 'Capital Call: Investments'
const CALL_FEES: PerformanceType = 'Capital Call: Management Fees/Partnership Expenses'
const CALL_WC: PerformanceType = 'Capital Call: Working Capital'
const CALL_FACILITY: PerformanceType = 'Capital Call: Fund-level Subscription Facility Fees/Interest'

/**
 * How a call's money divides between the template's call types. Starts from its purposes (or all
 * Investments when it names none) and moves `facilityCost` out of fees first, then working capital,
 * then investments, into Facility Fees/Interest. Weights, not amounts: each partner's contribution
 * is split in the same proportions.
 */
export function callWeights(
  purposes: { category: string; amount: number }[],
  callTotal: number,
  facilityCost: number,
): Map<PerformanceType, number> {
  const w = new Map<PerformanceType, number>()
  const add = (t: PerformanceType, a: number) => w.set(t, roundCents((w.get(t) ?? 0) + a))
  const named = purposes.filter(p => p.amount > 0)
  if (named.length === 0) add(CALL_INVEST, callTotal)
  for (const p of named) {
    add(p.category === 'investment' ? CALL_INVEST : p.category === 'other' ? CALL_WC : CALL_FEES, p.amount)
  }
  let left = facilityCost
  for (const t of [CALL_FEES, CALL_WC, CALL_INVEST]) {
    if (left <= 0.005) break
    const have = w.get(t) ?? 0
    const take = Math.min(have, left)
    if (take > 0) {
      w.set(t, roundCents(have - take))
      add(CALL_FACILITY, take)
      left = roundCents(left - take)
    }
  }
  for (const [t, a] of Array.from(w.entries())) if (a <= 0.005) w.delete(t)
  return w
}

/** Split `amount` by `weights`, to the cent, the remainder on the largest part. */
export function splitByWeights(amount: number, weights: Map<PerformanceType, number>): { type: PerformanceType; amount: number }[] {
  const entries = Array.from(weights.entries())
  const total = entries.reduce((s, [, w]) => s + w, 0)
  if (entries.length === 0 || total <= 0) return [{ type: CALL_INVEST, amount: roundCents(amount) }]
  const parts = entries.map(([type, w]) => ({ type, amount: roundCents((amount * w) / total) }))
  const diff = roundCents(amount - parts.reduce((s, p) => s + p.amount, 0))
  if (diff !== 0) {
    const big = parts.reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a))
    big.amount = roundCents(big.amount + diff)
  }
  return parts
}

const money = (n: number, currency: string) =>
  n.toLocaleString('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 })

export interface FlowInputs {
  asOf: string
  postings: { lpEntityId: string; amount: number; sourceType?: string | null; entryDate?: string | null; entryId?: string }[]
  /** partner_class per partner; absent = 'lp'. */
  classes: Map<string, string>
  /** Partners the allocation terms exclude from the management fee. */
  notFeePaying: Set<string>
  commitmentByLp: Map<string, number>
  /** Partners whose capital is not wholly from dated ledger entries. */
  undatedPartners: Set<string>
  calls: { id: string; journalEntryId: string | null; purposes: { category: string; amount: number }[]; total: number }[]
  facilities: FacilityWithStatus[]
}

export interface TypedFlows {
  flows: PerformanceFlow[]
  included: number
  excluded: number
  feePayingCommitment: number
  totalCommitment: number
  /** Contributions typed as Investments for want of a purpose. */
  untyped: number
  /** Opening balances shown as paid in on their date. */
  opening: number
  /** Included partners whose capital is not from dated entries. */
  reportedOnly: number
  /** Subscription line interest and fees not linked to the call that paid them. */
  unlinkedCost: number
}

/** The fee-paying partners' cash flows, typed by ILPA transaction type. Pure. */
export function typedPerformanceFlows(x: FlowInputs): TypedFlows {
  const { asOf, postings, classes, notFeePaying, commitmentByLp } = x
  const ids = Array.from(new Set([...postings.map(p => p.lpEntityId), ...Array.from(commitmentByLp.keys())]))
  const isGp = (id: string) => (classes.get(id) ?? 'lp') === 'gp'
  const included = new Set(ids.filter(id => !isGp(id) && !notFeePaying.has(id)))
  const lpClass = new Set(ids.filter(id => !isGp(id)))
  const totalCommitment = roundCents(Array.from(commitmentByLp.values()).reduce((s, v) => s + v, 0))
  const feePayingCommitment = roundCents(Array.from(commitmentByLp.entries()).filter(([id]) => included.has(id)).reduce((s, [, v]) => s + v, 0))
  const share = totalCommitment > 0 ? feePayingCommitment / totalCommitment : 0

  const flows: PerformanceFlow[] = []
  const dated = postings.filter(p => p.entryDate && p.entryDate <= asOf)

  // ── The register: which call paid facility interest and fees ───────────────
  const subscription = x.facilities.filter(f => f.kind === 'subscription')
  const costByCall = new Map<string, number>()
  let unlinkedCost = 0
  for (const e of subscription.flatMap(f => f.events)) {
    if (!e.live || e.date > asOf || (e.type !== 'interest' && e.type !== 'fee')) continue
    if (e.callId) costByCall.set(e.callId, roundCents((costByCall.get(e.callId) ?? 0) + e.amount))
    else unlinkedCost = roundCents(unlinkedCost + e.amount)
  }

  // ── Contributions and distributions ────────────────────────────────────────
  const weightsByEntry = new Map<string, Map<PerformanceType, number>>()
  for (const c of x.calls) {
    if (c.journalEntryId) weightsByEntry.set(c.journalEntryId, callWeights(c.purposes, c.total, costByCall.get(c.id) ?? 0))
  }
  let untyped = 0
  let opening = 0
  for (const p of dated) {
    if (!included.has(p.lpEntityId)) continue
    const bucket = bucketForSourceType(p.sourceType, p.amount)
    const date = p.entryDate!
    // A capital account is credit-normal, so the posting's debit-positive amount is already the
    // partner's side of the cash: paid in negative, paid out positive.
    if (bucket === 'beginning') {
      opening = roundCents(opening - p.amount)
      flows.push({ date, type: CALL_INVEST, amount: roundCents(p.amount) })
    } else if (bucket === 'contributions') {
      if (p.amount > 0 && p.sourceType !== RECYCLED_PROCEEDS_SOURCE) {
        flows.push({ date, type: 'Distribution: Return of Excess Capital Called: Investments', amount: roundCents(p.amount) })
        continue
      }
      const weights = p.entryId ? weightsByEntry.get(p.entryId) : undefined
      if (!weights && p.sourceType !== RECYCLED_PROCEEDS_SOURCE) untyped = roundCents(untyped - p.amount)
      for (const part of splitByWeights(p.amount, weights ?? new Map([[CALL_INVEST, 1]]))) flows.push({ date, ...part })
    } else if (bucket === 'distributions') {
      flows.push({ date, type: p.sourceType === RECYCLED_PROCEEDS_SOURCE ? 'Distribution: Recallable' : 'Distribution: Permanent', amount: roundCents(p.amount) })
    }
  }

  // ── Carry ─────────────────────────────────────────────────────────────────
  // The limited partners' carry is the reallocation out of their capital; the fee-paying share of it
  // is what the gross returns add back, paid (to the GP class) and accrued but unpaid.
  let carryAll = 0, carryIncluded = 0, gpUnpaid = 0
  const carryPaid: { date: string; amount: number }[] = []
  for (const p of dated) {
    if (bucketForSourceType(p.sourceType, p.amount) !== 'carriedInterest') continue
    if (lpClass.has(p.lpEntityId)) {
      carryAll += p.amount
      if (included.has(p.lpEntityId)) carryIncluded += p.amount
    } else {
      gpUnpaid -= p.amount
      if (p.sourceType === 'carry_distribution') carryPaid.push({ date: p.entryDate!, amount: p.amount })
    }
  }
  const carryShare = carryAll > 0.005 ? carryIncluded / carryAll : 0
  for (const c of carryPaid) flows.push({ date: c.date, type: 'Carry / Clawback', amount: roundCents(c.amount * carryShare) })
  if (Math.abs(gpUnpaid * carryShare) >= 0.005) flows.push({ date: asOf, type: 'Quarter-end Adjustment for Carry Allocation', amount: roundCents(gpUnpaid * carryShare) })

  // ── NAV ───────────────────────────────────────────────────────────────────
  const nav = roundCents(-dated.filter(p => included.has(p.lpEntityId)).reduce((s, p) => s + p.amount, 0))
  if (Math.abs(nav) >= 0.005) flows.push({ date: asOf, type: 'NAV', amount: nav })

  // ── Subscription facility ─────────────────────────────────────────────────
  for (const f of subscription) {
    for (const e of f.events) {
      if (!e.live || e.type !== 'draw' || e.date > asOf) continue
      flows.push({ date: e.date, type: DRAWDOWN_TYPE[e.purpose ?? 'investment'], amount: roundCents(-e.amount * share) })
    }
    for (const r of f.match.repayments) flows.push({ date: r.date, type: REPAYMENT_TYPE[r.purpose], amount: roundCents(r.amount * share) })
    if (f.balance.outstanding > 0.005) {
      flows.push({ date: asOf, type: 'Gross Up Outstanding Balance from Fund-level Subscription Facility', amount: roundCents(f.balance.outstanding * share) })
    }
  }

  return {
    flows,
    included: included.size,
    excluded: ids.length - included.size,
    feePayingCommitment,
    totalCommitment,
    untyped,
    opening,
    reportedOnly: Array.from(included).filter(id => x.undatedPartners.has(id)).length,
    unlinkedCost,
  }
}

/**
 * The vehicle's holdings as of a date, from the investment tracker: what the performance report's
 * gross portfolio returns are computed on. The investor letter's brief takes its gross IRR and MOIC
 * from the same holdings (loadPortfolioPerformance), so the two always state the same figure.
 */
export function portfolioHoldings(
  txns: InvestmentTransaction[], companies: { id: string; status: string | null }[], group: string, asOf: string,
): PortfolioHolding[] {
  const byCompany = new Map<string, InvestmentTransaction[]>()
  for (const t of txns) {
    if (!byCompany.has(t.company_id)) byCompany.set(t.company_id, [])
    byCompany.get(t.company_id)!.push(t)
  }
  const asOfDate = new Date(`${asOf}T00:00:00Z`)
  const holdings: PortfolioHolding[] = []
  for (const c of companies) {
    const relevant = txnsForVehicle(byCompany.get(c.id) ?? [], group).filter(t => !t.transaction_date || t.transaction_date <= asOf)
    if (!relevant.some(t => t.transaction_type === 'investment' && t.portfolio_group === group)) continue
    const status = (c.status ?? 'active') as CompanyStatus
    const s = computeSummary(relevant, status, asOfDate)
    const hFlows: { date: string; amount: number }[] = []
    for (const t of relevant) {
      if (!t.transaction_date) continue
      if (t.transaction_type === 'investment' && t.investment_cost) hFlows.push({ date: t.transaction_date, amount: -t.investment_cost })
      else if (t.transaction_type === 'proceeds' && t.proceeds_received) hFlows.push({ date: t.transaction_date, amount: t.proceeds_received })
    }
    const realized = status !== 'active'
    holdings.push({ realized, invested: s.totalInvested, proceeds: s.totalRealized, value: realized ? 0 : s.unrealizedValue, flows: hFlows })
  }
  return holdings
}

/** The performance report's gross portfolio returns for a vehicle, as of a date, alone. */
export async function loadPortfolioPerformance(
  admin: SupabaseClient, fundId: string, group: string, asOf: string,
): Promise<PortfolioPerformance | null> {
  const [txnRows, companyRows] = await Promise.all([
    admin.from('investment_transactions' as any).select('*').eq('fund_id', fundId),
    admin.from('companies' as any).select('id, status').eq('fund_id', fundId),
  ])
  if ((txnRows as any)?.error || (companyRows as any)?.error) return null
  const holdings = portfolioHoldings((((txnRows as any)?.data as InvestmentTransaction[]) ?? []), (((companyRows as any)?.data as any[]) ?? []), group, asOf)
  return holdings.length ? portfolioPerformance(holdings, asOf) : null
}

export async function loadIlpaPerformance(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  asOf: string,
): Promise<IlpaPerformance> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const [capital, terms, classRows, fundRow, settingsRow, callRows, register, txnRows, companyRows] = await Promise.all([
    loadReportingCapital(admin, fundId, group, asOf),
    loadPartnerTerms(admin, fundId, group),
    (admin as any).from('lp_entities').select('id, partner_class').eq('fund_id', fundId),
    admin.from('funds' as any).select('name').eq('id', fundId).maybeSingle(),
    admin.from('fund_settings' as any).select('currency').eq('fund_id', fundId).maybeSingle(),
    vehicleId
      ? admin.from('capital_calls' as any).select('id, status, journal_entry_id, purposes, capital_call_lines(amount)').eq('fund_id', fundId).eq('vehicle_id', vehicleId)
      : Promise.resolve({ data: [] }),
    loadFacilityRegister(admin, fundId, group),
    admin.from('investment_transactions' as any).select('*').eq('fund_id', fundId),
    admin.from('companies' as any).select('id, status').eq('fund_id', fundId),
  ])
  const currency = ((settingsRow as any)?.data?.currency as string) || 'USD'
  const facilities = facilitiesWithStatus(register, asOf)
  const undatedPartners = new Set(Array.from(capital.evidenceByLp.entries())
    .filter(([, e]) => e.basis !== 'ledger' || e.missing.length > 0 || e.conflict)
    .map(([id]) => id))
  const t = typedPerformanceFlows({
    asOf,
    postings: capital.postings,
    classes: new Map<string, string>((((classRows as any)?.data as any[]) ?? []).map(e => [e.id, e.partner_class ?? 'lp'])),
    notFeePaying: new Set(terms.filter(x => x.category === 'management_fee' && !x.participates).map(x => x.lpEntityId)),
    commitmentByLp: capital.commitmentByLp,
    undatedPartners,
    calls: ((((callRows as any)?.data as any[]) ?? [])).filter(c => c.status !== 'draft').map(c => ({
      id: c.id,
      journalEntryId: c.journal_entry_id ?? null,
      purposes: normalizePurposes(c.purposes),
      total: roundCents(((c.capital_call_lines as any[]) ?? []).reduce((s, l) => s + Number(l.amount), 0)),
    })),
    facilities,
  })

  // ── Portfolio ─────────────────────────────────────────────────────────────
  const holdings = portfolioHoldings(
    (((txnRows as any)?.data as InvestmentTransaction[]) ?? []), (((companyRows as any)?.data as any[]) ?? []), group, asOf,
  )

  // ── Notes ─────────────────────────────────────────────────────────────────
  const footnotes: string[] = [
    `Cash flows are the fee-paying limited partners' share of the fund: ${t.included} partner${t.included === 1 ? '' : 's'} with ${money(t.feePayingCommitment, currency)} of ${money(t.totalCommitment, currency)} committed. The general partner and partners who do not bear the management fee are excluded.`,
    "Net asset value is the fee-paying partners' capital on the books at the date, after accrued carried interest. The gross returns add back carried interest paid and accrued.",
    "The net returns here are the fee-paying limited partners' only, so they can differ from the fund's net figures as the fund administrator reports them, which are what investor letters state.",
  ]
  if (t.untyped > 0.005) {
    footnotes.push(`${money(t.untyped, currency)} of contributions came from calls that do not say what they were for (or from entries outside a call), so they are shown as Capital Call: Investments. Add purposes to those calls to type them.`)
  }
  if (t.opening > 0.005) {
    footnotes.push(`${money(t.opening, currency)} of capital carried in as opening balances is shown as Capital Call: Investments on its opening date, since the cash flows before it are not on these books.`)
  }
  if (t.reportedOnly > 0) {
    footnotes.push(`${t.reportedOnly} included partner${t.reportedOnly === 1 ? "'s" : "s'"} capital comes from reported statements rather than dated ledger entries, so the cash flows may be incomplete and the IRRs should not be relied on.`)
  }
  if (t.unlinkedCost > 0.005) {
    footnotes.push(`${money(t.unlinkedCost, currency)} of subscription line interest and fees is not linked to the call that paid it, so it stays inside the Management Fees/Partnership Expenses calls and the "without facility" returns include it. Link each payment to its call on the facility register to remove it.`)
  }
  if (facilities.length === 0) {
    footnotes.push('No credit facility is on the register, so the returns with and without a subscription facility are the same.')
  }
  for (const f of facilities) {
    if (f.kind !== 'subscription') footnotes.push(`${f.name} is not a subscription facility, so it is left in the "without facility" returns, as the template asks.`)
    else if (f.match.overRepaid > 0.005) footnotes.push(`${f.name}: ${money(f.match.overRepaid, currency)} was repaid before it was drawn on the register. Check the facility's draws.`)
  }
  footnotes.push(
    'Accrued management fees and partnership expenses, and accrued facility interest, are already in the net asset value; the quarter-end adjustments for them are not stated separately.',
    'Recallable distributions are typed as Permanent except recycled proceeds, which are Recallable.',
    'IRRs use the exact dates of each flow, with the quarter-end adjustments and the net asset value on the as-of date. Portfolio returns are gross of fees, expenses and carry, from the investment tracker.',
    ILPA_PERFORMANCE_ATTRIBUTION,
  )

  return buildIlpaPerformance({
    fund: { name: ((fundRow as any)?.data?.name as string) || group, vehicle: group, currency, asOf, basis: 'Since inception' },
    population: { feePayingPartners: t.included, excludedPartners: t.excluded, feePayingCommitment: t.feePayingCommitment, totalCommitment: t.totalCommitment },
    portfolio: holdings.length ? portfolioPerformance(holdings, asOf) : null,
    facilities: facilities.map(f => ({ name: f.name, kind: f.kind, outstanding: f.balance.outstanding, inWithoutSeries: f.kind === 'subscription' })),
    footnotes,
    flows: t.flows,
  })
}
