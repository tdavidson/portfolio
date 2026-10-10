// Reading a vehicle's tax year into the two inputs the K-1 allocation needs.
//
// k1-allocation.ts is pure and knows nothing about a database. This is the part that does: it
// loads each partner's capital activity on a TAX basis, and the fund's income by character, and
// hands both over.
//
// THE CROSS-BOOK READ. Everything else in this codebase reads the actual book alone. This does
// not, and it is the first place that legitimately shouldn't: a tax-basis capital account is
// `actual + tax adjustments`, which is the whole point of the overlay. The read is registered in
// books.test.ts's exemption list with that reason, so it stays a decision rather than an
// oversight.

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundCents } from './ledger'
import { computeCapitalAccounts, type CapitalPosting } from './capital-account'
import { fetchAllRows } from './load'
import { txnsForVehicle } from './soi'
import { vehicleIdByName } from './vehicle-id'
import { disposalBasis, isLotMethod, type LotMethod } from '@/lib/portfolio/lots'
import { splitGains, type DisposalGain, type GainSplit } from './holding-period'
import type { FundYearCharacter, PartnerYearActivity } from './k1-allocation'
import {
  summarizeQualifiedDividends,
  type DividendFact,
  type QualifiedDividendSummary,
} from './qualified-dividends'

/** Income accounts, by the character a K-1 wants them under. */
const INCOME_CODES = {
  realizedGain: '4000',
  interest: '4100',
  noteInterest: '4110',
  portfolioIncome: '4120',
  dividends: '4130',
} as const

const EXPENSE_CODES = {
  managementFee: '5000',
  partnershipExpense: '5100',
  organizational: '5200',
  syndication: '5250',
  interest: '5300',
} as const

export interface K1YearInputs {
  fund: FundYearCharacter
  partners: PartnerYearActivity[]
  /** Gain the lot method could not date. Reported, never assigned to a holding period. */
  undeterminedGain: number
  /**
   * Character the books cannot supply, with the reason.
   *
   * Not an error and not a zero: a preparer needs to know which lines were never computed, as
   * distinct from computed and found to be nil.
   */
  notDerivable: { line: string; reason: string }[]
}

/**
 * Load one tax year for one vehicle.
 *
 * Reads the actual book and the tax book together — see the note at the top of this file.
 */
