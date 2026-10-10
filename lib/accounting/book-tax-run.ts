// Proposal → posted entry: the loader and the run.
//
// book-tax.ts derives the differences, book-tax-entries.ts turns them into postings, and this
// reads the actual book to feed the first and persists the output of the second. It is the only
// part of the three that touches a database, which is why the other two can be tested exhaustively
// without one.
//
// RE-RUNNABLE, on the close's pattern. Every entry carries `source_ref = tax:<year>`, so a re-run
// voids exactly what the last run wrote before writing again — the alternative is a second full
// set against the same year, silently doubling every adjustment. Hand-authored tax entries have no
// such source_ref and are never touched, which is the whole reason a fund can correct what this
// proposes.

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundCents } from './ledger'
import { ACTUAL_BOOK } from './books'
import { accountIdByCode, ensureCapitalAccounts, persistEntry } from './persist'
import { vehicleIdByName } from './vehicle-id'
import { assembleLoadedLedger, fetchAllRows } from './load'
import { loadCarryTerms } from './carry'
import { carryOnUnrealizedForYear } from './book-tax'
import { proposeAdjustments, type ActualBookYear, type ProposedAdjustment } from './book-tax'
import {
  buildTaxAdjustmentEntries,
  type TaxAdjustmentAccounts,
  type UnbuildableAdjustment,
} from './book-tax-entries'

/** Accounts the adjustments post to. Codes, so the mapping is legible in one place. */
const CODES = {
  unrealizedAsset: '1200',
  unrealizedIncome: '4200',
  organizationalExpense: '5200',
  deferredOrgCosts: '1400',
  syndicationExpense: '5250',
  capitalizedSyndication: '1450',
} as const

export function taxSourceRef(taxYear: number): string {
  return `tax:${taxYear}`
}

interface YearPostingRow {
  account_id: string
  amount: number | string
  lp_entity_id: string | null
  entry_date: string
  source_type: string | null
}

/**
 * Read one tax year of actual-book activity for a vehicle.
 *
 * Everything here is a MOVEMENT within the year, not a balance — a year's adjustment is what
 * happened in the year — with one exception: organizational costs to date, which §709 needs
 * since inception because the immediate deduction is computed off the total, not off one year's
 * spend.
 */
