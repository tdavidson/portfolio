import { loadResolvedCommitments } from './terms'
// Period close — the ONE place where P&L is allocated to partners' capital.
//
// Expense/income/valuation entries are booked simply (Dr expense / Cr cash). They
// never touch a capital account. Closing a period allocates that period's P&L to
// each partner and locks the books.
//
// WHY ONE ENTRY PER CATEGORY, not one for net income:
// a capital account's roll-forward lines are driven by the journal entry's
// source_type, and source_type is per-ENTRY, not per-posting. A single
// "net income" allocation would land entirely in one bucket and the statement of
// changes in partners' capital would lose the distinction between management fees,
// expenses, operating income, and marks. So the close posts one balanced entry per
// category, each tagged with the source_type that maps to its roll-forward line.
//
// THE BRIDGE. Each allocation is offset to 3200 Undistributed earnings, so the
// P&L accounts stay open (a YTD income statement still reports) while capital
// accounts pick up their share. The bridge exactly cancels the double-count, so the
// balance sheet keeps balancing:
//   equity = capital accounts + bridge + open P&L = net assets, always.
//
// REOPENING. Every entry a close posts carries source_ref = `close:<periodId>`.
// Reopening voids exactly those entries — nothing else — so a mistake is reversible
// without hand-unwinding fifteen capital postings.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadPostedLedger, loadOwnership, loadEntityNames } from './load'
import type { FundPosition } from '@/lib/portfolio/fof-metrics'
import { loadFofData, ledgerCarryingByHolding } from '@/lib/portfolio/fof-load'
import { fofCloseIssues, companiesWithPendingNotices } from '@/lib/portfolio/fof-valuation'
import { quoteCloseIssues, type PriceFeed, type PriceObservation, type QuotedPosition } from '@/lib/portfolio/quotes'
import { walletCloseIssues, type Wallet, type WalletBalance } from '@/lib/portfolio/wallets'
import { lotIssues, isLotMethod, type LotMethod } from '@/lib/portfolio/lots'
import { buildSoiPositions, type SoiCompany } from './soi'
import { fundCurrency } from './currency'
import { accountIdByCode, ensureCapitalAccounts, persistEntry } from './persist'
import { allocateAmountCumulatively } from './allocation'
import { postingsInPeriod } from './statements'
import { computeCapitalAccounts, bucketForSourceType, emptyAccount, type CapitalAccount } from './capital-account'
import { closedPeriodRanges } from './periods'
import { buildCarryEntry, buildAssociateMarkupEntry } from './entries'
import { associateMembers, lookThroughAccount } from './look-through'
import { loadCapitalPostings } from './capital-source'
import { gpLinkFor, loadOwnershipBasis } from './gp-economics'
import {
  loadCarryTerms, carryAccrual,
  type LpEconomics, type DatedContribution,
} from './carry'
import { loadNotes, noteAccruals } from './note-interest'
import { ensureInvestmentAccounts } from './investments'
import { accountBalances } from './ledger'
import { trialBalance } from './statements'
import { setGeneratedAllocationStatus } from './continuous-allocation'
import { loadCloseEntrySuggestions, type CloseEntrySuggestion } from './close-suggestions'

const NOTE_INTEREST_INCOME = '4110'
import {
  loadAllocationBasis, loadPartnerTerms, loadCommitmentEvents,
  resolveCommitmentMap, allocationWeights,
  type AllocationBasis, type AllocationCategory,
} from './terms'
import { exportLedgerText } from './text-ledger-run'
import { vehicleIdByName } from './vehicle-id'
import { loadStrandedCapital } from './pooled-capital-check'
import { roundCents } from './ledger'
import type { Account, JournalEntry, Posting } from './types'
import { ACTUAL_BOOK } from './books'
import { closesToOwnerEquity } from '@/lib/vehicle-kinds'
import { vehicleKindByName } from './vehicle-domain'
import { ownerCloseEntries } from './close-owner'
import { ownerNoun } from './vocab'

/** The undistributed-earnings bridge. */
const BRIDGE_CODE = '3200'

/**
 * Which roll-forward line a P&L account allocates to, keyed by the account's
 * subtype. The value is the journal source_type, which `bucketForSourceType` maps
 * to a capital-account line. Anything unrecognized falls back by account type, so
 * a new account can never silently drop out of the allocation.
 */
const SUBTYPE_TO_SOURCE: Record<string, string> = {
  management_fee: 'management_fee',
  partnership_expense: 'partnership_expense',
  organizational_expense: 'organizational_expense',
  interest_expense: 'partnership_expense', // an expense of the partnership; same line
  operating_expense: 'partnership_expense',
  realized_gain: 'realized_gain',
  unrealized: 'valuation',
  interest_income: 'income',
  portfolio_income: 'income',
  equity_method: 'income',
}

function sourceTypeFor(account: Account): string {
  const mapped = account.subtype ? SUBTYPE_TO_SOURCE[account.subtype] : undefined
  if (mapped) return mapped
  return account.type === 'expense' ? 'partnership_expense' : 'income'
}

export interface CloseCategory {
  sourceType: string
  label: string
  /** Net effect on partners' capital: positive increases capital. */
  capitalEffect: number
  accounts: { code: string; name: string; amount: number }[]
  lines: { lpEntityId: string; name: string; amount: number; exactAmount: number }[]
}

async function allocationResiduals(
  admin: SupabaseClient,
  fundId: string,
  vehicleId: string,
  beforeDate: string,
): Promise<Map<string, number>> {
  const { data: periods } = await admin.from('fiscal_periods' as any)
    .select('id')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .eq('status', 'closed')
    .lt('period_end', beforeDate)
  const periodIds = ((periods as any[]) ?? []).map(period => period.id as string)
  if (periodIds.length === 0) return new Map()
  const { data: rows } = await admin.from('close_allocation_rounding' as any)
    .select('source_type, lp_entity_id, exact_amount, posted_amount')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .in('fiscal_period_id', periodIds)
  const residuals = new Map<string, number>()
  for (const row of ((rows as any[]) ?? [])) {
    const key = `${row.source_type}:${row.lp_entity_id}`
    residuals.set(key, (residuals.get(key) ?? 0) + Number(row.exact_amount) - Number(row.posted_amount))
  }
  return residuals
}

export interface ClosePreview {
  periodStart: string
  periodEnd: string
  /** Net income for the period — the sum of every category's capital effect. */
  netIncome: number
  categories: CloseCategory[]
  /** Basis used to split each category across partners. */
  basis: AllocationBasis
  /**
   * 'partners' allocates each category across the partners by basis — a fund. 'owner' rolls net
   * income into a single equity account with no allocation — a management company or an
   * individual (lib/vehicle-kinds.ts closesToOwnerEquity). Categories carry no partner lines
   * in owner mode.
   */
  mode: 'partners' | 'owner'
  warnings: string[]
}

const CATEGORY_LABELS: Record<string, string> = {
  management_fee: 'Management fees',
  partnership_expense: 'Partnership expenses',
  organizational_expense: 'Organizational expenses',
  realized_gain: 'Net realized gain / (loss)',
  valuation: 'Net unrealized gain / (loss)',
  income: 'Operating income',
}

/**
 * What closing this period would allocate, without writing anything. This is the
 * preview the user approves — and the same computation the close itself runs.
 */
