// Load one partner's ILPA Reporting Template (reporting.ts) for a quarter from the books, the
// close, the carry terms, the commitment register, the fee schedule, the portfolio-company fee
// register and the carry escrow register. Every journal read is the actual book: the template is
// book basis, so the tax book's overlay stays out.

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundCents } from '@/lib/accounting/ledger'
import { ACTUAL_BOOK } from '@/lib/accounting/books'
import { bucketForSourceType, computeCapitalAccounts, type CapitalPosting } from '@/lib/accounting/capital-account'
import { loadPostedLedger, loadOwnership, fetchAllRows } from '@/lib/accounting/load'
import { loadReportingCapital } from '@/lib/accounting/reporting-capital'
import { loadCommitmentEvents, resolveDatedCommitments } from '@/lib/accounting/terms'
import { loadPositions } from '@/lib/accounting/lp-positions'
import { loadCarryTerms } from '@/lib/accounting/carry'
import { carryAccrualInputs, carryTarget, type VehicleCarryTerms } from '@portfolio/fund-engine'
import { categoryFor } from '@/lib/accounting/continuous-allocation'
import { dateInAnyClosedPeriod } from '@/lib/accounting/periods'
import { isMissingSchema } from '@/lib/accounting/close-bundle'
import { loadFeeSchedule } from '@/lib/accounting/fee-schedule'
import { loadPortfolioFees } from '@/lib/accounting/portfolio-fees'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { accountCategory } from './taxonomy'
import {
  buildIlpaReporting, isQuarterEnd, reportingDates,
  type AllocationOrigin, type IlpaReporting, type ReportingCapitalPosting, type ReportingPnlLine,
} from './reporting'

/**
 * The share of the carry charged to the limited partners by `date` that realized profits alone
 * would support: the carry target with each partner's unrealized gains and currency translation
 * taken out of its NAV, over the carry charged. Pure.
 */
export function earnedCarryShare(postings: CapitalPosting[], terms: VehicleCarryTerms, date: string): number {
  if (terms.kind === 'none' || terms.carryRate <= 0) return 0
  const dated = postings.filter(p => !p.entryDate || p.entryDate <= date)
  const { lps, contributions, alreadyAccrued, distributions, bearing } = carryAccrualInputs(dated, terms.recipients, date, terms.gpCommitBearsCarry)
  if (alreadyAccrued <= 0.005 || lps.length === 0) return 0
  const accounts = computeCapitalAccounts(dated)
  const realizedOnly = lps.map(l => {
    const a = accounts.get(l.lpEntityId)
    return { ...l, nav: roundCents(l.nav - (a ? a.unrealizedGains + a.fxTranslation : 0)) }
  })
  const earned = carryTarget({ lps: realizedOnly, contributions, distributions, asOf: date }, terms)
  // When the GP commit bears carry the target includes the recipients' own share, which the LPs'
  // charge leaves out, so the ratio is taken against the whole target instead.
  const whole = bearing ? carryTarget({ lps, contributions, distributions, asOf: date }, terms) : alreadyAccrued
  if (whole <= 0.005) return 0
  return Math.min(1, Math.max(0, earned / whole))
}

