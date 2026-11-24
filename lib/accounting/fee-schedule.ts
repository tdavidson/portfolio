// A vehicle's dated management fee schedule, and the fee it charges for a period.
//
// The fee used to be one rate on commitments for whatever fraction of a year the person booking it
// typed (allocation-actions.ts). An LPA states it on dates: quarterly in advance, 2% of commitments
// until the end of the investment period, then 1.5% of invested capital, less organizational
// expenses above a cap. The schedule stores that wording (`vehicle_accounting_settings.fee_schedule`)
// and the fund engine's `feeSchedule` runs it, the reading the Walter spec takes
// (spec/07-management-fees.md). This module only reads the books into its facts:
//
//   - commitments from `lp_investments`, with the partners the Allocation terms page exempts from
//     the management fee left out of the fee-bearing set;
//   - invested capital from the vehicle's investment and proceeds transactions (the same deal
//     histories the deal-by-deal waterfall reads), a deal's cost leaving when a proceeds row
//     exits it or its company is closed out;
//   - NAV as the partners' capital accounts on each period's first day;
//   - organizational expenses as the close has allocated them to the partners.
//
// Portfolio-company fees aren't in the fund's books (the GP or the management company is paid them),
// so they're recorded separately (`portfolio_company_fees`, lib/accounting/portfolio-fees.ts), and
// the schedule's `offsets` say what share of each kind credits the fee.
//
// Side letters charge their own rate. A partner with a rate override pays it in place of the
// schedule's rate on every step that charges one (a step at 0 stays 0), on its own commitment's
// basis, so a side letter lowers the fee rather than only moving it between partners. The engine
// runs each override as a fee group (`feeSchedule` `groups`), so the period's gross is the sum and an
// offset reduces each group's fee in proportion to its share of it.

import type { SupabaseClient } from '@supabase/supabase-js'
import { addMonths, allocateAmount, feeSchedule, roundCents, type FeeFrequency, type FeeScheduleBasis, type FeeScheduleFacts, type FeeSchedulePeriod } from '@portfolio/fund-engine'
import { computeCapitalAccounts } from './capital-account'
import { loadOwnership, loadPostedLedger } from './load'
import { loadPartnerTerms } from './terms'
import { dealHistories } from './realized-capital'
import { vehicleIdByName } from './vehicle-id'
import { loadPortfolioFees, PORTFOLIO_FEE_KINDS, type PortfolioFeeKind } from './portfolio-fees'
import type { FeeResult } from './fees'

export interface StoredFeeSchedule {
  frequency: FeeFrequency
  /** YYYY-MM-DD, the first period's first day. */
  start: string
  /** YYYY-MM-DD, exclusive: the day the fee stops. */
  end: string
  /** Each step from its date, in order. */
  steps: { from: string; rate: number; basis: FeeScheduleBasis }[]
  /** Organizational expenses above this offset the fee dollar for dollar. Absent: no cap. */
  organizationalExpenseCap?: number
  /** Share (0 to 1) of each kind of portfolio-company fee that offsets the fee. Absent: none. */
  offsets?: Partial<Record<PortfolioFeeKind, number>>
  /** When each period's fee falls due: its first day (advance, the default) or its last (arrears). */
  timing?: 'advance' | 'arrears'
  /**
   * What happens on a period's due date (lib/accounting/fee-periods.ts): nothing (off, the default),
   * draft entries and a draft invoice for an admin to post, or posted entries and an issued invoice.
   */
  postMode?: 'off' | 'draft' | 'post'
  /** Book each period's fee month by month (at each month's end) rather than all on its due date. */
  monthlyAccrual?: boolean
  /** Book the management company's side too when one is linked to this fund. Default true. */
  bookManagerSide?: boolean
  /** Days before a due date that the reminder digest lists an unposted fee. Default 5. */
  reminderDays?: number
}