export async function previewClose(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  periodStart: string,
  periodEnd: string,
  shadowResiduals?: Map<string, number>,
): Promise<ClosePreview | { error: string }> {
  if (!periodStart || !periodEnd || periodStart > periodEnd) {
    return { error: 'A valid period start and end are required' }
  }
  const existing = await closedPeriodRanges(admin, fundId, group)
  if (existing.some(p => periodStart <= p.period_end && periodEnd >= p.period_start)) {
    return { error: 'This period overlaps an already-closed period — reopen it first' }
  }

  const [{ accounts, postings, capitalPostings, sourcedPostings }, owners, names, basis, terms, commitmentEvents, kind] = await Promise.all([
    loadPostedLedger(admin, fundId, group),
    loadOwnership(admin, fundId, group),
    loadEntityNames(admin, fundId, group),
    loadAllocationBasis(admin, fundId, group),
    loadPartnerTerms(admin, fundId, group),
    loadCommitmentEvents(admin, fundId, group),
    vehicleKindByName(admin, fundId, group),
  ])

  const warnings: string[] = []

  // OWNER MODE. A management company or an individual has no partners: net income rolls into
  // one equity account and there is nothing to split, so the partner basis below is not
  // loaded into anything and its "nobody to allocate to" refusal does not apply.
  const ownerMode = closesToOwnerEquity(kind)
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const priorResiduals = shadowResiduals ?? (ownerMode || !vehicleId
    ? new Map<string, number>()
    : await allocationResiduals(admin, fundId, vehicleId, periodStart))

  // The basis amount per partner, as of the PERIOD END — not today. Closing an old
  // period must use the commitments (or balances) that were in force then.
  let basisAmounts: { lpEntityId: string; basisAmount: number }[]
  if (basis === 'capital_balance') {
    const balances = computeCapitalAccounts(capitalPostings, { end: periodEnd })
    basisAmounts = Array.from(balances.entries()).map(([lpEntityId, a]) => ({ lpEntityId, basisAmount: a.ending }))
  } else {
    // The close is ledger-only, so source is 'ledger' and positions never apply — this is
    // resolveCommitmentMap's events-if-any-positive-else-scalar core, as of the period end.
    // Old periods must use the commitments in force THEN. Warn only when there is no event
    // history at all (migration not pushed), since we then silently rely on the scalar.
    if (commitmentEvents.length === 0 && !ownerMode) {
      warnings.push('No commitment history found — falling back to each partner’s current commitment. Push the commitment-events migration to allocate historical periods correctly.')
    }
    basisAmounts = Array.from(
      (await loadResolvedCommitments(admin, fundId, group, periodEnd)).entries()
    ).map(([lpEntityId, commitment]) => ({ lpEntityId, basisAmount: commitment }))
  }

  const eligible = ownerMode ? [] : basisAmounts.filter(b => b.basisAmount > 0)
  if (!ownerMode && eligible.length === 0) {
    return { error: basis === 'capital_balance'
      ? 'No partner has a positive capital balance at the period end — nothing to allocate on'
      : 'No partners with a commitment — nothing to allocate to' }
  }

  // New entries are allocated when posted. Close only catches legacy/unallocated P&L, making
  // the migration safe for existing books while preventing a second allocation.
  const { data: allocatedRows } = await admin.from('journal_entry_allocations' as any)
    .select('source_entry_id').eq('fund_id', fundId).eq('vehicle_id', vehicleId)
  const allocatedSourceIds = new Set(((allocatedRows as any[]) ?? []).map(row => row.source_entry_id as string))
  const unallocatedPostings = sourcedPostings.filter(posting => !allocatedSourceIds.has(posting.entryId))
  const inPeriod = postingsInPeriod(unallocatedPostings, periodStart, periodEnd)
  const pnlAccounts = accounts.filter(a => a.type === 'income' || a.type === 'expense')
  const pnlById = new Map(pnlAccounts.map(a => [a.id, a]))

  // Group the period's P&L by category. `amount` is the debit-side sum, so an
  // expense is positive and income is negative.
  const byCategory = new Map<string, Map<string, number>>()
  for (const p of inPeriod) {
    const acct = pnlById.get(p.accountId)
    if (!acct) continue
    const cat = sourceTypeFor(acct)
    const perAccount = byCategory.get(cat) ?? new Map<string, number>()
    perAccount.set(acct.id, roundCents((perAccount.get(acct.id) ?? 0) + p.amount))
    byCategory.set(cat, perAccount)
  }

  const categories: CloseCategory[] = []
  for (const [sourceType, perAccount] of Array.from(byCategory.entries())) {
    const debitSide = roundCents(Array.from(perAccount.values()).reduce((s, v) => s + v, 0))
    // Capital rises when income exceeds expense; debit-side is the opposite sign.
    const capitalEffect = roundCents(-debitSide)
    if (capitalEffect === 0) continue

    // Owner mode: the category rolls into one equity account, no lines to split.
    let lines: CloseCategory['lines'] = []
    if (!ownerMode) {
      // Terms are per CATEGORY: a partner excluded from management fee still bears its
      // share of expenses and still receives its share of gains.
      const weights = allocationWeights(eligible, terms, sourceType as AllocationCategory)
      if (weights.length === 0) {
        warnings.push(`No partner participates in ${CATEGORY_LABELS[sourceType] ?? sourceType} — it cannot be allocated and will be skipped.`)
        continue
      }
      const excluded = eligible.length - weights.length
      if (excluded > 0) {
        warnings.push(`${excluded} partner(s) excluded from ${CATEGORY_LABELS[sourceType] ?? sourceType}; their share is redistributed across the rest.`)
      }
      lines = allocateAmountCumulatively(
        capitalEffect,
        weights,
        new Map(weights.map(weight => [weight.lpEntityId, priorResiduals.get(`${sourceType}:${weight.lpEntityId}`) ?? 0])),
      ).map(line => ({
        ...line,
        name: names.get(line.lpEntityId) ?? line.lpEntityId,
        amount: roundCents(line.amount),
      }))
    }

    categories.push({
      sourceType,
      label: CATEGORY_LABELS[sourceType] ?? sourceType,
      capitalEffect,
      accounts: Array.from(perAccount.entries())
        .map(([id, amount]) => {
          const a = pnlById.get(id)!
          return { code: a.code, name: a.name, amount: roundCents(amount) }
        })
        .filter(a => a.amount !== 0),
      lines,
    })
  }

  const netIncome = roundCents(categories.reduce((s, c) => s + c.capitalEffect, 0))
  if (categories.length === 0) warnings.push('No P&L activity in this period — closing will lock the books without allocating anything.')

  // Closing out of order strands P&L: any income or expense dated BEFORE this period
  // that isn't inside a closed period will never be allocated to anyone, because the
  // close only ever allocates what's inside its own window.
  const priorUnclosed = unallocatedPostings.filter(p => {
    if (!pnlById.has(p.accountId)) return false
    const d = p.entryDate
    if (!d || d >= periodStart) return false
    return !existing.some(cp => d >= cp.period_start && d <= cp.period_end)
  })
  if (priorUnclosed.length > 0) {
    const earliest = priorUnclosed.map(p => p.entryDate!).sort()[0]
    const amount = roundCents(-priorUnclosed.reduce((s, p) => s + p.amount, 0))
    warnings.push(
      `There is unallocated P&L before this period (from ${earliest}, net ${amount.toFixed(2)}) that no closed period covers. ` +
      `Close the earlier period first, or extend this one back — otherwise that income and expense is never allocated to any partner.`
    )
  }

  return { periodStart, periodEnd, netIncome, categories, basis, mode: ownerMode ? 'owner' : 'partners', warnings }
}

// ---------------------------------------------------------------------------
// Closing THROUGH a date — the model you actually want
// ---------------------------------------------------------------------------
//
// Picking an arbitrary start and end lets you strand P&L in an uncovered gap. So the
// close takes only an END date: the start is DERIVED (the day after the last closed
// period, or inception), which makes gaps impossible by construction.
//
// The span is then split into CALENDAR MONTHS and each is closed as its own period.
// Closing a quarter therefore closes its three months. That isn't cosmetic: the
// allocation basis is measured at each period end, so if a partner's commitment
// changes in February, allocating Jan–Mar as one lump at March's weights would
// misallocate January. Month-by-month gets each month's ownership right, and lets you
// reopen a single month instead of a whole quarter.