export async function loadIlpaReporting(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  lpEntityId: string,
  quarterEnd: string,
): Promise<IlpaReporting | { error: string }> {
  if (!isQuarterEnd(quarterEnd)) return { error: 'quarterEnd must be a calendar quarter end: YYYY-03-31, 06-30, 09-30 or 12-31.' }
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: 'Unknown entity' }
  const dates = reportingDates(quarterEnd)

  const [
    capital, ledger, categoryRows, entryRows, periodRows, bundleRow, terms, events, owners, positions,
    schedule, fees, escrowRows, entityRows, fundRow, settingsRow,
  ] = await Promise.all([
    loadReportingCapital(admin, fundId, group, quarterEnd),
    loadPostedLedger(admin, fundId, group, quarterEnd),
    fetchAllRows<any>((f, t) => admin.from('chart_of_accounts' as any).select('id, reporting_category')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).order('id').range(f, t)),
    fetchAllRows<any>((f, t) => admin.from('journal_entries' as any).select('id, source_ref')
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'posted')
      .lte('entry_date', quarterEnd).not('source_ref', 'is', null).order('id').range(f, t)),
    admin.from('fiscal_periods' as any).select('id, period_start, period_end, status').eq('fund_id', fundId).eq('vehicle_id', vehicleId),
    (admin as any).from('close_bundles').select('bundle_sha256, created_at')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('period_end', quarterEnd).order('created_at', { ascending: false }).limit(1),
    loadCarryTerms(admin, fundId, group),
    loadCommitmentEvents(admin, fundId, group),
    loadOwnership(admin, fundId, group),
    loadPositions(admin, fundId, group, quarterEnd),
    loadFeeSchedule(admin, fundId, group),
    loadPortfolioFees(admin, fundId, group),
    (admin as any).from('carry_escrow_events').select('event_date, kind, amount').eq('fund_id', fundId).eq('vehicle_id', vehicleId).lte('event_date', quarterEnd),
    fetchAllRows<any>((f, t) => (admin as any).from('lp_entities').select('id, entity_name, partner_class').eq('fund_id', fundId).order('id').range(f, t)),
    admin.from('funds' as any).select('name').eq('id', fundId).maybeSingle(),
    admin.from('fund_settings' as any).select('currency').eq('fund_id', fundId).maybeSingle(),
  ])
  if ('error' in fees) return { error: fees.error }
  if ((escrowRows as any).error && !isMissingSchema((escrowRows as any).error)) return { error: 'The carry escrow register could not be read.' }

  // ── Capital ───────────────────────────────────────────────────────────────
  const notes: string[] = []
  const postings: ReportingCapitalPosting[] = []
  let undated = 0
  for (const p of capital.postings) {
    if (!p.entryDate || !p.entryId) { undated += 1; continue }
    postings.push({ lpEntityId: p.lpEntityId, amount: p.amount, sourceType: p.sourceType ?? null, entryDate: p.entryDate, entryId: p.entryId })
  }
  if (undated > 0) notes.push(`${undated} capital figure${undated === 1 ? '' : 's'} come${undated === 1 ? 's' : ''} from reported statements rather than dated ledger entries and ${undated === 1 ? 'is' : 'are'} left out, so the statement may not tie to the partner's reported capital.`)
  const ids = new Set([...postings.map(p => p.lpEntityId), ...Array.from(capital.commitmentByLp.keys())])
  if (!ids.has(lpEntityId)) return { error: 'That partner has no commitment or capital in this entity.' }

  // ── Profit and loss ───────────────────────────────────────────────────────
  const stated = new Map<string, string | null>(categoryRows.map(r => [r.id as string, (r.reporting_category ?? null) as string | null]))
  const accountById = new Map(ledger.accounts.map(a => [a.id, a]))
  const pnl: ReportingPnlLine[] = []
  for (const p of ledger.sourcedPostings) {
    const a = accountById.get(p.accountId)
    if (!a || !p.entryDate) continue
    const category = accountCategory({ type: a.type, subtype: a.subtype, reportingCategory: stated.get(a.id) })
    if (!category) continue
    pnl.push({
      entryId: p.entryId, entryDate: p.entryDate, amount: p.amount, category,
      bucket: bucketForSourceType(categoryFor(a), p.amount), accountName: `${a.code} ${a.name}`,
    })
  }

  // ── Where each allocation came from ───────────────────────────────────────
  const periods = (((periodRows as any).data as any[]) ?? [])
  const periodById = new Map(periods.map(p => [p.id as string, { start: p.period_start as string, end: p.period_end as string }]))
  const allocationOrigin = new Map<string, AllocationOrigin>()
  for (const e of entryRows) {
    const ref = (e.source_ref ?? '') as string
    const allocation = /^allocation:([0-9a-f-]{36}):/i.exec(ref)
    if (allocation) { allocationOrigin.set(e.id, { entryId: allocation[1] }); continue }
    const close = /^close:([0-9a-f-]{36})$/i.exec(ref)
    const range = close ? periodById.get(close[1]) : undefined
    if (range) allocationOrigin.set(e.id, range)
  }
  const closed = dateInAnyClosedPeriod(
    periods.filter(p => p.status === 'closed').map(p => ({ period_start: p.period_start, period_end: p.period_end })),
    quarterEnd,
  )
  const bundle = (bundleRow as any).error ? null : ((((bundleRow as any).data as any[]) ?? [])[0]?.bundle_sha256 ?? null)

  // ── Carry ─────────────────────────────────────────────────────────────────
  const ledgerPostings = ledger.capitalPostings
  const earnedShare = new Map<string, number>()
  for (const d of [dates.beforeQuarter, dates.beforeYear, dates.quarterEnd]) earnedShare.set(d, earnedCarryShare(ledgerPostings, terms, d))

  // ── Commitments ───────────────────────────────────────────────────────────
  const commitments = new Map<string, Map<string, number>>()
  for (const d of [dates.beforeQuarter, dates.beforeYear, dates.quarterEnd]) {
    commitments.set(d, resolveDatedCommitments(events, owners, positions.filter(p => p.asOfDate <= d), d))
  }

  // ── Registers ─────────────────────────────────────────────────────────────
  const entities = new Map(entityRows.map(e => [e.id as string, e]))
  const classes = new Map<string, string>(entityRows.map(e => [e.id as string, (e.partner_class as string) ?? 'lp']))
  const organizationalExpenses = postings
    .filter(p => p.sourceType === 'organizational_expense' && p.amount > 0)
    .map(p => ({ date: p.entryDate, amount: p.amount }))
  if (!schedule) notes.push('The entity has no fee schedule, so no portfolio-company fee is recognized as an offset.')

  return buildIlpaReporting({
    fund: {
      name: ((fundRow as any)?.data?.name as string) || group,
      vehicle: group,
      currency: ((settingsRow as any)?.data?.currency as string) || 'USD',
    },
    partner: { id: lpEntityId, name: (entities.get(lpEntityId)?.entity_name as string) || 'Partner' },
    quarterEnd,
    closed,
    bundleSha256: bundle,
    classes,
    capital: postings,
    pnl,
    allocationOrigin,
    carryRecipients: new Set(terms.recipients.map(r => r.lpEntityId)),
    earnedShare,
    commitments,
    portfolioFees: fees.map(f => ({ date: f.date, kind: f.kind, amount: f.amount, affiliatedAmount: f.affiliatedAmount, memo: f.memo })),
    offsetShares: schedule?.offsets ?? {},
    organizationalExpenseCap: schedule?.organizationalExpenseCap ?? null,
    organizationalExpenses,
    escrow: ((((escrowRows as any).data as any[]) ?? [])).map(e => ({ date: e.event_date, kind: e.kind, amount: Number(e.amount) })),
    notes,
  })
}