export async function loadActualBookYear(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  taxYear: number,
  opts?: { inceptionDate?: string },
): Promise<{ year: ActualBookYear; perLpCarry: Map<string, number>; perLpUnrealized: Map<string, number>; perLpFx: Map<string, number>; assetMoves: { unrealized: Map<string, number>; fx: Map<string, number> } } | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: `Unknown vehicle "${group}"` }

  const yearStart = `${taxYear}-01-01`
  const yearEnd = `${taxYear}-12-31`

  const { data: accts } = await admin
    .from('chart_of_accounts' as any)
    .select('id, code, name, type, subtype, lp_entity_id, company_id')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
  const idByCode = new Map(((accts as any[]) ?? []).map(a => [a.code as string, a.id as string]))
  const codeById = new Map(((accts as any[]) ?? []).map(a => [a.id as string, a.code as string]))

  // Postings join their entry for the date, status and source_type. Actual book only: the tax
  // book is the OUTPUT of this run, and reading it here would compound each re-run onto the last.
  // Paged: a single select stops at the API's row cap (1,000), and an adjustment computed from
  // the first thousand postings is silently short for any fund with more.
  const rows = await fetchAllRows<any>((from, to) => admin
    .from('journal_postings' as any)
    .select('journal_entry_id, account_id, amount, currency, lp_entity_id, journal_entries!inner(entry_date, status, source_type, book)')
    .eq('book', ACTUAL_BOOK)
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .order('id')
    .range(from, to))

  const flat: YearPostingRow[] = rows
    .filter(r => r.journal_entries?.status === 'posted' && r.journal_entries?.book === ACTUAL_BOOK)
    .map(r => ({
      account_id: r.account_id,
      amount: r.amount,
      lp_entity_id: r.lp_entity_id ?? null,
      entry_date: r.journal_entries.entry_date,
      source_type: r.journal_entries.source_type ?? null,
    }))

  const inYear = (r: YearPostingRow) => r.entry_date >= yearStart && r.entry_date <= yearEnd
  const onCode = (r: YearPostingRow, code: string) => codeById.get(r.account_id) === code
  const total = (rs: YearPostingRow[]) => roundCents(rs.reduce((s, r) => s + Number(r.amount), 0))

  // 4200 is an income account, so its postings are credits — negative under this ledger's
  // convention. Appreciation of 2.5m arrives as -2,500,000, and the difference book recognised is
  // the positive of that.
  //
  // By SUBTYPE, not code: 4200 is the unrealized account on a fund's chart but management-fee
  // income on a GP entity's and interest income on a management company's, and reversing either
  // as "unrealized appreciation" would take real income out of the tax book.
  const unrealizedIncomeIds = new Set(((accts as any[]) ?? []).filter(a => a.type === 'income' && a.subtype === 'unrealized').map(a => a.id as string))
  const unrealizedChange = roundCents(-total(flat.filter(r => inYear(r) && unrealizedIncomeIds.has(r.account_id))))
  // Currency translation, the same way (4300 income / 1250 assets, by subtype).
  const chartRows = (accts as any[]) ?? []
  const fxIncomeIds = new Set(chartRows.filter(a => a.type === 'income' && a.subtype === 'fx_translation').map(a => a.id as string))
  const fxChange = roundCents(-total(flat.filter(r => inYear(r) && fxIncomeIds.has(r.account_id))))
  // The year's movement on each asset account (per company), so each is reversed by its own amount.
  const movesOn = (ids: Set<string>) => {
    const m = new Map<string, number>()
    for (const r of flat) if (inYear(r) && ids.has(r.account_id)) m.set(r.account_id, roundCents((m.get(r.account_id) ?? 0) + Number(r.amount)))
    return m
  }
  const assetMoves = {
    unrealized: movesOn(new Set(chartRows.filter(a => a.type === 'asset' && a.subtype === 'unrealized').map(a => a.id as string))),
    fx: movesOn(new Set(chartRows.filter(a => a.type === 'asset' && a.subtype === 'fx_translation').map(a => a.id as string))),
  }

  // Partners' capital, assembled the way the close's loader assembles it, from the rows already
  // read: only partner capital accounts count (a receivable or a payable carries a partner id too,
  // and is not capital).
  const postedRows = ((rows as any[]) ?? []).filter(r => r.journal_entries?.status === 'posted' && r.journal_entries?.entry_date <= yearEnd)
  const entryRows = Array.from(new Map(postedRows.map(r => [r.journal_entry_id, {
    id: r.journal_entry_id, source_type: r.journal_entries.source_type ?? null, entry_date: r.journal_entries.entry_date, memo: null,
  }])).values())
  const { capitalPostings } = assembleLoadedLedger(fundId, { acctRows: (accts as any[]) ?? [], entryRows, postingRows: postedRows })
  const capitalInYear = capitalPostings.filter(p => (p.entryDate ?? '') >= yearStart && (p.entryDate ?? '') <= yearEnd)

  // Each partner's share of the year's mark, as the close allocated it (a gain is a credit).
  const perLpUnrealized = new Map<string, number>()
  const perLpFx = new Map<string, number>()
  for (const p of capitalInYear) {
    const into = p.sourceType === 'valuation' || p.sourceType === 'unrealized' ? perLpUnrealized
      : p.sourceType === 'fx_revaluation' ? perLpFx : null
    if (into) into.set(p.lpEntityId, roundCents((into.get(p.lpEntityId) ?? 0) + p.amount))
  }

  // The part of the year's carry earned on unrealized appreciation, per partner (positive debits a
  // partner). Carry on what was realized stays in the tax book; only this is reversed — the
  // negation, taken in postTaxAdjustments. Read only when the close booked carry this year.
  // Without carry terms on file there is nothing to measure the split against, so what was posted
  // is reversed whole, as before.
  const bookedCarry = new Map<string, number>()
  for (const p of capitalInYear) {
    if (p.sourceType !== 'carried_interest' && p.sourceType !== 'carry') continue
    bookedCarry.set(p.lpEntityId, roundCents((bookedCarry.get(p.lpEntityId) ?? 0) + p.amount))
  }
  const terms = bookedCarry.size > 0 ? await loadCarryTerms(admin, fundId, group) : null
  const perLpCarry = !terms ? new Map<string, number>()
    : terms.kind === 'none' || terms.recipients.length === 0 ? bookedCarry
    : carryOnUnrealizedForYear(capitalPostings, terms, `${taxYear - 1}-12-31`, yearEnd)
  const carryAccruedOnUnrealized = roundCents(
    Array.from(perLpCarry.values()).filter(v => v > 0).reduce((s, v) => s + v, 0),
  )

  const organizationalExpense = total(flat.filter(r => inYear(r) && onCode(r, CODES.organizationalExpense)))
  const organizationalCostsToDate = total(flat.filter(r => onCode(r, CODES.organizationalExpense)))
  const syndicationExpense = total(flat.filter(r => inYear(r) && onCode(r, CODES.syndicationExpense)))

  // "Begins business" drives the §709 clock. Derived from the earliest posted entry unless the
  // caller knows better — a fund's real commencement date is a fact about the fund, and the
  // ledger's first entry is the best available proxy, not a substitute for being told.
  const dates = flat.map(r => r.entry_date).filter(Boolean).sort()
  const inception = opts?.inceptionDate ?? dates[0] ?? yearStart
  const org = orgClockFor(inception, taxYear)

  return {
    year: {
      unrealizedChange,
      fxChange,
      carryAccruedOnUnrealized,
      organizationalExpense,
      organizationalCostsToDate,
      syndicationExpense,
      org,
    },
    perLpCarry,
    perLpUnrealized,
    perLpFx,
    assetMoves,
  }
}