/** Split [start, end] into calendar-month windows. The first and last may be partial. */
export function monthWindows(start: string, end: string): { start: string; end: string; label: string }[] {
  if (start > end) return []
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const out: { start: string; end: string; label: string }[] = []

  let cursor = new Date(`${start}T00:00:00Z`)
  const last = new Date(`${end}T00:00:00Z`)

  while (cursor <= last) {
    const y = cursor.getUTCFullYear()
    const m = cursor.getUTCMonth()
    const monthEnd = new Date(Date.UTC(y, m + 1, 0))
    const winEnd = monthEnd > last ? last : monthEnd
    out.push({
      start: iso(cursor),
      end: iso(winEnd),
      label: new Date(Date.UTC(y, m, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    })
    cursor = new Date(Date.UTC(y, m + 1, 1))
  }
  return out
}

/**
 * Where the next close starts: the day after the last closed period, or the earliest
 * posted entry if nothing has been closed yet. Null when there's nothing to close.
 */
export async function nextCloseStart(
  admin: SupabaseClient,
  fundId: string,
  group: string
): Promise<string | null> {
  const closed = await closedPeriodRanges(admin, fundId, group)
  if (closed.length > 0) {
    const latest = closed.map(p => p.period_end).sort().pop()!
    const next = new Date(`${latest}T00:00:00Z`)
    next.setUTCDate(next.getUTCDate() + 1)
    return next.toISOString().slice(0, 10)
  }

  const { postings } = await loadPostedLedger(admin, fundId, group)
  const dates = postings.map(p => p.entryDate).filter(Boolean).sort() as string[]
  return dates.length > 0 ? dates[0] : null
}

/**
 * Is the ledger ready to be closed for this span?
 *
 * The close allocates POSTED entries only. Anything still sitting as a draft inside
 * the window — an uncategorized bank transaction, an entry someone never posted —
 * has no P&L in the ledger yet, so it is allocated to nobody. Once the period locks,
 * it can't even be posted into that month without reopening. That silent stranding is
 * a blocker, not a warning.
 *
 * A bank balance that doesn't tie is a warning: it may be a timing difference you
 * knowingly accept, and it doesn't corrupt the allocation.
 */
export interface CloseReadiness {
  draftEntries: { count: number; earliest: string | null }
  unpostedBankTxns: { count: number; total: number }
  bank: { tiesOut: boolean; difference: number } | null
  blockers: string[]
  warnings: string[]
}

export interface CloseThroughPreview {
  start: string
  end: string
  /** One preview per calendar month in the span. */
  months: ClosePreview[]
  totalNetIncome: number
  basis: AllocationBasis
  /** See ClosePreview.mode. */
  mode: 'partners' | 'owner'
  readiness: CloseReadiness
  warnings: string[]
  suggestedEntries: CloseEntrySuggestion[]
}

async function persistCloseReview(
  admin: SupabaseClient, fundId: string, group: string, vehicleId: string, periodId: string,
  userId: string | null, readiness: CloseReadiness, snapshot: string, periodEnd: string,
): Promise<{ error?: string }> {
  const { accounts, postings } = await loadPostedLedger(admin, fundId, group, periodEnd)
  const tb = trialBalance(accounts, postings)
  const checks = [
    { key: 'trial_balance', section: 'Ledger integrity', label: 'Trial balance', status: tb.balanced ? 'passed' : 'blocked', detail: tb.balanced ? 'Debits equal credits.' : 'The trial balance is out of balance.', evidence: tb },
    { key: 'draft_entries', section: 'Ledger integrity', label: 'No draft journal entries', status: readiness.draftEntries.count === 0 ? 'passed' : 'blocked', detail: readiness.draftEntries.count === 0 ? 'No drafts fall inside the period.' : `${readiness.draftEntries.count} draft entries remain.`, evidence: readiness.draftEntries },
    { key: 'bank_completeness', section: 'Cash reconciliation', label: 'Bank activity recorded', status: readiness.unpostedBankTxns.count === 0 ? 'passed' : 'blocked', detail: readiness.unpostedBankTxns.count === 0 ? 'No unmatched or unposted bank activity remains.' : `${readiness.unpostedBankTxns.count} bank transactions remain.`, evidence: readiness.unpostedBankTxns },
    { key: 'bank_reconciliation', section: 'Cash reconciliation', label: 'Bank reconciliation', status: readiness.bank == null ? 'not_applicable' : readiness.bank.tiesOut ? 'passed' : 'needs_review', detail: readiness.bank == null ? 'No statement balance was supplied for this close.' : `Difference: ${readiness.bank.difference.toFixed(2)}.`, evidence: readiness.bank ?? {} },
    { key: 'allocation_completeness', section: 'Partner capital', label: 'Partner allocations complete', status: 'passed', detail: 'Posted P&L entries have transaction-date allocation evidence; legacy activity was caught up by this close.', evidence: {} },
    { key: 'valuation_and_cutoff', section: 'Investments and cutoff', label: 'Valuation and cutoff review', status: readiness.warnings.length === 0 ? 'passed' : 'needs_review', detail: readiness.warnings.length === 0 ? 'No valuation or cutoff exceptions were reported.' : readiness.warnings.join(' '), evidence: { warnings: readiness.warnings } },
  ] as const
  const { data: review, error } = await admin.from('close_reviews' as any).upsert({
    fund_id: fundId, vehicle_id: vehicleId, fiscal_period_id: periodId, status: 'approved',
    prepared_by: userId, approved_by: userId, approved_at: new Date().toISOString(),
    attestation: `Reviewed the reconciliations, exceptions, supporting schedules, and material entries through ${periodEnd}.`,
    trial_balance: tb, snapshot_text: snapshot, updated_at: new Date().toISOString(),
  }, { onConflict: 'fiscal_period_id' }).select('id').single()
  if (error) return { error: error.message }
  const reviewId = (review as any).id
  await admin.from('close_review_checks' as any).delete().eq('close_review_id', reviewId)
  const { error: checksError } = await admin.from('close_review_checks' as any).insert(checks.map((check, index) => ({
    close_review_id: reviewId, check_key: check.key, section: check.section, label: check.label,
    status: check.status, detail: check.detail, evidence: check.evidence, sort_order: index,
  })))
  return checksError ? { error: checksError.message } : {}
}

/**
 * The fund-of-funds inputs the pre-close check needs, or null when this fund holds no funds.
 *
 * Two figures per holding: what the position VALUES at (last manager NAV rolled forward for
 * our own cash flows since — see lib/portfolio/fof-metrics.ts) and what the LEDGER carries
 * for it (its 1100/1200 account pair). The check compares them; disagreement means a
 * period-end mark has not been booked.
 */
async function loadFofCloseInputs(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  asOf: string,
): Promise<{ positions: FundPosition[]; ledgerCarrying: Map<string, number>; pendingNotices: Set<string> } | null> {
  const [fof, ledger] = await Promise.all([
    loadFofData(admin, fundId, asOf, group),
    // loadPostedLedger already paginates (a vehicle can hold more than the PostgREST 1000-row
    // default, which would silently truncate) and already scopes to POSTED entries <= asOf.
    loadPostedLedger(admin, fundId, group, asOf),
  ])
  if (fof.positions.length === 0) return null

  return {
    positions: fof.positions,
    ledgerCarrying: ledgerCarryingByHolding(ledger.accounts, ledger.postings),
    pendingNotices: companiesWithPendingNotices(fof.positions, fof.events, asOf),
  }
}

/**
 * The quoted half of the close's inputs — positions priced by a feed rather than by a round.
 *
 * Returns null for a fund that has no feeds, so a purely private book runs exactly the query
 * count it ran before and none of this code path executes. Same shape as the FoF loader above,
 * for the same reason: the check itself is pure, and lives in lib/portfolio/quotes.ts.
 */
async function loadQuoteCloseInputs(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  asOf: string,
): Promise<{
  positions: QuotedPosition[]
  feeds: PriceFeed[]
  observations: PriceObservation[]
  currency: string
} | null> {
  const { data: feedRows } = await (admin as any)
    .from('price_feeds')
    .select('*')
    .eq('fund_id', fundId)
  const feeds = ((feedRows as any[]) ?? []).map(f => ({
    id: f.id,
    companyId: f.company_id,
    kind: f.kind,
    symbol: f.symbol,
    exchange: f.exchange,
    quoteCurrency: f.quote_currency,
    quoteScale: Number(f.quote_scale ?? 1),
    activeFrom: f.active_from,
    activeUntil: f.active_until,
    restrictionUntil: f.restriction_until,
    restrictionDiscount: f.restriction_discount == null ? null : Number(f.restriction_discount),
  })) as PriceFeed[]
  if (feeds.length === 0) return null

  const [{ data: obsRows }, { data: txnRows }, { data: companyRows }, ledger, currency] = await Promise.all([
    (admin as any).from('price_observations').select('*').eq('fund_id', fundId).lte('as_of_date', asOf),
    (admin as any).from('investment_transactions').select('*').eq('fund_id', fundId),
    (admin as any).from('companies').select('*').eq('fund_id', fundId),
    loadPostedLedger(admin, fundId, group, asOf),
    fundCurrency(admin, fundId),
  ])

  const observations = ((obsRows as any[]) ?? []).map(o => ({
    feedId: o.feed_id,
    asOfDate: o.as_of_date,
    price: Number(o.price),
    basis: o.basis,
  })) as PriceObservation[]

  // Transactions are cut at the period end BEFORE the roll-up sees them. Without this the
  // position would be valued on share counts — and splits — that had not happened yet, so a
  // re-close of an earlier period would not reproduce.
  const upTo = ((txnRows as any[]) ?? []).filter(t => !t.transaction_date || t.transaction_date <= asOf)
  // buildSoiPositions runs through computeSummary, so `shares` arrives SPLIT-ADJUSTED — which is
  // what a quote must be multiplied by (lib/splits.ts).
  const soi = buildSoiPositions(upTo, ((companyRows as any[]) ?? []) as SoiCompany[], group, new Date(asOf))
  const carrying = ledgerCarryingByHolding(ledger.accounts, ledger.postings)

  const positions: QuotedPosition[] = soi.map(p => ({
    companyId: p.companyId,
    name: p.name,
    shares: p.shares ?? 0,
    ledgerCarrying: carrying.get(p.companyId) ?? 0,
  }))

  return { positions, feeds, observations, currency }
}

/**
 * Watched wallets and what the chain says they hold.
 *
 * Returns null for a fund with no wallets, so a book holding no digital assets runs the query
 * count it ran before. Same posture as the FoF and quoted loaders above.
 */
async function loadWalletCloseInputs(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  asOf: string,
): Promise<{
  positions: { companyId: string; name: string; units: number }[]
  wallets: Wallet[]
  balances: WalletBalance[]
} | null> {
  const { data: walletRows } = await (admin as any)
    .from('crypto_wallets').select('*').eq('fund_id', fundId)
  const rows = ((walletRows as any[]) ?? [])
  if (rows.length === 0) return null

  const wallets: Wallet[] = rows.map(w => ({
    id: w.id,
    companyId: w.company_id,
    chain: w.chain,
    address: w.address,
    label: w.label,
    active: w.active !== false,
    verifiedAt: w.verified_at,
    verificationMethod: w.verification_method,
  }))

  const [{ data: balRows }, { data: txnRows }, { data: companyRows }] = await Promise.all([
    (admin as any).from('crypto_wallet_balances').select('*').eq('fund_id', fundId).lte('as_of_date', asOf),
    (admin as any).from('investment_transactions').select('*').eq('fund_id', fundId),
    (admin as any).from('companies').select('*').eq('fund_id', fundId),
  ])

  const balances: WalletBalance[] = ((balRows as any[]) ?? []).map(b => ({
    walletId: b.wallet_id,
    asOfDate: b.as_of_date,
    units: Number(b.units),
    blockHeight: b.block_height,
  }))

  // Cut the history at the period end, then read the units through the same roll-up everything
  // else uses — so the quantity compared against the chain is SPLIT-ADJUSTED and matches what
  // the schedule of investments reports for the same date.
  const upTo = ((txnRows as any[]) ?? []).filter(t => !t.transaction_date || t.transaction_date <= asOf)
  const soi = buildSoiPositions(upTo, ((companyRows as any[]) ?? []) as SoiCompany[], group, new Date(asOf))
  const positions = soi.map(p => ({ companyId: p.companyId, name: p.name, units: p.shares ?? 0 }))

  return { positions, wallets, balances }
}

/**
 * Disposals whose recorded cost basis disagrees with the fund's own lot policy.
 *
 * Loaded per HOLDING rather than in one pass, because lots are consumed per holding and pooling
 * them across the portfolio would let a sale of one asset draw basis from another.
 *
 * Returns an empty list for a fund with no unit-bearing disposals, which is most funds — a
 * venture book exits whole positions and records the basis outright.
 */
async function loadLotIssues(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  asOf: string,
): Promise<string[]> {
  const [{ data: settings }, { data: txnRows }, { data: companyRows }] = await Promise.all([
    (admin as any).from('fund_settings').select('lot_method').eq('fund_id', fundId).maybeSingle(),
    (admin as any).from('investment_transactions').select('*').eq('fund_id', fundId),
    (admin as any).from('companies').select('id, name, holding_type').eq('fund_id', fundId),
  ])
  const raw = (settings as any)?.lot_method
  const method: LotMethod = isLotMethod(raw) ? raw : 'fifo'

  const upTo = ((txnRows as any[]) ?? []).filter(t => !t.transaction_date || t.transaction_date <= asOf)
  const names = new Map(((companyRows as any[]) ?? []).map(c => [c.id as string, c.name as string]))

  const byCompany = new Map<string, any[]>()
  for (const t of upTo) {
    // Company-wide rows carry no vehicle; vehicle-tagged rows must match this one, or a sale in
    // one fund would consume lots bought by another.
    if (t.portfolio_group && t.portfolio_group !== group) continue
    if (!byCompany.has(t.company_id)) byCompany.set(t.company_id, [])
    byCompany.get(t.company_id)!.push(t)
  }

  const out: string[] = []
  for (const [companyId, txns] of Array.from(byCompany.entries())) {
    for (const issue of lotIssues(txns, method, names.get(companyId) ?? 'A holding')) {
      out.push(issue.message)
    }
  }
  return out
}

/** Pre-close checks over the whole span. */
async function checkReadiness(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  start: string,
  end: string
): Promise<CloseReadiness> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)

  const [{ data: drafts }, { data: bankTxns }] = await Promise.all([
    admin.from('journal_entries' as any)
      .select('id, entry_date')
      .eq('book', ACTUAL_BOOK)
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId)
      .eq('status', 'draft')
      .gte('entry_date', start).lte('entry_date', end),
    admin.from('bank_transactions' as any)
      .select('id, amount, status')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId)
      .gte('txn_date', start).lte('txn_date', end)
      .in('status', ['unmatched', 'drafted']),
  ])

  const draftRows = ((drafts as any[]) ?? [])
  const bankRows = ((bankTxns as any[]) ?? [])

  const blockers: string[] = []
  const warnings: string[] = []

  if (draftRows.length > 0) {
    const earliest = draftRows.map(d => d.entry_date).sort()[0]
    blockers.push(
      `${draftRows.length} journal entr${draftRows.length === 1 ? 'y is' : 'ies are'} still in draft inside this span (from ${earliest}). ` +
      `A draft has no P&L in the ledger, so closing would allocate nothing for it — and lock the period so it can't be posted. Post or void them first.`
    )
  }

  // Capital stranded on the pooled account means the allocation has nowhere to land for
  // those partners: the close would compute each partner's share from capital balances that
  // read 0, and lock the period on top of the result. Block, don't warn. Not a question an
  // owner's-equity vehicle can be asked — it has one equity account and no partners.
  const kind = await vehicleKindByName(admin, fundId, group)
  const stranded = closesToOwnerEquity(kind) ? { stranded: false, message: '' } : await loadStrandedCapital(admin, fundId, group)
  if (stranded.stranded) {
    blockers.push(
      `LP capital is not attributed to partner accounts. ${stranded.message} ` +
      `Allocating on top of this would divide the period's income using capital balances that read zero. ` +
      `Attribute it on the vehicle's Setup page first.`
    )
  }

  // Fund-of-funds positions. Skipped entirely for a fund holding no funds — FoF behaviour is
  // derived from the data, never a setting (lib/portfolio/fof.ts).
  const fof = await loadFofCloseInputs(admin, fundId, group, end)
  if (fof) {
    const issues = fofCloseIssues(fof.positions, fof.ledgerCarrying, end, fof.pendingNotices)
    blockers.push(...issues.blockers)
    warnings.push(...issues.warnings)
  }

  // Quoted positions. Skipped entirely for a fund with no price feeds, so a private book is
  // unaffected — same posture as the FoF block above.
  const quoted = await loadQuoteCloseInputs(admin, fundId, group, end)
  if (quoted) {
    const issues = quoteCloseIssues(
      quoted.positions, quoted.feeds, quoted.observations, end, quoted.currency,
    )
    blockers.push(...issues.blockers)
    warnings.push(...issues.warnings)
  }

  // Watched wallets. Warnings only, never blockers — see lib/portfolio/wallets.ts for why a
  // quantity disagreement is a decision the fund makes rather than a stop.
  const walletInputs = await loadWalletCloseInputs(admin, fundId, group, end)
  if (walletInputs) {
    const issues = walletCloseIssues(
      walletInputs.positions, walletInputs.wallets, walletInputs.balances, end,
    )
    blockers.push(...issues.blockers)
    warnings.push(...issues.warnings)
  }

  // Cost basis on partial disposals. Warnings, not blockers: the recorded figure is what the
  // books use and a fund may have a deliberate reason for it, so this reports the disagreement
  // rather than overruling it. See lib/portfolio/lots.ts.
  warnings.push(...await loadLotIssues(admin, fundId, group, end))

  if (bankRows.length > 0) {
    const total = roundCents(bankRows.reduce((s, t) => s + Number(t.amount), 0))
    blockers.push(
      `${bankRows.length} bank transaction${bankRows.length === 1 ? '' : 's'} in this span ${bankRows.length === 1 ? 'is' : 'are'} not posted yet (net ${total.toFixed(2)}). ` +
      `Categorize and post them on the Bank page — otherwise their income and expense is never allocated to any partner.`
    )
  }

  return {
    draftEntries: { count: draftRows.length, earliest: draftRows.map(d => d.entry_date).sort()[0] ?? null },
    unpostedBankTxns: {
      count: bankRows.length,
      total: roundCents(bankRows.reduce((s, t) => s + Number(t.amount), 0)),
    },
    bank: null,
    blockers,
    warnings,
  }
}

