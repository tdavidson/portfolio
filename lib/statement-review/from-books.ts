// Self-review (stage 6 of docs/spec/statement-review.md): the app's own statements for a period as
// a package, so the same checks run on them before they are issued. The figures are the ones the
// statements page and its PDF print (computePayload), so a finding here is a finding on what the
// partners would receive.
//
// What the checks can say about the app's own books: whether each statement foots (the balance sheet
// balances, net income allocates), whether every capital account rolls forward and carries on from
// the last signed-off period, whether everyone with a commitment is there, and whether the fee,
// carry and allocations follow the vehicle's terms. The comparisons with the books themselves
// (contributions, cash) agree by construction and say so.

import type { SupabaseClient } from '@supabase/supabase-js'
import { computeCapitalAccounts, type CapitalAccount } from '@/lib/accounting/capital-account'
import { computePayload, loadLedgerData, type StatementPayload } from '@/lib/accounting/statement-package'
import { customPeriod } from '@/lib/accounting/statement-period'
import { loadResolvedCommitments } from '@/lib/accounting/terms'
import type { CapitalFigures, PartnerStatement, StatementPackage } from './types'

const r2 = (n: number) => Math.round(n * 100) / 100
const BOOKS_CITE = { document: "The app's books" }

/**
 * A capital account as the package model states it. Allocations are the account's own lines; the
 * net allocation is everything that moved it besides contributions and distributions, so transfers
 * and unclassified postings show up as a difference between the net and its parts.
 */
export function capitalFromAccount(a: CapitalAccount): CapitalFigures {
  const total = r2(a.managementFees + a.expenses + a.operatingIncome + a.realizedGains + a.unrealizedGains + a.fxTranslation + a.transfers + a.carriedInterest + a.unclassified)
  return {
    beginning: r2(a.beginning),
    contributions: r2(a.contributions),
    distributions: r2(-a.distributions) || 0,
    allocations: {
      income: r2(a.operatingIncome),
      expenses: r2(a.expenses),
      managementFee: r2(a.managementFees),
      realized: r2(a.realizedGains),
      unrealized: r2(a.unrealizedGains + a.fxTranslation),
      carry: r2(a.carriedInterest),
      total,
    },
    ending: r2(a.ending),
  }
}

/** The package from a period's statements payload. Pure. */
export function packageFromPayload(
  payload: Pick<StatementPayload, 'balanceSheet' | 'incomeStatement' | 'scheduleOfInvestments' | 'changesInPartnersCapital'>,
  vehicleId: string,
  period: { start: string; end: string },
  extra: { commitments?: Record<string, number>; toDate?: Map<string, CapitalAccount>; gpBeginning?: number } = {},
): { pkg: StatementPackage; notes: string[] } {
  const notes: string[] = []
  // The statements carry the GP's capital as one balance on the carried-interest line, with no
  // beginning. Given the balance the day before the period, it rolls forward like any account.
  const rows = payload.changesInPartnersCapital.partners.map(p => {
    if (p.id !== 'gp' || extra.gpBeginning == null) return p
    const beginning = r2(extra.gpBeginning)
    return { ...p, beginning, carriedInterest: r2(p.ending - beginning) }
  })
  const totals = { ...payload.changesInPartnersCapital.totals }
  if (extra.gpBeginning != null && rows.some(p => p.id === 'gp')) {
    totals.beginning = r2(totals.beginning + extra.gpBeginning)
    totals.carriedInterest = r2(totals.carriedInterest - extra.gpBeginning)
  }
  const partners: PartnerStatement[] = rows.map(p => {
    const commitment = extra.commitments?.[p.id]
    const itd = extra.toDate?.get(p.id)
    return {
      externalId: p.id,
      name: p.name,
      lpEntityId: p.id,
      ...(commitment != null ? { commitment: r2(commitment) } : {}),
      ...capitalFromAccount(p),
      ...(itd ? { paidInToDate: r2(itd.contributions), distributedToDate: r2(-itd.distributions) || 0 } : {}),
    }
  })
  const bs = payload.balanceSheet
  const is = payload.incomeStatement
  const soi = payload.scheduleOfInvestments
  const unallocated = bs.partnersCapital.unallocatedEarnings
  if (Math.abs(unallocated) > 0.005) {
    notes.push(`Net income of ${unallocated.toFixed(2)} isn't allocated to the partners yet, so their capital accounts understate it. Close the period before issuing statements.`)
  }
  const pkg: StatementPackage = {
    vehicleId,
    periodStart: period.start,
    periodEnd: period.end,
    source: 'books',
    documents: [{ name: BOOKS_CITE.document, kind: 'books' }],
    ...(partners.length ? { partners } : {}),
    fund: {
      partnersCapital: capitalFromAccount(totals),
      balanceSheet: {
        assets: bs.assets.rows.map(r => ({ label: r.name, amount: r2(r.amount) })),
        liabilities: bs.liabilities.rows.map(r => ({ label: r.name, amount: r2(r.amount) })),
        totalAssets: r2(bs.assets.total),
        totalLiabilities: r2(bs.liabilities.total),
        partnersCapital: r2(bs.partnersCapital.total),
        totalLiabilitiesAndCapital: r2(bs.liabilities.total + bs.partnersCapital.total),
      },
      operations: {
        lines: [
          ...is.income.rows.map(r => ({ label: r.name, amount: r2(r.amount) })),
          ...is.expenses.rows.map(r => ({ label: r.name, amount: r2(-r.amount) })),
        ],
        netIncome: r2(is.netIncome),
      },
      ...(soi.rows.length ? { soi: { cost: r2(soi.totalCost), fairValue: r2(soi.totalFairValue) } } : {}),
    },
    ...(soi.source === 'tracker' && soi.rows.length
      ? { holdings: soi.rows.map(h => ({ name: h.name, cost: r2(h.cost), fairValue: r2(h.fairValue) })) }
      : {}),
  }
  return { pkg, notes }
}

/** Build the package from the vehicle's books for the period. Throws a message a person can act on. */
export async function packageFromBooks(
  admin: SupabaseClient, fundId: string, vehicle: { id: string; name: string }, period: { start: string; end: string },
): Promise<{ pkg: StatementPackage; notes: string[] }> {
  const data = await loadLedgerData(admin, fundId, vehicle.name)
  if (!data.postings.length) throw new Error(`${vehicle.name} has no posted entries to review.`)
  const payload = computePayload(data, customPeriod(period.start, period.end))
  const commitments = await loadResolvedCommitments(admin, fundId, vehicle.name, period.end).catch(() => new Map<string, number>())
  const toDate = computeCapitalAccounts(data.capitalPostings, { end: period.end })
  // The GP's balance the day before the period, when the statements show a GP row.
  let gpBeginning: number | undefined
  if (payload.changesInPartnersCapital.partners.some(p => p.id === 'gp')) {
    const before = new Date(Date.parse(`${period.start}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
    const prior = computePayload(data, customPeriod(null, before))
    gpBeginning = prior.changesInPartnersCapital.partners.find(p => p.id === 'gp')?.ending ?? 0
  }
  return packageFromPayload(payload, vehicle.id, period, { commitments: Object.fromEntries(commitments), toDate, ...(gpBeginning != null ? { gpBeginning } : {}) })
}