/**
 * How many months of the §709 clock fall in this tax year, and how many already ran.
 *
 * Amortization starts in the month the fund begins business, so the first year is short by
 * however many months preceded it. Exported for the tests, which is where the off-by-one lives.
 */
export function orgClockFor(
  inceptionDate: string,
  taxYear: number,
): { monthsInYear: number; monthsAlreadyAmortized: number; isFirstYear: boolean } {
  const startYear = Number(inceptionDate.slice(0, 4))
  const startMonth = Number(inceptionDate.slice(5, 7)) // 1-12
  if (!Number.isFinite(startYear) || !Number.isFinite(startMonth) || taxYear < startYear) {
    return { monthsInYear: 0, monthsAlreadyAmortized: 0, isFirstYear: false }
  }
  const isFirstYear = taxYear === startYear
  const monthsInYear = isFirstYear ? 13 - startMonth : 12
  const monthsAlreadyAmortized = isFirstYear
    ? 0
    : (13 - startMonth) + (taxYear - startYear - 1) * 12
  return { monthsInYear, monthsAlreadyAmortized, isFirstYear }
}

export interface TaxRunResult {
  taxYear: number
  proposals: ProposedAdjustment[]
  /** Entry ids written to the tax book. Empty on a preview. */
  entryIds: string[]
  /** Differences that could not be posted, each with a reason. */
  skipped: UnbuildableAdjustment[]
  /** Entries from a previous run of this year that were voided first. */
  voided: number
  /** Accounts the vehicle's chart is missing — the run refuses rather than posting a partial set. */
  missingAccounts: string[]
}

/**
 * Derive a year's book-to-tax adjustments and post them to the tax book.
 *
 * `preview` computes and returns without writing, which is what a review screen shows before a
 * person accepts. The proposals are identical either way — the same function produces both, so a
 * preview cannot disagree with what posting does.
 */