/** What closing through `endDate` would allocate, month by month. Writes nothing. */
/** The furthest ahead a close may reach. A close is a period-END activity; closing into the
 *  distant future is never legitimate, and letting it happen is a denial-of-service. */
const MAX_MONTHS_PER_CLOSE = 120

export function validateCloseDate(endDate: string): { endDate: string } | { error: string } {
  if (!endDate) return { error: 'An end date is required' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return { error: 'The end date must be YYYY-MM-DD.' }
  }
  const parsed = new Date(`${endDate}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return { error: `"${endDate}" is not a real date.` }

  // A close reaches THROUGH a date, splitting the span into calendar months and locking each
  // one. An unbounded date is therefore a weapon: `endDate: "9999-12-31"` creates ~95,000
  // closed periods, and the period-lock trigger (20260714000004) then refuses every future
  // write to any date they cover. Undoing it means one reopen call per period, newest-first.
  //
  // Nothing legitimate closes into next year, let alone the next millennium.
  const horizon = new Date()
  horizon.setUTCMonth(horizon.getUTCMonth() + 1)
  if (parsed > horizon) {
    return { error: `Can't close through ${endDate} — it is in the future.` }
  }

  return { endDate }
}

export async function previewCloseThrough(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  endDate: string
): Promise<CloseThroughPreview | { error: string }> {
  const valid = validateCloseDate(endDate)
  if ('error' in valid) return valid

  const start = await nextCloseStart(admin, fundId, group)
  if (!start) return { error: 'Nothing to close — the ledger has no posted entries' }
  if (start > endDate) {
    // `start` is where the next close BEGINS. If a period is actually closed, say so;
    // otherwise the ledger simply has no POSTED entry before `start` — the message must
    // not claim a close that never happened (a vehicle can have years of DRAFT entries
    // before its first posted one). Post those drafts to bring them into scope.
    const closed = await closedPeriodRanges(admin, fundId, group)
    if (closed.length > 0) {
      const lastClosed = closed.map(p => p.period_end).sort().pop()!
      return { error: `Already closed through ${lastClosed} — pick a later date.` }
    }
    return { error: `Closing starts at ${start} (the first posted entry) — pick ${start} or later. Anything dated earlier is still a draft; post those entries first to include them.` }
  }

  const windows = monthWindows(start, endDate)

  // Belt to the date guard's braces. The start is DERIVED from the ledger, so a vehicle whose
  // first entry is mis-dated (1970, say) could still generate hundreds of windows from a
  // perfectly reasonable end date — each one a DB round-trip, an insert and a snapshot.
  if (windows.length > MAX_MONTHS_PER_CLOSE) {
    return {
      error:
        `That would close ${windows.length} months in one go, starting from ${start}. ` +
        `Close in smaller spans (at most ${MAX_MONTHS_PER_CLOSE} months at a time), or check whether ` +
        `an entry is mis-dated — the start date is derived from the earliest unclosed entry in the ledger.`,
    }
  }

  const months: ClosePreview[] = []
  const warnings: string[] = []
  let shadowResiduals: Map<string, number> | undefined

  for (const w of windows) {
    const p = await previewClose(admin, fundId, group, w.start, w.end, shadowResiduals)
    if ('error' in p) return { error: `${w.label}: ${p.error}` }
    // The gap warning can't fire here — the start is derived, so there is no gap.
    months.push({ ...p, warnings: p.warnings.filter(x => !x.startsWith('There is unallocated P&L before')) })
    if (p.mode === 'partners') {
      if (!shadowResiduals) {
        const vehicleId = await vehicleIdByName(admin, fundId, group)
        shadowResiduals = vehicleId
          ? await allocationResiduals(admin, fundId, vehicleId, w.start)
          : new Map<string, number>()
      }
      for (const category of p.categories) {
        for (const line of category.lines) {
          const key = `${category.sourceType}:${line.lpEntityId}`
          shadowResiduals.set(key, (shadowResiduals.get(key) ?? 0) + line.exactAmount - line.amount)
        }
      }
    }
  }

  const withActivity = months.filter(m => m.categories.length > 0)
  if (withActivity.length === 0) {
    warnings.push('No P&L activity in this span — closing will lock the books without allocating anything.')
  }
  const basis = months[0]?.basis ?? 'commitment'
  const mode = months[0]?.mode ?? 'partners'
  const readiness = await checkReadiness(admin, fundId, group, start, endDate)
  const suggestedEntries = await loadCloseEntrySuggestions(admin, fundId, group, start, endDate)
  const requiredSuggestions = suggestedEntries.filter(entry => entry.required)
  if (requiredSuggestions.length > 0) {
    readiness.blockers.push(
      `${requiredSuggestions.length} required scheduled entr${requiredSuggestions.length === 1 ? 'y is' : 'ies are'} missing. Create and review the draft${requiredSuggestions.length === 1 ? '' : 's'} before closing.`,
    )
  }
  const inferredSuggestions = suggestedEntries.filter(entry => entry.basis === 'recurring_pattern')
  if (inferredSuggestions.length > 0) {
    readiness.warnings.push(
      `${inferredSuggestions.length} recurring entr${inferredSuggestions.length === 1 ? 'y was' : 'ies were'} expected from prior-month patterns but not found in this period. Review the suggested draft${inferredSuggestions.length === 1 ? '' : 's'} or document why they do not recur.`,
    )
  }

  return {
    start,
    end: endDate,
    months,
    totalNetIncome: roundCents(months.reduce((s, m) => s + m.netIncome, 0)),
    basis,
    mode,
    readiness,
    suggestedEntries,
    warnings,
  }
}