const FREQUENCIES: FeeFrequency[] = ['quarterly', 'semiannual', 'annual']
const BASES: FeeScheduleBasis[] = ['commitments', 'invested', 'nav']
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Check a schedule without touching the database. Null clears it. */
export function parseFeeScheduleInput(raw: unknown): { ok: true; value: StoredFeeSchedule | null } | { error: string } {
  if (raw == null) return { ok: true, value: null }
  if (typeof raw !== 'object') return { error: 'The fee schedule must be an object.' }
  const s = raw as Record<string, unknown>
  if (!FREQUENCIES.includes(s.frequency as FeeFrequency)) return { error: 'The fee is charged quarterly, semiannually or annually.' }
  if (typeof s.start !== 'string' || !DATE.test(s.start)) return { error: 'The fee schedule needs a start date (YYYY-MM-DD).' }
  if (typeof s.end !== 'string' || !DATE.test(s.end) || s.end <= s.start) return { error: 'The fee schedule needs an end date after its start.' }
  if (!Array.isArray(s.steps) || s.steps.length === 0) return { error: 'The fee schedule needs at least one rate.' }
  const steps: StoredFeeSchedule['steps'] = []
  for (const raw of s.steps as any[]) {
    const rate = Number(raw?.rate)
    if (typeof raw?.from !== 'string' || !DATE.test(raw.from)) return { error: 'Each rate starts on a date (YYYY-MM-DD).' }
    if (!(rate >= 0 && rate <= 0.2)) return { error: 'Each rate is an annual fraction between 0 and 0.2 (0.02 = 2%).' }
    if (!BASES.includes(raw?.basis)) return { error: 'Each rate is charged on commitments, invested capital or NAV.' }
    steps.push({ from: raw.from, rate, basis: raw.basis })
  }
  steps.sort((a, b) => a.from.localeCompare(b.from))
  if (steps[0].from > s.start) return { error: 'The first rate must start on or before the schedule does.' }
  if (new Set(steps.map(x => x.from)).size !== steps.length) return { error: 'Two rates start on the same date.' }
  const cap = s.organizationalExpenseCap == null || s.organizationalExpenseCap === '' ? undefined : Number(s.organizationalExpenseCap)
  if (cap !== undefined && !(cap >= 0)) return { error: 'The organizational expense cap must be zero or more.' }
  let offsets: StoredFeeSchedule['offsets']
  if (s.offsets != null) {
    if (typeof s.offsets !== 'object' || Array.isArray(s.offsets)) return { error: 'The offsets are a share for each kind of portfolio-company fee.' }
    for (const [kind, raw] of Object.entries(s.offsets as Record<string, unknown>)) {
      if (!PORTFOLIO_FEE_KINDS.includes(kind as PortfolioFeeKind)) return { error: `"${kind}" is not a kind of portfolio-company fee.` }
      if (raw == null || raw === '') continue
      const share = Number(raw)
      if (!(share >= 0 && share <= 1)) return { error: 'Each offset is a share between 0 and 1 (1 = 100%).' }
      if (share > 0) (offsets ??= {})[kind as PortfolioFeeKind] = share
    }
  }
  if (s.timing != null && s.timing !== 'advance' && s.timing !== 'arrears') return { error: 'The fee is due in advance or in arrears.' }
  if (s.postMode != null && !['off', 'draft', 'post'].includes(s.postMode as string)) return { error: 'postMode is off, draft or post.' }
  const reminderDays = s.reminderDays == null || s.reminderDays === '' ? undefined : Number(s.reminderDays)
  if (reminderDays !== undefined && !(Number.isInteger(reminderDays) && reminderDays >= 0 && reminderDays <= 60)) return { error: 'reminderDays is a whole number of days from 0 to 60.' }
  return {
    ok: true,
    value: {
      frequency: s.frequency as FeeFrequency,
      start: s.start,
      end: s.end,
      steps,
      ...(cap !== undefined ? { organizationalExpenseCap: cap } : {}),
      ...(offsets ? { offsets } : {}),
      ...(s.timing === 'arrears' ? { timing: 'arrears' as const } : {}),
      ...(s.postMode === 'draft' || s.postMode === 'post' ? { postMode: s.postMode } : {}),
      ...(s.monthlyAccrual === true ? { monthlyAccrual: true } : {}),
      ...(s.bookManagerSide === false ? { bookManagerSide: false } : {}),
      ...(reminderDays !== undefined ? { reminderDays } : {}),
    },
  }
}