export async function loadK1Year(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  taxYear: number,
): Promise<K1YearInputs | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: `Unknown vehicle "${group}"` }

  const yearStart = `${taxYear}-01-01`
  const yearEnd = `${taxYear}-12-31`

  const { data: accts } = await admin
    .from('chart_of_accounts' as any)
    .select('id, code, lp_entity_id')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
  const acctRows = (accts as any[]) ?? []
  const codeById = new Map(acctRows.map(a => [a.id as string, a.code as string]))

  // BOTH BOOKS. Tax basis is the actual ledger plus the tax overlay; reading either alone gives a
  // number that is precisely wrong. See books.test.ts CROSS_BOOK_READS.
  const postingRows = await fetchAllRows<any>((from, to) =>
    admin
      .from('journal_postings' as any)
      .select('account_id, amount, lp_entity_id, book, journal_entries!inner(entry_date, status, source_type, book)')
      .in('book', ['actual', 'tax'])
      .eq('fund_id', fundId)
      .eq('vehicle_id', vehicleId)
      .range(from, to),
  )

  const posted = postingRows.filter(r => r.journal_entries?.status === 'posted')

  // --- Partner activity -----------------------------------------------------
  // Partner CAPITAL accounts only. A receivable (Due from LPs), a distribution payable or an
  // advance carries a partner id too; counted as capital, a call's receivable cancelled the
  // contribution it was raised for.
  const capitalAccountIds = new Set(acctRows.filter(a => a.lp_entity_id).map(a => a.id as string))
  const capitalPostings: CapitalPosting[] = posted
    .filter(r => r.lp_entity_id && capitalAccountIds.has(r.account_id))
    .map(r => ({
      lpEntityId: r.lp_entity_id as string,
      amount: Number(r.amount),
      sourceType: r.journal_entries?.source_type ?? null,
      entryDate: r.journal_entries?.entry_date ?? null,
    }))

  const accounts = computeCapitalAccounts(capitalPostings, { start: yearStart, end: yearEnd })
  const distributionKinds = await loadDistributionKinds(admin, fundId, vehicleId, yearStart, yearEnd)

  const partners: PartnerYearActivity[] = Array.from(accounts.entries()).map(([lpEntityId, a]) => ({
    lpEntityId,
    beginningCapital: a.beginning,
    contributions: a.contributions,
    // The capital account holds distributions as a debit (positive reduces capital); the K-1
    // wants the magnitude.
    distributions: Math.abs(a.distributions),
    distributionsByKind: distributionKinds.get(lpEntityId),
    operatingIncome: a.operatingIncome,
    realizedGains: a.realizedGains,
    expenses: Math.abs(a.managementFees) + Math.abs(a.expenses),
    carriedInterest: a.carriedInterest,
    // Currency translation is unrealized too: once the year's adjustments are posted both net to
    // nothing in tax capital, and anything left is the book-basis case k1-package.ts blocks on.
    unrealizedGains: roundCents(a.unrealizedGains + a.fxTranslation),
    otherChanges: roundCents(a.transfers + a.unclassified),
    endingCapital: a.ending,
  }))

  // --- Fund character -------------------------------------------------------
  const inYear = (r: any) =>
    r.journal_entries?.entry_date >= yearStart && r.journal_entries?.entry_date <= yearEnd
  const onCode = (r: any, code: string) => codeById.get(r.account_id) === code
  // Income accounts are credited, so a credit balance is negative under this ledger's sign
  // convention. Income is the negation.
  const incomeOn = (code: string) =>
    roundCents(-posted.filter(r => inYear(r) && onCode(r, code)).reduce((s, r) => s + Number(r.amount), 0))
  const expenseOn = (code: string) =>
    roundCents(posted.filter(r => inYear(r) && onCode(r, code)).reduce((s, r) => s + Number(r.amount), 0))

  // Interest and dividends have their OWN accounts now, so both come straight off the ledger
  // rather than one being inferred from the other. The tagged portfolio rows become a cross-check
  // (below) instead of the classifier.
  const dividends = incomeOn(INCOME_CODES.dividends)
  const interest = roundCents(incomeOn(INCOME_CODES.interest) + incomeOn(INCOME_CODES.noteInterest))
  // The portfolio side is read for THIS vehicle only. A firm with several funds holds the same
  // company in more than one, and a fund-wide read put one fund's sales and dividends on
  // another's K-1s.
  const taggedDividends = await loadDividendIncome(admin, fundId, group, yearStart, yearEnd)
  const qualified = await loadQualifiedDividends(admin, fundId, group, yearStart, yearEnd)

  const gains = await loadRealizedGainSplit(admin, fundId, group, taxYear)

  const deductions = roundCents(
    expenseOn(EXPENSE_CODES.managementFee) +
      expenseOn(EXPENSE_CODES.partnershipExpense) +
      expenseOn(EXPENSE_CODES.organizational) +
      expenseOn(EXPENSE_CODES.syndication) +
      expenseOn(EXPENSE_CODES.interest),
  )

  const notDerivable: { line: string; reason: string }[] = []

  // The portfolio tags no longer classify anything, but they still know something the ledger
  // does not: that a dividend happened. A gap between the two means one was booked somewhere
  // other than 4130 — very likely 4100, where it will report as interest.
  if (roundCents(taggedDividends - dividends) !== 0) {
    notDerivable.push({
      line: 'Dividends (6a)',
      reason:
        `The portfolio records ${taggedDividends.toFixed(2)} of dividend income for this year, ` +
        `but account 4130 holds ${dividends.toFixed(2)}. The difference was booked to another ` +
        'account — most likely 4100, where it will be reported as interest — and needs ' +
        'reclassifying by journal entry.',
    })
  }
  if (qualified.uncertain !== 0) {
    notDerivable.push({
      line: 'Qualified dividends (6b)',
      reason:
        `${qualified.uncertain.toFixed(2)} of dividends could not be classified. ` +
        qualified.verdicts
          .filter(v => v.verdict === 'uncertain')
          .map(v => v.reason)
          .slice(0, 3)
          .join(' '),
    })
  }
  if (gains.undetermined !== 0) {
    notDerivable.push({
      line: 'Short/long-term split (8, 9a)',
      reason:
        `${gains.undetermined.toFixed(2)} of realized gain could not be dated — the vehicle uses ` +
        'average cost, or a disposal drew on units no lot supplied.',
    })
  }

  return {
    fund: {
      interest,
      ordinaryDividends: dividends,
      qualifiedDividends: qualified.qualified,
      shortTermGain: gains.shortTerm,
      longTermGain: gains.longTerm,
      longTermGainWithinApiPeriod: gains.longTermWithinApiPeriod,
      otherIncome: incomeOn(INCOME_CODES.portfolioIncome),
      deductions,
    },
    partners,
    undeterminedGain: gains.undetermined,
    notDerivable,
  }
}