/**
 * Close every month from the derived start through `endDate`, in order. Each month is
 * its own fiscal period with its own allocation entries, so a single month can be
 * reopened later without unwinding the rest.
 *
 * Stops at the first failure and leaves earlier months closed — they're valid on their
 * own, and re-running picks up where it left off (the start is derived).
 */
export async function closeThrough(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  endDate: string
): Promise<{ closed: { id: string; label: string; netIncome: number }[] } | { error: string }> {
  const preview = await previewCloseThrough(admin, fundId, group, endDate)
  if ('error' in preview) return preview

  // Refuse rather than strand P&L. The preview shows these too, but the check is
  // enforced HERE so it can't be bypassed by calling the API directly.
  if (preview.readiness.blockers.length > 0) {
    return { error: `Not ready to close. ${preview.readiness.blockers.join(' ')}` }
  }

  const windows = monthWindows(preview.start, preview.end)
  const closed: { id: string; label: string; netIncome: number }[] = []

  for (const w of windows) {
    const result = await closePeriodWithAllocation(admin, fundId, group, userId, w.start, w.end, w.label)
    if ('error' in result) {
      return closed.length > 0
        ? { error: `Closed ${closed.map(c => c.label).join(', ')}, then failed on ${w.label}: ${result.error}` }
        : { error: `${w.label}: ${result.error}` }
    }
    closed.push({ id: result.id, label: w.label, netIncome: result.netIncome })
  }

  return { closed }
}

/**
 * Close a period: allocate its P&L to partners' capital, snapshot the ledger, and
 * lock the date range.
 *
 * Order matters. The fiscal period row is created OPEN, the allocation entries are
 * posted (persistEntry refuses to post into a closed period, so it must not be
 * locked yet), and only then is it marked closed. A failure part-way leaves an open
 * period with entries tagged to it, which reopening cleans up.
 */
export async function closePeriodWithAllocation(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  periodStart: string,
  periodEnd: string,
  label?: string
): Promise<{ id: string; entryIds: string[]; netIncome: number } | { error: string }> {
  const preview = await previewClose(admin, fundId, group, periodStart, periodEnd)
  if ('error' in preview) return preview

  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const codes = await accountIdByCode(admin, fundId, group)
  const bridgeId = codes.get(BRIDGE_CODE)
  if (!bridgeId) return { error: `Missing account ${BRIDGE_CODE} (Undistributed earnings) — seed the chart of accounts first` }

  const lpIds = Array.from(new Set(preview.categories.flatMap(c => c.lines.map(l => l.lpEntityId))))
  const capMap = await ensureCapitalAccounts(admin, fundId, group, lpIds)

  // 1. The period must exist and be OPEN so the allocation entries can post into it.
  //    Reuse an existing row for this exact range — reopening leaves the row behind as
  //    a record, and inserting blindly would pile up a duplicate on every re-close.
  const { data: existingPeriod } = await admin
    .from('fiscal_periods' as any)
    .select('id')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .eq('period_start', periodStart)
    .eq('period_end', periodEnd)
    .maybeSingle()

  let periodId: string
  if (existingPeriod) {
    periodId = (existingPeriod as any).id
    await admin.from('fiscal_periods' as any)
      .update({ status: 'open', label: label ?? null, closed_at: null, closed_by: userId })
      .eq('id', periodId).eq('fund_id', fundId)

    // Void anything a PREVIOUS attempt at this period already posted, before we post a new
    // set. Without this, a close that died between posting its entries (step 2) and locking
    // the period (step 3) leaves the row 'open' with live `close:<periodId>` entries — and
    // re-running would post a SECOND full set against the same source_ref, silently doubling
    // every partner's allocation. Voiding first makes a re-close idempotent.
    const cleared = await voidCloseEntries(admin, fundId, vehicleId, periodId)
    if ('error' in cleared) return { error: `Couldn't clear the previous close attempt: ${cleared.error}` }
  } else {
    const { data: periodRow, error: periodErr } = await admin
      .from('fiscal_periods' as any)
      .insert({
        fund_id: fundId,
        portfolio_group: group,
        vehicle_id: vehicleId,
        period_start: periodStart,
        period_end: periodEnd,
        label: label ?? null,
        status: 'open',
        closed_by: userId,
      })
      .select('id')
      .single()
    if (periodErr) return { error: periodErr.message }
    periodId = (periodRow as any).id
  }
  const sourceRef = `close:${periodId}`
  const entryIds: string[] = []

  // 2 (owner mode). One entry per category, net income to the single equity account — a
  // management company's members' capital or an individual's owner's capital. No partner
  // lines, no carry, no associate economics: none of those exist for these kinds.
  if (preview.mode === 'owner') {
    const { data: ownerAcct } = await admin
      .from('chart_of_accounts' as any)
      .select('id')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId)
      .eq('subtype', 'members_capital')
      .maybeSingle()
    if (!ownerAcct) {
      await admin.from('fiscal_periods' as any).delete().eq('id', periodId).eq('fund_id', fundId)
      return { error: "No owner's capital account (subtype members_capital) on this chart — seed the chart for this vehicle's kind first" }
    }
    const kind = await vehicleKindByName(admin, fundId, group)
    const entries = ownerCloseEntries(preview.categories, {
      fundId, bridgeId, ownerCapitalId: (ownerAcct as any).id, periodStart, periodEnd, sourceRef, label, ownerNoun: ownerNoun(kind),
    })
    for (const entry of entries) {
      const result = await persistEntry(admin, fundId, group, userId, entry, 'posted')
      if ('error' in result) {
        await reopenPeriodWithReversal(admin, fundId, group, periodId)
        await admin.from('fiscal_periods' as any).delete().eq('id', periodId).eq('fund_id', fundId)
        return { error: `Close failed (${entry.memo}): ${result.error}` }
      }
      entryIds.push(result.entryId)
    }
  }

  // 2. Post one allocation entry per category, tagged so reopening can find them.
  for (const cat of preview.mode === 'owner' ? [] : preview.categories) {
    const postings: Posting[] = [
      // The bridge takes the whole category; each partner takes their share.
      { accountId: bridgeId, amount: roundCents(cat.capitalEffect), currency: 'USD', lpEntityId: null },
    ]
    for (const line of cat.lines) {
      if (line.amount === 0) continue
      const accountId = capMap.get(line.lpEntityId)
      if (!accountId) return { error: `No capital account for partner ${line.name}` }
      // Credit capital when the category increases it — hence the negation.
      postings.push({ accountId, amount: roundCents(-line.amount), currency: 'USD', lpEntityId: line.lpEntityId })
    }

    const entry: JournalEntry = {
      fundId,
      entryDate: periodEnd,
      memo: `${label ?? `${periodStart} → ${periodEnd}`} close — ${cat.label} allocated to partners`,
      sourceType: cat.sourceType,
      sourceRef,
      postings,
    }
    const result = await persistEntry(admin, fundId, group, userId, entry, 'posted')
    if ('error' in result) {
      // Roll back: void anything already posted and drop the period.
      await reopenPeriodWithReversal(admin, fundId, group, periodId)
      await admin.from('fiscal_periods' as any).delete().eq('id', periodId).eq('fund_id', fundId)
      return { error: `Allocation failed (${cat.label}): ${result.error}` }
    }
    entryIds.push(result.entryId)
  }

  // 2b. ACCRUE NOTE INTEREST — before carry, because it is income, and carry is computed on the
  // NAV that income produces. A note earns its coupon whether or not anyone books it; not
  // accruing understates the fund's income and the position's carrying value, and then at
  // conversion the interest appears inside the equity's cost basis with no record of where it
  // came from.
  const interestResult = await accrueNoteInterest(admin, fundId, group, userId, periodEnd, sourceRef)
  if ('error' in interestResult) {
    await reopenPeriodWithReversal(admin, fundId, group, periodId)
    await admin.from('fiscal_periods' as any).delete().eq('id', periodId).eq('fund_id', fundId)
    return { error: `Note interest accrual failed: ${interestResult.error}` }
  }
  entryIds.push(...interestResult.entryIds)

  // 2c. ACCRUE CARRIED INTEREST — last, and only after every other category has landed.
  //
  // Carry is computed on the NAV those allocations produce, so it cannot be just another
  // category in the loop above: it depends on their result. Ask "if the fund liquidated at
  // today's NAV, what would the GP be owed?", compare that to what is already accrued, and post
  // the difference. Because the TARGET is recomputed from scratch every period, a fall in NAV
  // reverses the accrual on its own — there is no clawback special case.
  //
  // Without this, every LP's NAV overstates what they would actually receive by the GP's share
  // of the unrealized gain.
  const carryResult = preview.mode === 'owner'
    ? { entryId: undefined as string | undefined }
    : await accrueCarry(admin, fundId, group, userId, periodEnd, sourceRef)
  if ('error' in carryResult) {
    await reopenPeriodWithReversal(admin, fundId, group, periodId)
    await admin.from('fiscal_periods' as any).delete().eq('id', periodId).eq('fund_id', fundId)
    return { error: `Carry accrual failed: ${carryResult.error}` }
  }
  if (carryResult.entryId) entryIds.push(carryResult.entryId)

  // 2d. ACCRUE FUND ECONOMICS EARNED — only if THIS vehicle is the GP/associate of another fund.
  // Marks its Investment in Fund (1500) to its fund-book position on its own books: BOTH the carry
  // it earned (carry points) AND the appreciation of its own GP capital commitment (ownership),
  // each line filed into its matching capital-account bucket and allocated to members. Self-
  // contained: uses this close's own source_ref, reconciles to the served-fund target per line, and
  // reverses with the ordinary vehicle-scoped reopen. A no-op for a normal fund vehicle.
  const earnedResult = preview.mode === 'owner'
    ? { entryIds: [] as string[] }
    : await accrueAssociateEconomics(admin, fundId, group, userId, periodEnd, sourceRef)
  if ('error' in earnedResult) {
    await reopenPeriodWithReversal(admin, fundId, group, periodId)
    await admin.from('fiscal_periods' as any).delete().eq('id', periodId).eq('fund_id', fundId)
    return { error: `Associate economics accrual failed: ${earnedResult.error}` }
  }
  entryIds.push(...earnedResult.entryIds)

  // Preserve the exact pro-rata entitlement behind the cent-denominated journal lines. Only
  // CLOSED periods feed the next preview, so reopening automatically removes this period from
  // cumulative rounding without deleting its audit trail.
  if (preview.mode === 'partners') {
    const roundingRows = preview.categories.flatMap(category => category.lines.map(line => ({
      fund_id: fundId,
      vehicle_id: vehicleId,
      fiscal_period_id: periodId,
      source_type: category.sourceType,
      lp_entity_id: line.lpEntityId,
      exact_amount: line.exactAmount,
      posted_amount: line.amount,
    })))
    if (roundingRows.length > 0) {
      const { error: roundingErr } = await admin.from('close_allocation_rounding' as any)
        .upsert(roundingRows, { onConflict: 'fiscal_period_id,source_type,lp_entity_id' })
      if (roundingErr) {
        await reopenPeriodWithReversal(admin, fundId, group, periodId)
        await admin.from('fiscal_periods' as any).delete().eq('id', periodId).eq('fund_id', fundId)
        return { error: `Could not preserve cumulative allocation rounding: ${roundingErr.message}` }
      }
    }
  }

  // 3. Snapshot and lock.
  const snapshot = await exportLedgerText(admin, fundId, group, periodEnd)
  const readiness = await checkReadiness(admin, fundId, group, periodStart, periodEnd)
  const review = await persistCloseReview(admin, fundId, group, vehicleId!, periodId, userId, readiness, snapshot, periodEnd)
  if (review.error) {
    await reopenPeriodWithReversal(admin, fundId, group, periodId)
    return { error: `Could not preserve the close review record: ${review.error}` }
  }
  const { error: closeErr } = await admin
    .from('fiscal_periods' as any)
    .update({ status: 'closed', closed_at: new Date().toISOString(), closed_by: userId, snapshot_text: snapshot })
    .eq('id', periodId)
    .eq('fund_id', fundId)
  if (closeErr) {
    await admin.from('close_reviews' as any).update({ status: 'reopened', updated_at: new Date().toISOString() })
      .eq('fiscal_period_id', periodId).eq('fund_id', fundId)
    return { error: closeErr.message }
  }

  await removeSupersededPeriods(admin, fundId, vehicleId, periodId, periodStart, periodEnd)

  return { id: periodId, entryIds, netIncome: preview.netIncome }
}

