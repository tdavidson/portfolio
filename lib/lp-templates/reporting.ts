// One partner's quarterly ILPA Reporting Template (v. 2.0): the capital account statement with
// fees, expenses, offsets and carried interest in ILPA's categories (A.1), the commitment
// reconciliation (A.2), and the fees the adviser received from portfolio companies (B.1). In this
// app's own layout, under the template's line labels (reporting-types.ts). Pure: the loader
// (reporting-load.ts) reads the books and registers, and everything here is arithmetic a test can pin.
//
// THREE ALLOCATIONS, each QTD, YTD and ITD: the partner, the whole fund including the GP (every
// partner's capital), and the GP (the general partner class).
//
// WHERE EACH FIGURE COMES FROM.
//   Flows       the partner's capital postings, by their entry's source type (taxonomy capitalLine).
//   Fees,       a partner's share of the fund's profit and loss reaches its capital as one posting
//   expenses,   per bucket (fees, expenses, income, gains). It is split across ILPA's categories in
//   income,     the proportions of the P&L it was allocated from: the source entry's lines for an
//   gains       allocation made when the entry posted, the closed period's lines for one made at a
//               close, else the window's. Each P&L line's category is its account's (accountCategory).
//   Carry       the template's NAV roll has no carry line, so a carry accrual lands in the gains: the
//               earned part (carry on realized profits) in realized, the rest in unrealized. The carry
//               roll-forward then states it from each partner's side: charged to a limited partner
//               negative, credited to a carry recipient positive, so the fund column nets to zero.
//               Carry paid out is a recipient's distribution, and the limited partners' share of it
//               follows their share of the carry charged.
//   Offsets     recognized: portfolio-company fees in the window times the share the fee schedule
//               offsets, plus organizational expenses over the cap. Applied: the offset accounts.
//   A.2         commitments at each date, less contributions, plus recallable (recycled) distributions.
//   B.1         the portfolio-company fee register: the partner's column at its share of commitments,
//               the fund's in full, and the affiliated positions' part in the third column.
//
// SIGNS follow the template (reporting-types.ts). A capital posting is debit-positive, so the
// partner's side of it is its negation; the same goes for a P&L line.

import { roundCents } from '@/lib/accounting/ledger'
import { bucketForSourceType, RECYCLED_PROCEEDS_SOURCE, type RollForwardBucket } from '@/lib/accounting/capital-account'
import type { PortfolioFeeKind } from '@/lib/accounting/portfolio-fees'
import {
  ILPA_REPORTING_ATTRIBUTION, ILPA_REPORTING_VERSION, PORTFOLIO_FEE_LINES, REPORTING_ALLOCATIONS,
  REPORTING_ALLOCATION_LABEL, REPORTING_LINE, REPORTING_LINES, REPORTING_SECTION_TITLE, REPORTING_WINDOWS,
  type AccountCategory, type ReportingAllocation, type ReportingLineKey, type ReportingWindow,
} from './taxonomy'

// ─── Inputs ────────────────────────────────────────────────────────────────────────────────────

export interface ReportingCapitalPosting {
  lpEntityId: string
  /** Debit-positive, as booked to the partner's capital account. */
  amount: number
  sourceType: string | null
  entryDate: string
  entryId: string
}

/** One line of the fund's profit and loss: a posting to an income or expense account. */
export interface ReportingPnlLine {
  entryId: string
  entryDate: string
  /** Debit-positive. */
  amount: number
  category: AccountCategory
  /** The capital bucket the P&L reaches a partner's capital through. */
  bucket: RollForwardBucket
  accountName: string
}

/** Where an allocation entry's P&L came from: the entry it allocated, or the closed period. */
export type AllocationOrigin = { entryId: string } | { start: string; end: string }

export interface ReportingFee {
  date: string
  kind: PortfolioFeeKind
  amount: number
  affiliatedAmount: number | null
  memo: string | null
}