/** Each partner's distributions for the year, split by K-1 box 19 form. */
async function loadDistributionKinds(
  admin: SupabaseClient,
  fundId: string,
  vehicleId: string,
  yearStart: string,
  yearEnd: string,
): Promise<Map<string, { cash: number; property: number; other: number }>> {
  const { data } = await admin
    .from('distributions' as any)
    .select('kind, distribution_lines(lp_entity_id, amount)')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    // A draft is a declaration that never completed — nothing was distributed.
    .eq('status', 'declared')
    .gte('distribution_date', yearStart)
    .lte('distribution_date', yearEnd)

  const out = new Map<string, { cash: number; property: number; other: number }>()
  for (const d of ((data as any[]) ?? [])) {
    const bucket = d.kind === 'in_kind' ? 'property' : d.kind === 'other' ? 'other' : 'cash'
    for (const l of (d.distribution_lines ?? [])) {
      const cur = out.get(l.lp_entity_id) ?? { cash: 0, property: 0, other: 0 }
      cur[bucket] = roundCents(cur[bucket] + Number(l.amount))
      out.set(l.lp_entity_id, cur)
    }
  }
  return out
}

/** Dividend income recognised in the year, from the portfolio side's tagged income rows. */
async function loadDividendIncome(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  yearStart: string,
  yearEnd: string,
): Promise<number> {
  const { data } = await admin
    .from('investment_transactions' as any)
    .select('income_amount, income_kind, transaction_date')
    .eq('fund_id', fundId)
    .eq('transaction_type', 'income')
    .eq('income_kind', 'dividend')
    .eq('portfolio_group', group)
    .gte('transaction_date', yearStart)
    .lte('transaction_date', yearEnd)
  return roundCents(((data as any[]) ?? []).reduce((s, r) => s + Number(r.income_amount ?? 0), 0))
}