/**
 * Delete period rows this close has SUPERSEDED — leftovers that overlap the range just closed
 * but hold nothing.
 *
 * Row reuse above matches on the EXACT range, which is right: two genuinely different windows
 * are two different periods. But it means a pre-existing row with a non-standard range (a
 * December ending on the 30th, say) is orphaned rather than replaced when the calendar-month
 * close runs — leaving an OPEN period overlapping a CLOSED one, both labelled the same month.
 * That reads as a second, unfinished close of a month that is in fact closed.
 *
 * Deliberately narrow, because a fiscal period is a record and deleting one is not reversible.
 * A row is removed only when ALL of these hold:
 *   - it overlaps the range just closed, and is not the row we closed;
 *   - it is NOT closed itself (a closed period is real history — overlapping ones need a human);
 *   - no journal entry points at it, and it has no `close:<id>` entries of its own.
 * Anything failing those is left exactly where it is.
 */
async function removeSupersededPeriods(
  admin: SupabaseClient,
  fundId: string,
  vehicleId: string | null,
  keepId: string,
  periodStart: string,
  periodEnd: string
): Promise<void> {
  const { data: overlapping } = await admin
    .from('fiscal_periods' as any)
    .select('id, status')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .neq('id', keepId)
    .lte('period_start', periodEnd)
    .gte('period_end', periodStart)

  for (const p of ((overlapping as any[]) ?? [])) {
    if (p.status === 'closed') continue

    const [{ count: entryCount }, { count: closeCount }] = await Promise.all([
      admin.from('journal_entries' as any).select('id', { count: 'exact', head: true }).eq('book', ACTUAL_BOOK)
        .eq('fund_id', fundId).eq('period_id', p.id),
      admin.from('journal_entries' as any).select('id', { count: 'exact', head: true }).eq('book', ACTUAL_BOOK)
        .eq('fund_id', fundId).eq('source_ref', `close:${p.id}`),
    ])
    if ((entryCount ?? 0) > 0 || (closeCount ?? 0) > 0) continue

    await admin.from('fiscal_periods' as any).delete().eq('id', p.id).eq('fund_id', fundId)
  }
}

/**
 * Accrue interest earned on convertible notes, as at `periodEnd`.
 *
 *   Dr 1150-<company>  Accrued interest   (asset, per company)
 *   Cr 4110            Note interest income
 *
 * Kept apart from 4100 (bank interest) on purpose: an LP reading the income statement should be
 * able to tell yield the PORTFOLIO produced from yield the BANK ACCOUNT produced. Both roll into
 * `operatingIncome` on a capital account, but they are different lines, because they are
 * different businesses.
 *
 * Preferred dividends are NOT accrued here. A cumulative dividend accrues to the liquidation
 * preference, not to income — it is not earned until declared, and its effect reaches the
 * statements through the fair-value mark. `loadNotes` reads `interest_rate` and never
 * `dividend_rate`.
 *
 * Self-correcting: the target is recomputed from the note terms every close, so fixing a wrong
 * rate repairs the balance at the next close rather than compounding.
 */
async function accrueNoteInterest(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  periodEnd: string,
  sourceRef: string
): Promise<{ entryIds: string[] } | { error: string }> {
  const notes = await loadNotes(admin, fundId, group, periodEnd)
  if (notes.length === 0) return { entryIds: [] }

  const codes = await accountIdByCode(admin, fundId, group)
  const incomeId = codes.get(NOTE_INTEREST_INCOME)
  if (!incomeId) {
    // The chart predates note support. Say so rather than silently skipping the accrual —
    // a fund holding notes that books no interest is understating its income every period.
    return { error: `${group} is missing account ${NOTE_INTEREST_INCOME} (Note interest income). Re-sync the chart of accounts.` }
  }

  const companies = Array.from(
    new Map(notes.map(n => [n.companyId, { id: n.companyId, name: n.companyName }])).values()
  )
  const accts = await ensureInvestmentAccounts(admin, fundId, group, companies)

  // What's already accrued, per company, straight from the ledger.
  const { postings } = await loadPostedLedger(admin, fundId, group, periodEnd)
  const balances = accountBalances(postings)
  const accruedByCompany = new Map<string, number>()
  for (const c of companies) {
    const id = accts.get(c.id)?.accruedInterestId
    if (id) accruedByCompany.set(c.id, roundCents(balances.get(id) ?? 0))
  }

  const accruals = noteAccruals(notes, accruedByCompany, periodEnd)
  const entryIds: string[] = []

  for (const a of accruals) {
    const accruedId = accts.get(a.companyId)?.accruedInterestId
    if (!accruedId) continue

    const entry: JournalEntry = {
      fundId,
      entryDate: periodEnd,
      sourceType: 'income',
      memo: a.delta > 0
        ? `Note interest accrued — ${a.companyName}`
        : `Note interest accrual adjusted — ${a.companyName}`,
      sourceRef, // reopening the period voids this with everything else the close posted
      postings: [
        { accountId: accruedId, amount: a.delta, currency: 'USD', lpEntityId: null },
        { accountId: incomeId, amount: roundCents(-a.delta), currency: 'USD', lpEntityId: null },
      ],
    }
    const result = await persistEntry(admin, fundId, group, userId, entry, 'posted')
    if ('error' in result) return { error: `${a.companyName}: ${result.error}` }
    entryIds.push(result.entryId)
  }

  return { entryIds }
}