export interface ReportingInputs {
  fund: { name: string; vehicle: string; currency: string }
  partner: { id: string; name: string }
  quarterEnd: string
  /** Is the quarter inside a closed period? Otherwise the file is marked draft. */
  closed: boolean
  /** The close bundle's hash for the period ending at the quarter end, if one was sealed. */
  bundleSha256: string | null
  /** partner_class per partner; absent = 'lp'. */
  classes: Map<string, string>
  /** Every capital posting dated on or before the quarter end. */
  capital: ReportingCapitalPosting[]
  /** Every P&L line dated on or before the quarter end. */
  pnl: ReportingPnlLine[]
  allocationOrigin: Map<string, AllocationOrigin>
  /** Who receives carry; they are credited it, never charged. */
  carryRecipients: Set<string>
  /**
   * The share of the carry charged to date that is earned on realized profits, at each date the
   * report reads it: the day before the quarter, the day before the year, and the quarter end.
   */
  earnedShare: Map<string, number>
  /** Each partner's commitment at the same three dates. */
  commitments: Map<string, Map<string, number>>
  portfolioFees: ReportingFee[]
  /** The fee schedule's share of each kind that offsets the fee. */
  offsetShares: Partial<Record<PortfolioFeeKind, number>>
  organizationalExpenseCap: number | null
  organizationalExpenses: { date: string; amount: number }[]
  escrow: { date: string; kind: 'deposit' | 'release'; amount: number }[]
  /** Notes the loader adds (evidence gaps and the like). */
  notes: string[]
}

// ─── Output ────────────────────────────────────────────────────────────────────────────────────

export interface ReportingColumn {
  allocation: ReportingAllocation
  window: ReportingWindow
}

export interface IlpaReporting {
  template: { name: 'ILPA Reporting Template'; version: string }
  fund: { name: string; vehicle: string; currency: string }
  partner: { id: string; name: string }
  period: { quarterStart: string; quarterEnd: string; yearStart: string }
  status: 'final' | 'draft'
  bundleSha256: string | null
  /** The nine columns every line carries, partner then fund then GP, each QTD, YTD, ITD. */
  columns: ReportingColumn[]
  values: Record<ReportingLineKey, number[]>
  /** The fee schedule's offset share for each offset category line, as the template's "% Offset". */
  offsetPercent: Partial<Record<ReportingLineKey, number>>
  /** Does each column's NAV roll end at the partner's capital on the books? Differences in cents. */
  ties: { column: ReportingColumn; books: number; difference: number }[]
  footnotes: string[]
}

// ─── Dates ─────────────────────────────────────────────────────────────────────────────────────

const QUARTER_END = /^(\d{4})-(03-31|06-30|09-30|12-31)$/

export function isQuarterEnd(date: string): boolean {
  return QUARTER_END.test(date)
}

export function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/** The quarter and year a calendar quarter end opens. */
export function quarterBounds(quarterEnd: string): { quarterStart: string; yearStart: string } {
  const m = QUARTER_END.exec(quarterEnd)
  if (!m) throw new Error(`${quarterEnd} is not a calendar quarter end.`)
  const month = Number(quarterEnd.slice(5, 7)) - 2
  return { quarterStart: `${m[1]}-${String(month).padStart(2, '0')}-01`, yearStart: `${m[1]}-01-01` }
}

/** The dates the loader must read the carry split and commitments at. */
export function reportingDates(quarterEnd: string): { beforeQuarter: string; beforeYear: string; quarterEnd: string } {
  const { quarterStart, yearStart } = quarterBounds(quarterEnd)
  return { beforeQuarter: dayBefore(quarterStart), beforeYear: dayBefore(yearStart), quarterEnd }
}

// ─── Arithmetic ────────────────────────────────────────────────────────────────────────────────

type Values = Map<ReportingLineKey, number>

const add = (v: Values, key: ReportingLineKey, amount: number) => {
  if (amount) v.set(key, (v.get(key) ?? 0) + amount)
}
const get = (v: Values, key: ReportingLineKey) => v.get(key) ?? 0

const DEFAULT_CATEGORY: Partial<Record<RollForwardBucket, AccountCategory>> = {
  managementFees: 'mgmt_fee_gross',
  expenses: 'ext_other',
  operatingIncome: 'other_investment_income',
  realizedGains: 'net_realized_gain',
  unrealizedGains: 'net_unrealized_gain',
  fxTranslation: 'net_unrealized_gain',
}