export async function loadFeeSchedule(admin: SupabaseClient, fundId: string, group: string): Promise<StoredFeeSchedule | null> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return null
  const { data } = await (admin as any).from('vehicle_accounting_settings').select('fee_schedule').eq('fund_id', fundId).eq('vehicle_id', vehicleId).maybeSingle()
  const parsed = parseFeeScheduleInput(data?.fee_schedule ?? null)
  return 'ok' in parsed ? parsed.value : null
}

export async function saveFeeSchedule(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  raw: unknown,
): Promise<{ ok: true; schedule: StoredFeeSchedule | null } | { error: string; status: number; dbError?: { message: string } }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: `Unknown vehicle "${group}".`, status: 400 }
  const parsed = parseFeeScheduleInput(raw)
  if ('error' in parsed) return { error: parsed.error, status: 400 }
  const { error } = await (admin as any)
    .from('vehicle_accounting_settings')
    .upsert({ fund_id: fundId, vehicle_id: vehicleId, fee_schedule: parsed.value, updated_at: new Date().toISOString() }, { onConflict: 'fund_id,vehicle_id' })
  if (error) return { error: 'The fee schedule could not be saved.', status: 500, dbError: error }
  return { ok: true, schedule: parsed.value }
}

export interface ScheduledFee {
  period: FeeSchedulePeriod
  /** The schedule's rate in force on the period's first day, which side letters are measured against. */
  rate: number
  fee: FeeResult
}

/**
 * The fee the schedule charges for the period that `date` falls in, shared across the partners.
 * Null when `date` is outside the schedule.
 */
export async function scheduledFee(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  date: string,
  overrides: Record<string, { rateOverride?: number; exempt?: boolean }> = {},
): Promise<ScheduledFee | { error: string } | null> {
  const schedule = await loadFeeSchedule(admin, fundId, group)
  if (!schedule) return { error: `${group} has no fee schedule. Set one on the Allocation terms page, or give a rate.` }
  if (date < schedule.start || date >= schedule.end) return null
  const inputs = await loadScheduleInputs(admin, fundId, group, schedule, overrides)
  if ('error' in inputs) return inputs
  return chargeScheduledFee(schedule, inputs.payers, date, inputs.facts)
}

/** What the schedule reads from the books: the fee-bearing partners and the dated facts. */
export async function loadScheduleInputs(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  schedule: StoredFeeSchedule,
  overrides: Record<string, { rateOverride?: number; exempt?: boolean }> = {},
): Promise<{ payers: SchedulePayer[]; facts: Omit<FeeScheduleFacts, 'feeBearingCommitments' | 'allCommitments'>; ledger: Awaited<ReturnType<typeof loadPostedLedger>> } | { error: string }> {
  const [owners, terms, ledger, txns, companies, portfolioFees] = await Promise.all([
    loadOwnership(admin, fundId, group),
    loadPartnerTerms(admin, fundId, group),
    loadPostedLedger(admin, fundId, group),
    admin.from('investment_transactions' as any)
      .select('company_id, portfolio_group, transaction_type, transaction_date, investment_cost, fee_amount, cost_basis_exited')
      .eq('fund_id', fundId).eq('portfolio_group', group),
    admin.from('companies' as any).select('id, status').eq('fund_id', fundId),
    schedule.offsets ? loadPortfolioFees(admin, fundId, group, schedule.end) : Promise.resolve([]),
  ])
  if (txns.error || companies.error) return { error: 'The deals could not be read, so the fee on invested capital cannot be worked out.' }
  if ('error' in portfolioFees) return { error: 'The portfolio-company fees could not be read, so their offsets cannot be worked out.' }

  const feeTerms = new Map(terms.filter(t => t.category === 'management_fee').map(t => [t.lpEntityId, t]))
  const payers = owners.filter(o => o.commitment > 0).map(o => {
    const configured = feeTerms.get(o.lpEntityId)
    return {
      lpEntityId: o.lpEntityId,
      commitment: o.commitment,
      rateOverride: overrides[o.lpEntityId]?.rateOverride ?? configured?.rateOverride ?? null,
      exempt: overrides[o.lpEntityId]?.exempt ?? (configured ? !configured.participates : false),
    }
  })

  const deals = dealHistories((txns.data as any[]) ?? [], (companies.data as any[]) ?? [], group, schedule.end)
  const investments = deals.flatMap(d => d.investments.map(i => ({ date: i.date, deal: d.companyId, amount: i.amount })))
  const exits = deals.flatMap(d => [
    ...d.realizations.map(r => ({ date: r.date, deal: d.companyId, ...(r.costExited != null ? { cost: r.costExited } : {}) })),
    ...(d.closedOn ? [{ date: d.closedOn, deal: d.companyId }] : []),
  ])

  // NAV on each day the schedule could read it: every period start and step date.
  const days = new Set<string>(schedule.steps.map(s => s.from))
  const step = { quarterly: 3, semiannual: 6, annual: 12 }[schedule.frequency]
  for (let d = schedule.start; d < schedule.end; d = addMonths(d, step)) days.add(d)
  const navs = schedule.steps.some(s => s.basis === 'nav')
    ? [...days].sort().map(day => ({
        date: day,
        amount: roundCents([...computeCapitalAccounts(ledger.capitalPostings, { end: day }).values()].reduce((s, a) => s + a.ending, 0)),
      }))
    : []
  const organizationalExpenses = ledger.capitalPostings
    .filter(p => p.sourceType === 'organizational_expense' && p.entryDate && p.amount > 0)
    .map(p => ({ date: p.entryDate!, amount: p.amount }))

  return {
    payers,
    ledger,
    facts: {
      investments,
      exits,
      navs,
      organizationalExpenses,
      portfolioFees: portfolioFees.map(f => ({ date: f.date, kind: f.kind, amount: f.amount })),
    },
  }
}