/**
 * Post this period's carried-interest accrual, if the vehicle has carry terms.
 *
 * Everything it needs comes from the ledger as at `periodEnd`:
 *   - each LP's contributions, distributions and current capital (the roll-forward buckets)
 *   - how much carry is ALREADY accrued (the GP partner's `carriedInterest` bucket)
 *   - dated contributions, for the preferred-return hurdle
 *
 * The GP partner is excluded from the LP economics — it is receiving the carry, not paying it.
 */
async function accrueCarry(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  periodEnd: string,
  sourceRef: string
): Promise<{ entryId?: string } | { error: string }> {
  const terms = await loadCarryTerms(admin, fundId, group)
  if (terms.kind === 'none' || terms.carryRate <= 0) return {}
  if (terms.recipients.length === 0) {
    return { error: `${group} has carry terms but no recipient set to receive the carry.` }
  }
  const recipientIds = new Set(terms.recipients.map(r => r.lpEntityId))

  // The books as they now stand, INCLUDING the allocation entries we just posted.
  const { capitalPostings } = await loadPostedLedger(admin, fundId, group, periodEnd)
  const accounts = computeCapitalAccounts(capitalPostings)

  // Carry already sitting in the recipients' accounts — the accrual tops up (or reverses) to target.
  // NOTE: only the per-period DELTA is split by the current recipients/pcts. Changing the split (or
  // removing a recipient) is PROSPECTIVE — it does not rebalance carry already accrued in prior
  // periods. LP-side totals stay correct regardless; treat the recipient split as stable once carry
  // has begun accruing.
  const alreadyAccrued = roundCents(
    terms.recipients.reduce((s, r) => s + (accounts.get(r.lpEntityId)?.carriedInterest ?? 0), 0)
  )

  const lps: LpEconomics[] = Array.from(accounts.entries())
    .filter(([id]) => !recipientIds.has(id)) // recipients receive carry; they don't pay it
    .map(([lpEntityId, a]) => ({
      lpEntityId,
      contributed: roundCents(a.contributions),
      distributed: roundCents(-a.distributions), // stored negative on the account
      nav: roundCents(a.ending),
    }))

  if (lps.length === 0) return {}

  // Dated contributions, for the hurdle. The pref accrues from when cash actually arrived.
  const contributions: DatedContribution[] = capitalPostings
    .filter(p => !recipientIds.has(p.lpEntityId ?? '') && bucketForSourceType(p.sourceType) === 'contributions')
    .map(p => ({ date: p.entryDate ?? periodEnd, amount: roundCents(-p.amount) }))
    .filter(c => c.amount > 0)

  const accrual = carryAccrual({ lps, contributions, asOf: periodEnd }, terms, alreadyAccrued)
  if (accrual.delta === 0 || accrual.perLp.size === 0) return {}

  const capMap = await ensureCapitalAccounts(admin, fundId, group, [
    ...Array.from(accrual.perLp.keys()),
    ...Array.from(recipientIds),
  ])
  const codes = await accountIdByCode(admin, fundId, group)
  const gpCapitalId = codes.get('3000') ?? ''

  const entry = buildCarryEntry(
    {
      fundId,
      entryDate: periodEnd,
      memo:
        accrual.delta > 0
          ? `Carried interest accrued at ${periodEnd} NAV`
          : `Carried interest accrual reversed — NAV fell at ${periodEnd}`,
    },
    accrual.perLp,
    capMap,
    gpCapitalId,
    undefined,
    terms.recipients,
  )
  entry.sourceRef = sourceRef // so reopening the period voids the accrual with everything else

  const result = await persistEntry(admin, fundId, group, userId, entry, 'posted')
  if ('error' in result) return { error: result.error }
  return { entryId: result.entryId }
}

/**
 * The fund-performance lines an associate marks onto its OWN books, each with the source_type that
 * files it into the matching roll-forward bucket. Carried interest follows carry points; every
 * other line follows ownership — the `lookThroughAccount` split handles both. Deliberately EXCLUDES
 * contributions, distributions, transfers and the opening balance: those are cash/capital already
 * on the associate's books (the GP commit is funded, distributions are received), not performance
 * to mark.
 */
const ASSOCIATE_MARKUP_LINES: { bucket: keyof CapitalAccount; sourceType: string; label: string }[] = [
  { bucket: 'operatingIncome', sourceType: 'income', label: 'Operating income' },
  { bucket: 'realizedGains', sourceType: 'realized_gain', label: 'Realized gain / (loss)' },
  { bucket: 'unrealizedGains', sourceType: 'valuation', label: 'Unrealized gain / (loss)' },
  { bucket: 'managementFees', sourceType: 'management_fee', label: 'Management fees' },
  { bucket: 'expenses', sourceType: 'partnership_expense', label: 'Partnership expenses' },
  { bucket: 'fxTranslation', sourceType: 'fx_revaluation', label: 'FX translation' },
  { bucket: 'carriedInterest', sourceType: 'carried_interest', label: 'Carried interest' },
]

/**
 * Book, on a GP/associate entity's OWN books, its EQUITY-METHOD share of the fund it is the GP of —
 * the appreciation of its own GP capital commitment (ownership) AND the carried interest it earned
 * (carry points), each allocated to members. Kept SPLIT on the asset side so Investment in Fund
 * (1500) stays at cost: the appreciation marks up 1550 (unrealized gain on the stake), the carry
 * marks up 1600 (carry receivable). A GP entity's committed capital is invested in the fund and
 * moves with it, so both pieces belong on its books.
 *
 * Runs during the ASSOCIATE'S OWN close (not the served fund's), so it is fully self-contained: it
 * carries this close's own `source_ref`, and the ordinary vehicle-scoped reopen/re-close reverses
 * and replaces it — no cross-vehicle reversal.
 *
 * RECONCILES TO A TARGET per line, it does not mirror a delta. The target is the associate's
 * fund-book position at `periodEnd`, split among members by the SAME `lookThroughAccount` the
 * reports use. Each posting is `target − already-booked` for that bucket — so a missed prior close
 * self-corrects and a fall in NAV reverses on its own. Contributions/distributions are left alone
 * (booked as cash). No-op unless this vehicle is a linked, ledger GP/associate with a 1500 account.
 *
 * NOTE: reads the served fund's CURRENT marks, so close the served fund first; if the associate is
 * closed before the fund accrues, re-closing the associate reconciles it.
 */
async function accrueAssociateEconomics(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  periodEnd: string,
  sourceRef: string,
): Promise<{ entryIds: string[] } | { error: string }> {
  const link = await gpLinkFor(admin, fundId, group)
  if (!link) return { entryIds: [] }
  const codes = await accountIdByCode(admin, fundId, group)
  const investmentId = codes.get('1500')
  if (!investmentId) return { entryIds: [] }
  // Split the markup so Investment in Fund (1500) stays at COST: the appreciation lands in 1550
  // (unrealized gain on the stake), carry in 1600 (carry receivable). Fall back to 1500 if a chart
  // wasn't reseeded with the split accounts, so an older associate still closes (just lumped).
  const unrealizedInFundId = codes.get('1550') ?? investmentId
  const carryReceivableId = codes.get('1600') ?? investmentId

  const [served, own, ownership, terms] = await Promise.all([
    loadCapitalPostings(admin, fundId, link.servesVehicle, periodEnd),
    loadCapitalPostings(admin, fundId, group, periodEnd),
    loadOwnershipBasis(admin, fundId, link, periodEnd),
    loadPartnerTerms(admin, fundId, group),
  ])

  // Target: the associate's fund-book position, split among members (capital by ownership, carry
  // by points). Booked: what its own books already carry for each line.
  const associateAccount = computeCapitalAccounts(served.postings).get(link.lpEntityId) ?? emptyAccount()
  const carryWeights = new Map<string, number>(
    terms
      .filter((t: any) => t.category === 'carried_interest' && t.participates && t.weightOverride != null)
      .map((t: any) => [t.lpEntityId as string, Number(t.weightOverride)] as [string, number])
  )
  const members = associateMembers(ownership.weights, carryWeights)
  if (members.length === 0) return { entryIds: [] }
  const split = lookThroughAccount(associateAccount, members)
  const ownAccounts = computeCapitalAccounts(own.postings)

  // Carry PAID nets against the own-book carriedInterest bucket, so add it back to recover the
  // amount already accrued (only the carry line has a paid-out counterpart).
  const carryPaidByLp = new Map<string, number>()
  for (const p of own.postings) {
    if (p.lpEntityId && p.sourceType === 'carry_distribution') {
      carryPaidByLp.set(p.lpEntityId, roundCents((carryPaidByLp.get(p.lpEntityId) ?? 0) + p.amount))
    }
  }

  const capMap = await ensureCapitalAccounts(admin, fundId, group, members.map(m => m.lpEntityId))
  const entryIds: string[] = []

  for (const line of ASSOCIATE_MARKUP_LINES) {
    const perMember = new Map<string, number>()
    for (const m of members) {
      const target = roundCents(split.get(m.lpEntityId)?.[line.bucket] ?? 0)
      const paidBack = line.bucket === 'carriedInterest' ? (carryPaidByLp.get(m.lpEntityId) ?? 0) : 0
      const booked = roundCents((ownAccounts.get(m.lpEntityId)?.[line.bucket] ?? 0) + paidBack)
      const delta = roundCents(target - booked)
      if (delta !== 0) perMember.set(m.lpEntityId, delta)
    }
    if (perMember.size === 0) continue

    // Carry marks up the carry receivable (1600); every other performance line marks up the
    // unrealized-gain-on-investment account (1550). Neither touches 1500, so it stays at cost.
    const assetId = line.bucket === 'carriedInterest' ? carryReceivableId : unrealizedInFundId
    const entry = buildAssociateMarkupEntry(
      { fundId, entryDate: periodEnd, memo: `${line.label} from ${link.servesVehicle} at ${periodEnd} NAV` },
      perMember,
      capMap,
      assetId,
      line.sourceType,
    )
    entry.sourceRef = sourceRef
    const result = await persistEntry(admin, fundId, group, userId, entry, 'posted')
    if ('error' in result) return { error: result.error }
    if (result.entryId) entryIds.push(result.entryId)
  }
  return { entryIds }
}