/** Split `amount` across categories in proportion to `weights`, to the cent, the remainder on the largest part. */
export function splitAcross(amount: number, weights: Map<AccountCategory, number>, fallback: AccountCategory): [AccountCategory, number][] {
  const entries = Array.from(weights.entries()).filter(([, w]) => Math.abs(w) >= 0.005)
  const total = entries.reduce((s, [, w]) => s + w, 0)
  if (entries.length === 0 || Math.abs(total) < 0.005) return [[fallback, roundCents(amount)]]
  const parts = entries.map(([c, w]): [AccountCategory, number] => [c, roundCents((amount * w) / total)])
  const diff = roundCents(amount - parts.reduce((s, [, a]) => s + a, 0))
  if (diff !== 0) {
    const big = parts.reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a))
    big[1] = roundCents(big[1] + diff)
  }
  return parts
}

const PNL_BUCKETS = new Set<RollForwardBucket>(['managementFees', 'expenses', 'operatingIncome', 'realizedGains', 'unrealizedGains', 'fxTranslation'])
const isCarryCharge = (p: ReportingCapitalPosting) =>
  p.sourceType !== 'carry_distribution' && bucketForSourceType(p.sourceType, p.amount) === 'carriedInterest'

const inRange = (date: string, from: string | null, to: string) => (from === null || date >= from) && date <= to

const APPLIED_OFFSETS: ReportingLineKey[] = ['mgmt_fee_offset', 'related_offset', 'ext_offset']

/** The template's subtotals, from its own formulas (RT - Formulas): every subtotal line, in order. */
function fillSubtotals(v: Values): void {
  const sum = (...keys: ReportingLineKey[]) => keys.reduce((s, k) => s + get(v, k), 0)
  const range = (from: ReportingLineKey, to: ReportingLineKey) => {
    const keys = REPORTING_LINES.map(l => l.key)
    return keys.slice(keys.indexOf(from), keys.indexOf(to) + 1).filter(k => REPORTING_LINE[k].kind === 'input')
  }
  v.set('total_flows', sum(...range('contributions', 'partner_transfers')))
  v.set('mgmt_fee_net', sum('mgmt_fee_gross', 'mgmt_fee_rebate', 'mgmt_fee_waiver', 'mgmt_fee_offset'))
  v.set('related_gross', sum(...range('related_admin', 'related_other')))
  v.set('related_net', sum('related_gross', 'related_offset'))
  v.set('ext_gross', sum(...range('ext_admin', 'ext_other_2016')))
  v.set('ext_net', sum('ext_gross', 'ext_offset'))
  v.set('total_net_expenses', sum('related_net', 'ext_net'))
  v.set('offsets_recognized', sum(...range('offset_advisory', 'offset_other_2016')))
  v.set('offsets_applied', sum(...APPLIED_OFFSETS))
  v.set('unapplied_recognized', get(v, 'offsets_recognized'))
  v.set('unapplied_applied', get(v, 'offsets_applied'))
  v.set('unapplied_ending', sum('unapplied_beginning', 'unapplied_recognized') - get(v, 'unapplied_applied'))
  v.set('fees_expenses_net', sum('mgmt_fee_net', 'related_net', 'ext_net'))
  v.set('fees_gross', sum('mgmt_fee_gross', 'related_gross', 'ext_gross'))
  v.set('fees_reductions', sum('offsets_applied', 'mgmt_fee_rebate', 'mgmt_fee_waiver'))
  v.set('fees_net', sum('fees_gross', 'fees_reductions'))
  v.set('total_investment_income', sum('interest_income', 'dividend_income', 'other_investment_income'))
  v.set('total_net_operating', sum('fees_expenses_net', 'total_investment_income'))
  v.set('total_gain', sum('net_realized_gain', 'net_unrealized_gain'))
  v.set('ending_nav', sum('beginning_nav', 'total_flows', 'total_net_operating', 'total_gain'))
  v.set('carry_total', sum('carry_accrued', 'carry_earned'))
  v.set('carry_ending', sum('carry_beginning', 'carry_total', 'carry_paid', 'carry_clawback'))
  v.set('ending_nav_gross', get(v, 'ending_nav') - get(v, 'carry_ending'))
  v.set('ending_unfunded', sum('beginning_unfunded', 'unfunded_contributions', 'unfunded_recallable', 'unfunded_released', 'unfunded_other'))
  v.set('pc_fees_total', sum(...range('pc_advisory', 'pc_other_2016')))
  v.set('pc_total', sum('pc_fees_total', 'pc_reimbursements'))
}