/** One period of the schedule as the admin sees it: what it charges, and what the books hold for it. */
export interface FeeSchedulePeriodRow {
  start: string
  /** Exclusive. */
  end: string
  /** The rate and basis in force on the period's first day. */
  rate: number
  basis: FeeScheduleBasis
  gross: number
  offset: number
  /** What the schedule charges for the period, after offsets and side letters. */
  net: number
  /** Management fee expense net of offsets (5000 and 5010) posted with an entry date inside the period. */
  booked: number
  /** booked vs net: 'booked' within a dollar, 'partial', 'unbooked' for a past or current period, 'upcoming' before it starts. */
  status: 'booked' | 'partial' | 'unbooked' | 'over' | 'upcoming'
  /** The posted entries counted in `booked`. */
  entryIds: string[]
}

/**
 * Every period of the vehicle's fee schedule, each with the fee it charges and what has been booked
 * against it. What an admin reads to see what is due and what is missing; nothing is written.
 */
export async function feeSchedulePeriods(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<{ schedule: StoredFeeSchedule | null; periods: FeeSchedulePeriodRow[] } | { error: string }> {
  const schedule = await loadFeeSchedule(admin, fundId, group)
  if (!schedule) return { schedule: null, periods: [] }
  const inputs = await loadScheduleInputs(admin, fundId, group, schedule)
  if ('error' in inputs) return inputs
  // Net of offsets: the fee expense (5000) and its contra (5010), as a booked period posts them.
  const feeAccounts = new Set(inputs.ledger.accounts.filter(a => a.code === '5000' || a.code === '5010').map(a => a.id))
  const feePostings = inputs.ledger.sourcedPostings.filter(p => feeAccounts.has(p.accountId))

  const step = { quarterly: 3, semiannual: 6, annual: 12 }[schedule.frequency]
  const rows: FeeSchedulePeriodRow[] = []
  for (let d = schedule.start; d < schedule.end; d = addMonths(d, step)) {
    const charged = chargeScheduledFee(schedule, inputs.payers, d, inputs.facts)
    if (!charged) continue
    const { period } = charged
    const inPeriod = feePostings.filter(p => p.entryDate && p.entryDate >= period.start && p.entryDate < period.end)
    const booked = roundCents(inPeriod.reduce((s, p) => s + p.amount, 0))
    const net = charged.fee.total
    const stepNow = [...schedule.steps].reverse().find(st => st.from <= period.start) ?? schedule.steps[0]
    const status: FeeSchedulePeriodRow['status'] = period.start > today
      ? (booked > 0 ? 'partial' : 'upcoming')
      : Math.abs(booked - net) <= 1 ? 'booked' : booked > net ? 'over' : booked > 0 ? 'partial' : 'unbooked'
    rows.push({
      start: period.start, end: period.end, rate: stepNow.rate, basis: stepNow.basis,
      gross: roundCents(period.gross), offset: roundCents(period.offset), net,
      booked, status, entryIds: Array.from(new Set(inPeriod.map(p => p.entryId).filter((id): id is string => !!id))),
    })
  }
  return { schedule, periods: rows }
}

/** A partner the schedule may charge. */
export interface SchedulePayer {
  lpEntityId: string
  commitment: number
  /** A side letter's annual rate, in place of the schedule's. */
  rateOverride: number | null
  /** Pays no management fee. */
  exempt: boolean
}

/**
 * The fee the schedule charges for the period that `date` falls in, each partner on its own rate:
 * the schedule's, or its side letter's on every step that charges one. Null when `date` is outside
 * the schedule. Pure, so the side-letter arithmetic can be tested without the books.
 */
export function chargeScheduledFee(
  schedule: StoredFeeSchedule,
  payers: SchedulePayer[],
  date: string,
  facts: Omit<FeeScheduleFacts, 'feeBearingCommitments' | 'allCommitments'>,
): ScheduledFee | null {
  if (date < schedule.start || date >= schedule.end) return null
  const bearing = payers.filter(p => !p.exempt)
  // One fee group per rate: the schedule's, and each side-letter rate.
  const rates = [null, ...new Set(bearing.map(p => p.rateOverride).filter((r): r is number => r != null))]
  const groups = rates
    .map(r => {
      const members = bearing.filter(p => p.rateOverride === r)
      return {
        members,
        commit: members.reduce((s, p) => s + p.commitment, 0),
        steps: r == null ? schedule.steps : schedule.steps.map(st => ({ ...st, rate: st.rate > 0 ? r : 0 })),
      }
    })
    .filter(g => g.members.length > 0)
  const periods = feeSchedule({
    frequency: schedule.frequency,
    start: schedule.start,
    end: schedule.end,
    steps: schedule.steps,
    groups: groups.map(g => ({ steps: g.steps, feeBearingCommitments: g.commit })),
    ...(schedule.organizationalExpenseCap !== undefined ? { organizationalExpenseCap: schedule.organizationalExpenseCap } : {}),
    ...(schedule.offsets ? { offsets: schedule.offsets as Record<string, number> } : {}),
  }, {
    ...facts,
    feeBearingCommitments: bearing.reduce((s, p) => s + p.commitment, 0),
    allCommitments: payers.reduce((s, p) => s + p.commitment, 0),
  })
  const period = periods.find(p => p.start <= date && date < p.end)
  if (!period) return null

  const rate = [...schedule.steps].reverse().find(s => s.from <= period.start)?.rate ?? 0
  // Each partner's exact share of its group's net, rounded so the lines add up to the period's net.
  const owed = new Map<string, number>()
  groups.forEach((g, k) => {
    for (const p of g.members) owed.set(p.lpEntityId, g.commit > 0 ? ((period.groupNet?.[k] ?? 0) * p.commitment) / g.commit : 0)
  })
  const shares = allocateAmount(period.net, bearing.map(p => ({ lpEntityId: p.lpEntityId, commitment: owed.get(p.lpEntityId) ?? 0 })))
  const lines = payers.map(p => ({
    lpEntityId: p.lpEntityId,
    basisAmount: p.commitment,
    rate: p.exempt ? 0 : (p.rateOverride != null && rate > 0 ? p.rateOverride : rate),
    fee: p.exempt ? 0 : (shares.get(p.lpEntityId) ?? 0),
  }))
  return { period, rate, fee: { lines, total: roundCents(lines.reduce((s, l) => s + l.fee, 0)) } }
}