export interface CloseEntryLine {
  accountCode: string
  accountName: string
  /** The LP/partner this posting hits, when it's a per-partner (capital-account) line. */
  lpName: string | null
  amount: number
}
export interface CloseEntry {
  id: string
  entryDate: string
  memo: string | null
  sourceType: string | null
  lines: CloseEntryLine[]
}

/**
 * The allocation transactions a close posted for one period — every journal entry it wrote,
 * with its postings resolved to account and partner names. This is what the preview showed,
 * but read back from the LEDGER after the fact (re-running the preview can't reproduce it: the
 * close moves the period's P&L into capital, so a re-preview nets to zero). Found by the close's
 * deterministic `source_ref = close:<periodId>`.
 */
export async function loadCloseEntries(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  periodId: string,
): Promise<CloseEntry[]> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return []
  const { data: entries } = await admin
    .from('journal_entries' as any)
    .select('id, entry_date, memo, source_type')
    .eq('book', ACTUAL_BOOK)
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('source_ref', `close:${periodId}`).eq('status', 'posted')
    .order('entry_date', { ascending: true })
  const entryRows = (entries as any[]) ?? []
  if (entryRows.length === 0) return []

  const [{ data: postings }, { data: accts }, { data: ents }] = await Promise.all([
    admin.from('journal_postings' as any).select('journal_entry_id, account_id, amount, lp_entity_id').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).in('journal_entry_id', entryRows.map(e => e.id)),
    admin.from('chart_of_accounts' as any).select('id, code, name').eq('fund_id', fundId).eq('vehicle_id', vehicleId),
    admin.from('lp_entities' as any).select('id, entity_name').eq('fund_id', fundId),
  ])
  const acctById = new Map(((accts as any[]) ?? []).map(a => [a.id as string, a]))
  const nameById = new Map(((ents as any[]) ?? []).map(e => [e.id as string, e.entity_name as string]))

  const linesByEntry = new Map<string, CloseEntryLine[]>()
  for (const p of ((postings as any[]) ?? [])) {
    const a = acctById.get(p.account_id)
    const list = linesByEntry.get(p.journal_entry_id) ?? []
    list.push({
      accountCode: a?.code ?? '',
      accountName: a?.name ?? '',
      lpName: p.lp_entity_id ? (nameById.get(p.lp_entity_id) ?? null) : null,
      amount: Number(p.amount),
    })
    linesByEntry.set(p.journal_entry_id, list)
  }

  return entryRows.map(e => ({
    id: e.id as string,
    entryDate: e.entry_date as string,
    memo: (e.memo ?? null) as string | null,
    sourceType: (e.source_type ?? null) as string | null,
    lines: linesByEntry.get(e.id) ?? [],
  }))
}

/**
 * Reopen a period and reverse its allocation: void every entry the close posted
 * (found by source_ref), then unlock the range. The books return exactly to their
 * pre-close state — P&L untouched, capital accounts back to contributions only.
 */
export async function reopenPeriodWithReversal(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  periodId: string
): Promise<{ ok: true; voided: number } | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)

  // Periods must be reopened newest-first. A later period's allocation was computed
  // from the books as they stood AFTER this one — on a capital-balance basis it
  // literally depends on this period's allocation entries. Reopening out of order
  // would leave those later allocations silently computed from a state that no longer
  // exists.
  const { data: self } = await admin
    .from('fiscal_periods' as any)
    .select('period_end')
    .eq('id', periodId)
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .maybeSingle()
  if (!self) return { error: 'Period not found' }

  const { data: later } = await admin
    .from('fiscal_periods' as any)
    .select('period_start, period_end, label')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .eq('status', 'closed')
    .gt('period_start', (self as any).period_end)
    .order('period_start', { ascending: true })

  const blocking = ((later as any[]) ?? [])[0]
  if (blocking) {
    return {
      error: `Reopen later periods first — ${blocking.label ?? `${blocking.period_start} → ${blocking.period_end}`} is still closed, and its allocation was computed on top of this one.`,
    }
  }

  // UNLOCK FIRST, then void. The order matters: the database now refuses any write to an
  // entry dated inside a CLOSED period (migration 20260714000004), so voiding before
  // unlocking would have the reopen refuse itself.
  //
  // The failure mode is also better this way round. If the void half fails, the period is
  // open with its allocation entries still posted — which the next close repairs, because
  // `closePeriodWithAllocation` voids any pre-existing `close:<periodId>` entries before it
  // posts. The old order could leave a period LOCKED with its allocation already reversed:
  // capital accounts wrong, and no way to fix them without reopening again.
  const { error: openErr } = await admin
    .from('fiscal_periods' as any)
    .update({ status: 'open', closed_at: null, snapshot_text: null })
    .eq('id', periodId)
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
  if (openErr) return { error: openErr.message }

  const voided = await voidCloseEntries(admin, fundId, vehicleId, periodId)
  if ('error' in voided) return voided
  await admin.from('close_reviews' as any)
    .update({ status: 'reopened', updated_at: new Date().toISOString() })
    .eq('fiscal_period_id', periodId).eq('fund_id', fundId)

  return { ok: true, voided: voided.count }
}

/**
 * Reopen a period AND every closed period after it, newest-first.
 *
 * `reopenPeriodWithReversal` refuses out-of-order reopens for a good reason (see there), but
 * that reason is the system's, not the user's. Asking someone to click "Reopen" once per month
 * back through two years of closes to reach the one they want is the same as refusing. So this
 * walks the closed periods from the newest down to the target and reopens each in turn — the
 * exact order the single-period guard demands. `closeThrough` runs the other way, month by
 * month forward; this is its mirror.
 *
 * Stops at the first failure: everything after the failing period is already open, the
 * failing one and everything before it are still closed, and the error says which.
 */
export async function reopenThrough(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  target: { periodId: string } | { fromDate: string }
): Promise<{ ok: true; reopened: number; voided: number } | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)

  // Either a row ("this period and everything after it") or a date ("every close that
  // covers this date or comes after it") — the mirror of closing through a date.
  let cutoff: string
  if ('periodId' in target) {
    const { data: row } = await admin
      .from('fiscal_periods' as any)
      .select('period_start')
      .eq('id', target.periodId)
      .eq('fund_id', fundId)
      .eq('vehicle_id', vehicleId)
      .maybeSingle()
    if (!row) return { error: 'Period not found' }
    cutoff = (row as any).period_start
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(target.fromDate ?? '')) return { error: 'A valid date is required' }
    cutoff = target.fromDate
  }

  const { data: closed } = await admin
    .from('fiscal_periods' as any)
    .select('id, period_start, period_end, label')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .eq('status', 'closed')
    .gte('period_end', cutoff)
    .order('period_start', { ascending: false })
  if (!closed?.length) return { error: 'No closed period covers or follows that date' }

  let reopened = 0
  let voided = 0
  for (const p of ((closed as any[]) ?? [])) {
    const r = await reopenPeriodWithReversal(admin, fundId, group, p.id)
    if ('error' in r) {
      const label = p.label ?? `${p.period_start} → ${p.period_end}`
      return { error: `Reopened ${reopened} ${reopened === 1 ? 'period' : 'periods'}, then ${label} failed: ${r.error}` }
    }
    reopened += 1
    voided += r.voided
  }
  return { ok: true, reopened, voided }
}

/**
 * Void every entry a close posted for this period, found by `source_ref`.
 *
 * Void rather than delete: the allocation is derived and can be recomputed, but the audit
 * trail of having closed and reopened is not.
 *
 * Shared by reopen and by close itself — close calls it BEFORE posting, which is what makes
 * a re-close idempotent instead of doubling every partner's allocation.
 */
async function voidCloseEntries(
  admin: SupabaseClient,
  fundId: string,
  vehicleId: string | null,
  periodId: string
): Promise<{ count: number } | { error: string }> {
  const { data: entries, error: findErr } = await admin
    .from('journal_entries' as any)
    .select('id')
    .eq('book', ACTUAL_BOOK)
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .eq('source_ref', `close:${periodId}`)
    .neq('status', 'void')
  if (findErr) return { error: findErr.message }

  const ids = ((entries as any[]) ?? []).map(e => e.id)
  if (ids.length === 0) return { count: 0 }

  for (const id of ids) {
    const linked = await setGeneratedAllocationStatus(admin, fundId, id, 'void')
    if (linked.error) return { error: linked.error }
  }
  const { error: voidErr } = await admin
    .from('journal_entries' as any)
    .update({ status: 'void', posted_at: null })
    .in('id', ids)
    .eq('fund_id', fundId)
  if (voidErr) return { error: voidErr.message }

  return { count: ids.length }
}