/** Realized gain for the year, split short/long by the lots each disposal consumed. */
async function loadRealizedGainSplit(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  taxYear: number,
): Promise<GainSplit> {
  const { data: settings } = await admin
    .from('fund_settings' as any)
    .select('lot_method')
    .eq('fund_id', fundId)
    .maybeSingle()
  const raw = (settings as any)?.lot_method
  const method: LotMethod = isLotMethod(raw) ? raw : 'fifo'

  // Every transaction for the fund's companies: lots are built from the full history, because a
  // disposal in this year can consume a lot bought in any prior one.
  // This vehicle's own rows, plus the company-wide price signals and splits it shares — the same
  // set its schedule of investments is built from.
  const txns = txnsForVehicle(await fetchAllRows<any>((from, to) =>
    admin
      .from('investment_transactions' as any)
      .select('*')
      .eq('fund_id', fundId)
      .range(from, to),
  ), group)

  const byCompany = new Map<string, any[]>()
  for (const t of txns) {
    const key = t.company_id as string
    if (!key) continue
    const list = byCompany.get(key) ?? []
    list.push(t)
    byCompany.set(key, list)
  }

  const yearStart = `${taxYear}-01-01`
  const yearEnd = `${taxYear}-12-31`
  const disposals: DisposalGain[] = []

  for (const rows of Array.from(byCompany.values())) {
    const bases = disposalBasis(rows as any, method)
    const proceedsByTxn = new Map<string, number>(
      rows
        .filter(r => r.transaction_type === 'proceeds')
        .map(r => [r.id as string, Number(r.proceeds_received ?? 0) + Number(r.proceeds_escrow ?? 0)]),
    )
    for (const b of bases) {
      if (b.date < yearStart || b.date > yearEnd) continue
      disposals.push({ basis: b, proceeds: proceedsByTxn.get(b.txnId) ?? 0 })
    }
  }

  return splitGains(disposals)
}

/**
 * Every dividend in the year, with the two facts §1(h)(11) turns on: who paid it, and how long
 * the stock had been held.
 *
 * Lots come from the full transaction history, because a dividend in this year is paid on stock
 * that may have been bought in any prior one.
 */
async function loadQualifiedDividends(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  yearStart: string,
  yearEnd: string,
): Promise<QualifiedDividendSummary> {
  const { data: rows } = await admin
    .from('investment_transactions' as any)
    .select('id, company_id, income_amount, transaction_date')
    .eq('fund_id', fundId)
    .eq('transaction_type', 'income')
    .eq('income_kind', 'dividend')
    .eq('portfolio_group', group)
    .gte('transaction_date', yearStart)
    .lte('transaction_date', yearEnd)
  const dividendRows = (rows as any[]) ?? []
  if (dividendRows.length === 0) return summarizeQualifiedDividends([])

  const companyIds = Array.from(new Set(dividendRows.map(r => r.company_id).filter(Boolean)))
  const { data: companies } = await admin
    .from('companies' as any)
    .select('id, country, holding_type')
    .eq('fund_id', fundId)
    .in('id', companyIds)
  const byCompany = new Map(((companies as any[]) ?? []).map(c => [c.id as string, c]))

  // Acquisitions only: a lot is created by buying, and by in-kind income whose fair value became
  // its basis. Disposals do not create holding period, they end it.
  const acquisitions = await fetchAllRows<any>((from, to) =>
    admin
      .from('investment_transactions' as any)
      .select('company_id, transaction_date, shares_acquired, transaction_type')
      .eq('fund_id', fundId)
      .eq('portfolio_group', group)
      .in('company_id', companyIds)
      .range(from, to),
  )
  const lotsByCompany = new Map<string, { acquired: string; units: number }[]>()
  for (const t of acquisitions) {
    if (t.transaction_type !== 'investment' && t.transaction_type !== 'income') continue
    const units = Number(t.shares_acquired ?? 0)
    if (!(units > 0) || !t.transaction_date) continue
    const list = lotsByCompany.get(t.company_id) ?? []
    list.push({ acquired: t.transaction_date, units })
    lotsByCompany.set(t.company_id, list)
  }

  const facts: DividendFact[] = dividendRows.map(r => {
    const company = byCompany.get(r.company_id)
    return {
      id: r.id,
      companyId: r.company_id,
      date: r.transaction_date,
      amount: Number(r.income_amount ?? 0),
      payerCountry: company?.country ?? null,
      holdingType: company?.holding_type ?? null,
      // Only lots that existed on the dividend date can have been held for it.
      lots: (lotsByCompany.get(r.company_id) ?? []).filter(l => l.acquired <= r.transaction_date),
    }
  })

  return summarizeQualifiedDividends(facts)
}