// ─── The report ────────────────────────────────────────────────────────────────────────────────

export function buildIlpaReporting(x: ReportingInputs): IlpaReporting {
  const Q = x.quarterEnd
  const { quarterStart, yearStart } = quarterBounds(Q)
  const dates = reportingDates(Q)
  const money = (n: number) =>
    n.toLocaleString('en-US', { style: 'currency', currency: x.fund.currency, currencySign: 'accounting', minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const capital = x.capital.filter(p => p.entryDate <= Q)
  const pnl = x.pnl.filter(l => l.entryDate <= Q)

  // Who is in each allocation.
  const everyone = new Set<string>([...capital.map(p => p.lpEntityId), ...Array.from(x.commitments.get(Q)?.keys() ?? [])])
  const members: Record<ReportingAllocation, Set<string>> = {
    partner: new Set([x.partner.id]),
    fund: everyone,
    gp: new Set(Array.from(everyone).filter(id => (x.classes.get(id) ?? 'lp') === 'gp')),
  }
  const windowStart: Record<ReportingWindow, string | null> = { QTD: quarterStart, YTD: yearStart, ITD: null }
  const beforeDate: Record<ReportingWindow, string | null> = { QTD: dates.beforeQuarter, YTD: dates.beforeYear, ITD: null }

  // ── P&L weights ─────────────────────────────────────────────────────────
  const pnlByEntry = new Map<string, ReportingPnlLine[]>()
  for (const l of pnl) {
    if (!pnlByEntry.has(l.entryId)) pnlByEntry.set(l.entryId, [])
    pnlByEntry.get(l.entryId)!.push(l)
  }
  const weigh = (lines: ReportingPnlLine[], bucket: RollForwardBucket) => {
    const w = new Map<AccountCategory, number>()
    for (const l of lines) if (l.bucket === bucket) w.set(l.category, (w.get(l.category) ?? 0) - l.amount)
    return w
  }
  const usable = (w: Map<AccountCategory, number>) => Math.abs(Array.from(w.values()).reduce((s, a) => s + a, 0)) >= 0.005
  const rangeWeights = new Map<string, Map<AccountCategory, number>>()
  const weightsForRange = (from: string | null, to: string, bucket: RollForwardBucket) => {
    const key = `${from}|${to}|${bucket}`
    if (!rangeWeights.has(key)) rangeWeights.set(key, weigh(pnl.filter(l => inRange(l.entryDate, from, to)), bucket))
    return rangeWeights.get(key)!
  }
  /** A capital posting's P&L, split across categories. Template-signed. */
  const splitPosting = (p: ReportingCapitalPosting, bucket: RollForwardBucket, window: { from: string | null; to: string }): [AccountCategory, number][] => {
    const origin = x.allocationOrigin.get(p.entryId) ?? { entryId: p.entryId }
    let w = 'entryId' in origin ? weigh(pnlByEntry.get(origin.entryId) ?? [], bucket) : weightsForRange(origin.start, origin.end, bucket)
    if (!usable(w)) w = weightsForRange(window.from, window.to, bucket)
    if (!usable(w)) w = weightsForRange(null, Q, bucket)
    return splitAcross(-p.amount, w, DEFAULT_CATEGORY[bucket]!)
  }

  // ── Carry ───────────────────────────────────────────────────────────────
  const recipients = x.carryRecipients
  const charges = capital.filter(isCarryCharge)
  const chargedMemo = new Map<string, number>()
  const chargedThrough = (id: string, date: string | null): number => {
    if (date === null) return 0
    const key = `${id}|${date}`
    if (!chargedMemo.has(key)) chargedMemo.set(key, -charges.filter(p => p.lpEntityId === id && p.entryDate <= date).reduce((s, p) => s + p.amount, 0))
    return chargedMemo.get(key)!
  }
  const lpCharged = (date: string) => Array.from(everyone).filter(id => !recipients.has(id)).reduce((s, id) => s + chargedThrough(id, date), 0)
  const recipientCredited = (date: string) => Array.from(recipients).reduce((s, id) => s + chargedThrough(id, date), 0)
  const totalLpCharged = lpCharged(Q)
  const totalRecipientCredit = recipientCredited(Q)
  /** A limited partner's share of carry paid, escrow and clawback: its share of the carry charged. */
  const lpCarryShare = (id: string) => (Math.abs(totalLpCharged) >= 0.005 ? chargedThrough(id, Q) / totalLpCharged : 0)
  const recipientShare = (id: string) => (Math.abs(totalRecipientCredit) >= 0.005 ? chargedThrough(id, Q) / totalRecipientCredit : 0)
  const carryPayouts = capital.filter(p => p.sourceType === 'carry_distribution' && recipients.has(p.lpEntityId))
  const payoutsIn = (from: string | null, to: string | null) => {
    let paid = 0, returned = 0
    if (to === null) return { paid, returned }
    for (const p of carryPayouts) {
      if (!inRange(p.entryDate, from, to)) continue
      if (p.amount > 0) paid += p.amount
      else returned -= p.amount
    }
    return { paid, returned }
  }
  const earned = (date: string | null) => (date === null ? 0 : Math.min(1, Math.max(0, x.earnedShare.get(date) ?? 0)))
  const escrowBalance = x.escrow.filter(e => e.date <= Q).reduce((s, e) => s + (e.kind === 'deposit' ? e.amount : -e.amount), 0)

  /** One partner's carry roll for a window, from its own side. */
  const carryFor = (id: string, w: ReportingWindow, v: Values) => {
    const before = beforeDate[w]
    const start = windowStart[w]
    const chargeBefore = chargedThrough(id, before)
    const chargeEnd = chargedThrough(id, Q)
    const charge = chargeEnd - chargeBefore
    const earnedPart = chargeEnd * earned(Q) - chargeBefore * earned(before)
    add(v, 'carry_earned', earnedPart)
    add(v, 'carry_accrued', charge - earnedPart)
    add(v, 'net_realized_gain', earnedPart)
    add(v, 'net_unrealized_gain', charge - earnedPart)

    const priorPayouts = payoutsIn(null, before)
    const windowPayouts = payoutsIn(start, Q)
    if (recipients.has(id)) {
      const own = (from: string | null, to: string | null) => {
        let paid = 0, returned = 0
        if (to === null) return { paid, returned }
        for (const p of carryPayouts) {
          if (p.lpEntityId !== id || !inRange(p.entryDate, from, to)) continue
          if (p.amount > 0) paid += p.amount
          else returned -= p.amount
        }
        return { paid, returned }
      }
      const prior = own(null, before)
      const now = own(start, Q)
      add(v, 'carry_beginning', chargeBefore - prior.paid + prior.returned)
      add(v, 'carry_paid', -now.paid)
      add(v, 'carry_clawback', now.returned)
      add(v, 'carry_escrow', escrowBalance * recipientShare(id))
    } else {
      const share = lpCarryShare(id)
      add(v, 'carry_beginning', chargeBefore + (priorPayouts.paid - priorPayouts.returned) * share)
      add(v, 'carry_paid', windowPayouts.paid * share)
      add(v, 'carry_clawback', -windowPayouts.returned * share)
      add(v, 'carry_escrow', -escrowBalance * share)
    }
  }

  // ── Offsets recognized ──────────────────────────────────────────────────
  const orgThrough = (date: string | null) => date === null ? 0
    : x.organizationalExpenses.filter(o => o.date <= date).reduce((s, o) => s + o.amount, 0)
  const recognized = (from: string | null, to: string | null): Values => {
    const v: Values = new Map()
    if (to === null) return v
    for (const f of x.portfolioFees) {
      if (!inRange(f.date, from, to)) continue
      add(v, PORTFOLIO_FEE_LINES[f.kind].offset, f.amount * (x.offsetShares[f.kind] ?? 0))
    }
    const cap = x.organizationalExpenseCap
    if (cap !== null) {
      const before = from === null ? null : dayBefore(from)
      add(v, 'offset_organization', Math.max(0, orgThrough(to) - cap) - Math.max(0, orgThrough(before) - cap))
    }
    return v
  }

  // ── Commitments ─────────────────────────────────────────────────────────
  const commitment = (ids: Set<string>, date: string) => {
    const at = x.commitments.get(date) ?? new Map<string, number>()
    return Array.from(ids).reduce((s, id) => s + (at.get(id) ?? 0), 0)
  }
  const totalCommitment = commitment(everyone, Q)

  // ── Activity: everything a capital posting moves, for a set of partners over a range ────
  const activity = (ids: Set<string>, from: string | null, to: string): Values => {
    const v: Values = new Map()
    for (const p of capital) {
      if (!ids.has(p.lpEntityId) || !inRange(p.entryDate, from, to)) continue
      const bucket = bucketForSourceType(p.sourceType, p.amount)
      const value = -p.amount
      if (bucket === 'beginning') add(v, 'beginning_nav', value)
      else if (bucket === 'contributions') add(v, 'contributions', value)
      else if (bucket === 'distributions') add(v, 'distributions', value)
      else if (bucket === 'transfers') add(v, 'partner_transfers', value)
      else if (bucket === 'carriedInterest') {
        // A charge or credit lands in the gains through carryFor; a payout is the recipient's distribution.
        if (p.sourceType === 'carry_distribution') add(v, 'distributions', value)
      } else if (PNL_BUCKETS.has(bucket)) {
        for (const [category, amount] of splitPosting(p, bucket, { from, to })) add(v, category, amount)
      } else {
        add(v, 'other_investment_income', value)
      }
    }
    return v
  }

  // ── Columns ─────────────────────────────────────────────────────────────
  const columns: ReportingColumn[] = []
  const valueSets: Values[] = []
  const ties: IlpaReporting['ties'] = []
  const itdFees = new Map<ReportingAllocation, number>()
  for (const allocation of REPORTING_ALLOCATIONS) {
    itdFees.set(allocation, get(activity(members[allocation], null, Q), 'mgmt_fee_gross'))
  }
  const fundFees = itdFees.get('fund') ?? 0

  for (const allocation of REPORTING_ALLOCATIONS) {
    const ids = members[allocation]
    // The partners' share of offsets: their share of the management fee, else of commitments.
    const offsetShare = Math.abs(fundFees) >= 0.005 ? (itdFees.get(allocation) ?? 0) / fundFees
      : totalCommitment > 0 ? commitment(ids, Q) / totalCommitment : 0
    const commitmentShare = totalCommitment > 0 ? commitment(ids, Q) / totalCommitment : 0

    for (const w of REPORTING_WINDOWS) {
      const start = windowStart[w]
      const before = beforeDate[w]
      const v = activity(ids, start, Q)
      if (before !== null) {
        const prior = activity(ids, null, before)
        const nav = capital.filter(p => ids.has(p.lpEntityId) && p.entryDate <= before).reduce((s, p) => s - p.amount, 0)
        v.set('beginning_nav', get(v, 'beginning_nav') + nav)
        const priorRecognized = Array.from(recognized(null, before).values()).reduce((s, a) => s + a, 0)
        const priorApplied = APPLIED_OFFSETS.reduce((s, k) => s + get(prior, k), 0)
        v.set('unapplied_beginning', priorRecognized * offsetShare - priorApplied)
      }
      for (const id of ids) carryFor(id, w, v)
      for (const [key, amount] of recognized(start, Q)) add(v, key, amount * offsetShare)

      // A.2
      const contributed = (to: string | null) => to === null ? 0
        : capital.filter(p => ids.has(p.lpEntityId) && p.entryDate <= to && bucketForSourceType(p.sourceType, p.amount) === 'contributions').reduce((s, p) => s - p.amount, 0)
      const recallable = (to: string | null) => to === null ? 0
        : capital.filter(p => ids.has(p.lpEntityId) && p.entryDate <= to && p.sourceType === RECYCLED_PROCEEDS_SOURCE && p.amount > 0).reduce((s, p) => s + p.amount, 0)
      const committed = commitment(ids, Q)
      v.set('total_commitment', committed)
      // ITD starts from the commitment as it stands (the template's H109 = F108), so a change to it
      // is in the beginning balance; a quarter or year starts from the unfunded balance the day before.
      const beginning = before === null ? committed : commitment(ids, before) - contributed(before) + recallable(before)
      v.set('beginning_unfunded', beginning)
      v.set('unfunded_contributions', -(contributed(Q) - contributed(before)))
      v.set('unfunded_recallable', recallable(Q) - recallable(before))
      if (before !== null) {
        const change = committed - commitment(ids, before)
        if (change < 0) v.set('unfunded_released', change)
        else v.set('unfunded_other', change)
      }

      // B.1
      for (const f of x.portfolioFees) {
        if (!inRange(f.date, start, Q)) continue
        const lineKey = PORTFOLIO_FEE_LINES[f.kind].fee
        const amount = allocation === 'partner' ? f.amount * commitmentShare
          : allocation === 'fund' ? f.amount
          : f.affiliatedAmount ?? 0
        add(v, lineKey, amount)
      }

      for (const [k, a] of v) v.set(k, roundCents(a))
      fillSubtotals(v)
      for (const [k, a] of v) v.set(k, roundCents(a))

      const column = { allocation, window: w }
      columns.push(column)
      valueSets.push(v)
      const books = roundCents(-capital.filter(p => ids.has(p.lpEntityId)).reduce((s, p) => s + p.amount, 0))
      ties.push({ column, books, difference: roundCents(get(v, 'ending_nav') - books) })
    }
  }

  const values = Object.fromEntries(REPORTING_LINES.map(l => [l.key, valueSets.map(v => get(v, l.key))])) as Record<ReportingLineKey, number[]>

  const offsetPercent: Partial<Record<ReportingLineKey, number>> = {}
  for (const [kind, share] of Object.entries(x.offsetShares) as [PortfolioFeeKind, number][]) {
    const key = PORTFOLIO_FEE_LINES[kind].offset
    offsetPercent[key] = Math.max(offsetPercent[key] ?? 0, share)
  }
  if (x.organizationalExpenseCap !== null) offsetPercent.offset_organization = 1

  // ── Footnotes ───────────────────────────────────────────────────────────
  const footnotes: string[] = []
  if (!x.closed) footnotes.push(`DRAFT. The books are not closed through ${Q}, so these figures can still change.`)
  if (x.bundleSha256) footnotes.push(`The figures are from the books as sealed at the close through ${Q} (close bundle SHA-256 ${x.bundleSha256}).`)
  const itd = (key: ReportingLineKey) => values[key][REPORTING_WINDOWS.indexOf('ITD') + 3]
  const otherAccounts = (category: AccountCategory) => Array.from(new Set(pnl.filter(l => l.category === category).map(l => l.accountName))).sort()
  for (const category of ['ext_other', 'related_other'] as const) {
    if (Math.abs(itd(category)) < 0.005) continue
    const names = otherAccounts(category)
    footnotes.push(`${REPORTING_LINE[category].label.replace(/^\(|\)\*$/g, '')}: ${names.length ? names.join('; ') : 'expenses allocated without an account'}. Give an expense account an ILPA category on its chart of accounts to move it to its own line.`)
  }
  const otherFees = x.portfolioFees.filter(f => f.kind === 'other' && f.date <= Q)
  if (otherFees.length) {
    footnotes.push(`Other Fees and Other Offsets: ${otherFees.map(f => `${f.date} ${money(f.amount)}${f.memo ? ` (${f.memo})` : ''}`).join('; ')}.`)
  } else if (Math.abs(itd('offset_other')) >= 0.005) {
    footnotes.push('Other Offsets: reimbursements the fee schedule offsets against the management fee.')
  }
  const unclassified = capital.filter(p => bucketForSourceType(p.sourceType, p.amount) === 'unclassified').reduce((s, p) => s - p.amount, 0)
  if (Math.abs(unclassified) >= 0.005) {
    footnotes.push(`${money(unclassified)} of capital movements have no type on the books (manual entries) and are shown in Other Investment Income.`)
  }
  if (Math.abs(totalLpCharged) >= 0.005 || carryPayouts.length) {
    footnotes.push(
      'Carried interest accrues as if the fund were liquidated at its net asset value. The earned part is the carry the realized profits alone would support (unrealized gains and currency translation left out); the rest is accrued. ' +
      "Both are in the NAV roll's gains, since the template's NAV roll has no carry line. A limited partner's share of carry paid, returned and held in escrow is its share of the carry charged.",
    )
  }
  if (capital.some(p => bucketForSourceType(p.sourceType, p.amount) === 'beginning')) {
    footnotes.push('Capital carried in as opening balances is in the beginning NAV; the contributions behind it are not on these books, so the unfunded commitment does not deduct them.')
  }
  footnotes.push(
    'Fees, expenses and income are split into their ILPA categories in proportion to the profit and loss each allocation came from, and each P&L account files under its ILPA category on the chart of accounts.',
    "Offsets are recognized when the portfolio-company fee is dated, at the share the fee schedule offsets, and shared among the partners in proportion to the management fee they bore. B.1 states the partner's share of fees in proportion to commitments.",
    ...x.notes,
    ILPA_REPORTING_ATTRIBUTION,
  )

  return {
    template: { name: 'ILPA Reporting Template', version: ILPA_REPORTING_VERSION },
    fund: x.fund,
    partner: x.partner,
    period: { quarterStart, quarterEnd: Q, yearStart },
    status: x.closed ? 'final' : 'draft',
    bundleSha256: x.bundleSha256,
    columns,
    values,
    offsetPercent,
    ties,
    footnotes,
  }
}

// ─── The sheet ─────────────────────────────────────────────────────────────────────────────────

type Cell = string | number | null

/** The report as rows for one worksheet, in the template's order. */
export function reportingSheetRows(r: IlpaReporting): Cell[][] {
  const name = (s: string) => s.replace('{partner}', r.partner.name)
  const rows: Cell[][] = []
  rows.push([`${r.template.name} (v. ${r.template.version})${r.status === 'draft' ? ' — DRAFT' : ''}`])
  rows.push([])
  rows.push(['Fund Name', r.fund.name])
  rows.push(['Vehicle', r.fund.vehicle])
  rows.push(['Investor', r.partner.name])
  rows.push(['Reporting Period', `${r.period.quarterStart} to ${r.period.quarterEnd}`])
  rows.push(['Fund Reporting Currency', r.fund.currency])
  rows.push([])

  const heads = (b: boolean): Cell[][] => [
    [null, ...REPORTING_ALLOCATIONS.flatMap(a => [name(REPORTING_ALLOCATION_LABEL[a][b ? 'b' : 'a']), null, null])],
    ['', ...REPORTING_ALLOCATIONS.flatMap(() => REPORTING_WINDOWS.map(w => w as string))],
  ]
  const section = (s: 'A.1' | 'A.2' | 'B.1', percent = false) => {
    for (const l of REPORTING_LINES) {
      if (l.section !== s) continue
      if (l.kind === 'heading') { rows.push([l.label]); continue }
      const row: Cell[] = [l.label, ...r.values[l.key]]
      if (percent && r.offsetPercent[l.key] !== undefined) row.push(r.offsetPercent[l.key]!)
      rows.push(row)
    }
  }

  rows.push([name(REPORTING_SECTION_TITLE.A)])
  rows.push([REPORTING_SECTION_TITLE['A.1']])
  rows.push(...heads(false))
  rows[rows.length - 2].push('% Offset')
  section('A.1', true)
  rows.push([])
  rows.push([REPORTING_SECTION_TITLE['A.2']])
  rows.push(...heads(false))
  section('A.2')
  rows.push([])
  rows.push([REPORTING_SECTION_TITLE.B])
  rows.push([REPORTING_SECTION_TITLE['B.1']])
  rows.push(...heads(true))
  section('B.1')
  rows.push([])

  const off = r.ties.filter(t => Math.abs(t.difference) >= 0.01)
  if (off.length) {
    rows.push(['Check: the NAV roll does not end at the capital on the books'])
    for (const t of off) rows.push([`${t.column.allocation} ${t.column.window}`, t.difference])
    rows.push([])
  }
  rows.push(['Footnotes'])
  r.footnotes.forEach((f, i) => rows.push([`${i + 1}. ${f}`]))
  return rows
}