export async function postTaxAdjustments(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  taxYear: number,
  opts?: { preview?: boolean; inceptionDate?: string; entryDate?: string },
): Promise<TaxRunResult | { error: string }> {
  const loaded = await loadActualBookYear(admin, fundId, group, taxYear, opts)
  if ('error' in loaded) return loaded
  const { year, perLpCarry, perLpUnrealized, perLpFx, assetMoves } = loaded

  const proposals = proposeAdjustments(year)
  const codes = await accountIdByCode(admin, fundId, group)
  // The unrealized pair by subtype (see loadActualBookYear); the code is only the fallback name.
  const unrealizedPair = await subtypeAccounts(admin, fundId, group, 'unrealized')
  const fxPair = await subtypeAccounts(admin, fundId, group, 'fx_translation')
  if (unrealizedPair.assetId) codes.set(CODES.unrealizedAsset, unrealizedPair.assetId)
  if (unrealizedPair.incomeId) codes.set(CODES.unrealizedIncome, unrealizedPair.incomeId)
  else codes.delete(CODES.unrealizedIncome)

  // Only the accounts the proposed adjustments actually post to.
  const needed = new Set<string>()
  for (const p of proposals) {
    if (p.kind === 'unrealized') { needed.add(CODES.unrealizedAsset); needed.add(CODES.unrealizedIncome) }
    if (p.kind === 'fx_translation' && (!fxPair.assetId || !fxPair.incomeId)) needed.add('1250 / 4300')
    if (p.kind === 'organizational_709') { needed.add(CODES.organizationalExpense); needed.add(CODES.deferredOrgCosts) }
    if (p.kind === 'syndication') { needed.add(CODES.syndicationExpense); needed.add(CODES.capitalizedSyndication) }
  }
  const missingAccounts = Array.from(needed).filter(c => !codes.get(c))
  // Refuse rather than post what can be posted: a partial adjustment set reads as a complete one,
  // and the missing piece is invisible on the resulting statements. The fix is adding the account
  // under the entity's Admin → Chart of accounts, which is worth saying rather than making someone infer it.
  if (missingAccounts.length > 0 && proposals.length > 0) {
    return {
      taxYear,
      proposals,
      entryIds: [],
      skipped: [],
      voided: 0,
      missingAccounts,
    }
  }

  const accounts: TaxAdjustmentAccounts = {
    unrealizedAssetId: codes.get(CODES.unrealizedAsset)!,
    unrealizedIncomeId: codes.get(CODES.unrealizedIncome)!,
    organizationalExpenseId: codes.get(CODES.organizationalExpense)!,
    deferredOrgCostsId: codes.get(CODES.deferredOrgCosts)!,
    syndicationExpenseId: codes.get(CODES.syndicationExpense)!,
    capitalizedSyndicationId: codes.get(CODES.capitalizedSyndication)!,
  }

  // The reversal is the negation of what the close posted, partner by partner.
  const perLpReversal = new Map(Array.from(perLpCarry.entries()).map(([id, amt]) => [id, roundCents(-amt)]))
  const partnerIds = Array.from(new Set([...perLpReversal.keys(), ...perLpUnrealized.keys(), ...perLpFx.keys()]))
  const capMap =
    partnerIds.length > 0
      ? await ensureCapitalAccounts(admin, fundId, group, partnerIds)
      : new Map<string, string>()

  const entryDate = opts?.entryDate ?? `${taxYear}-12-31`
  const built = buildTaxAdjustmentEntries({
    base: { fundId, entryDate },
    proposals,
    accounts,
    carry: perLpReversal.size > 0 ? { perLpReversal, capMap } : undefined,
    unrealized: { allocated: perLpUnrealized, capMap, assetMoves: assetMoves.unrealized },
    fx: fxPair.assetId && fxPair.incomeId
      ? { fxIncomeId: fxPair.incomeId, fxAssetId: fxPair.assetId, allocated: perLpFx, capMap, assetMoves: assetMoves.fx }
      : undefined,
  })

  if (opts?.preview) {
    return { taxYear, proposals, entryIds: [], skipped: built.skipped, voided: 0, missingAccounts: [] }
  }

  const voided = await voidPriorTaxRun(admin, fundId, group, taxYear)

  const sourceRef = taxSourceRef(taxYear)
  const entryIds: string[] = []
  for (const entry of built.entries) {
    const result = await persistEntry(
      admin,
      fundId,
      group,
      userId,
      { ...entry, sourceRef },
      'posted',
      'tax',
    )
    if ('error' in result) return { error: result.error }
    entryIds.push(result.entryId)
  }

  return { taxYear, proposals, entryIds, skipped: built.skipped, voided, missingAccounts: [] }
}

/** The vehicle's asset and income accounts of one subtype (the parent, lowest code, of each). */
async function subtypeAccounts(admin: SupabaseClient, fundId: string, group: string, subtype: string): Promise<{ assetId: string | null; incomeId: string | null }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { assetId: null, incomeId: null }
  const { data } = await admin.from('chart_of_accounts' as any).select('id, code, type, subtype').eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('subtype', subtype)
  const rows = ((data as any[]) ?? []).sort((a, b) => String(a.code).localeCompare(String(b.code)))
  return {
    assetId: rows.find(r => r.type === 'asset')?.id ?? null,
    incomeId: rows.find(r => r.type === 'income')?.id ?? null,
  }
}

/**
 * Void this year's previously-generated tax entries.
 *
 * Voided, not deleted — the same posture the period close takes when it reopens. Scoped by
 * `source_ref`, so a hand-authored correction in the tax book survives a re-run untouched. That
 * asymmetry is the point: this run owns what it wrote, and nothing else.
 */
export async function voidPriorTaxRun(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  taxYear: number,
): Promise<number> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return 0
  const { data } = await admin
    .from('journal_entries' as any)
    .select('id')
    .eq('book', 'tax')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .eq('source_ref', taxSourceRef(taxYear))
    .eq('status', 'posted')
  const ids = ((data as any[]) ?? []).map(r => r.id as string)
  if (ids.length === 0) return 0
  await admin.from('journal_entries' as any).update({ status: 'void' }).in('id', ids)
  return ids.length
}
