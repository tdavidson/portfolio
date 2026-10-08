import type { FundPosition, NavBasis } from './fof-metrics'

/**
 * Period-end valuation for a fund of funds. Pure.
 *
 * The mark is BOOKED WHEN A NAV IS SAVED (lib/portfolio/fof-nav.ts) — at the statement's as-of date,
 * against what the ledger carries then — and RE-BOOKED when something later changes that carrying
 * value: a call confirmed after the statement but dated before it, or an edit to an earlier
 * statement. This module computes the marks and, for the close, the blockers: a position whose
 * ledger value disagrees with its rolled-forward NAV at period end means a statement was never
 * booked or a notice is still unconfirmed.
 */

const CENT = 0.005

/**
 * How stale a manager NAV may be before the close warns. Managers report 45-90 days after
 * quarter end, so "more than one quarter, with slack for one who reports on day 95".
 * Exported because the schedule of investments flags the same threshold — two surfaces
 * disagreeing about what counts as stale is worse than either number being wrong.
 */
export const STALE_NAV_DAYS = 100

export interface PendingMark {
  companyId: string
  name: string
  periodEnd: string
  derivedCarrying: number
  ledgerCarrying: number
  /** What to book as unrealized_value_change. */
  delta: number
}

export function periodEndMarks(
  positions: FundPosition[],
  ledgerCarrying: Map<string, number>,
  periodEnd: string,
): PendingMark[] {
  const marks: PendingMark[] = []
  for (const p of positions) {
    // Absent from the ledger = carrying zero. A holding whose history was all memo-only
    // (before ledger_start_date) has no balance yet and still needs its first mark.
    const carried = ledgerCarrying.get(p.companyId) ?? 0
    const delta = p.carryingValue - carried
    if (Math.abs(delta) < CENT) continue
    marks.push({
      companyId: p.companyId,
      name: p.name,
      periodEnd,
      derivedCarrying: p.carryingValue,
      ledgerCarrying: carried,
      delta,
    })
  }
  return marks
}

/**
 * Holdings with a DRAFT capital event dated after their newest NAV and on or before the period
 * end. The roll-forward counts drafts, so a gap caused by one is a notice nobody confirmed — a
 * blocker — and not just a manager who has not reported yet. `events` are raw fund_capital_events
 * rows, already scoped to the entity.
 */
export function companiesWithPendingNotices(
  positions: FundPosition[],
  events: { company_id: string; event_date: string; status?: string | null }[],
  periodEnd: string,
): Set<string> {
  const navAsOf = new Map(positions.map(p => [p.companyId, p.navAsOf]))
  const out = new Set<string>()
  for (const e of events) {
    if (e.status !== 'draft' || e.event_date > periodEnd) continue
    const nav = navAsOf.get(e.company_id)
    if (nav && e.event_date > nav) out.add(e.company_id)
  }
  return out
}

/**
 * The fund-of-funds half of the pre-close check, as a PURE function so it can be exercised
 * without a database — `lib/accounting/close.ts` loads the inputs and splices the result into
 * its existing `blockers` / `warnings` arrays. No new rule engine: `closeThrough` already
 * refuses to close when `blockers` is non-empty.
 *
 * The severity split is the whole point. A value the ledger does not carry BLOCKS (a statement
 * never saved, or a notice still unconfirmed), because the ledger is the
 * control total for the schedule of investments and closing without it publishes a NAV no
 * posting supports. A stale manager NAV only WARNS, because reporting 45-90 days late is
 * normal — blocking on it would make a fund of funds unclosable by construction.
 */
export function fofCloseIssues(
  positions: FundPosition[],
  ledgerCarrying: Map<string, number>,
  periodEnd: string,
  /** Holdings with an unconfirmed notice dated after their newest NAV — see companiesWithPendingNotices. */
  pendingNotices: ReadonlySet<string> = new Set(),
): { blockers: string[]; warnings: string[] } {
  const blockers: string[] = []
  const warnings: string[] = []

  const byId = new Map(positions.map(p => [p.companyId, p]))
  for (const m of periodEndMarks(positions, ledgerCarrying, periodEnd)) {
    const p = byId.get(m.companyId)
    // The ledger carries exactly the newest statement, and the whole gap is the cash flow dated
    // after it: nothing is unbooked, the manager just has not reported past that flow yet.
    // Blocking would make every quarter-end with a late statement unclosable.
    if (p && p.reportedNav !== null && !pendingNotices.has(m.companyId) && Math.abs(m.ledgerCarrying - p.reportedNav) < CENT) {
      warnings.push(
        `Waiting on the manager's statement for ${m.name} — its value is the last statement plus the flows since.`,
      )
      continue
    }
    blockers.push(
      `${m.name}: the ledger carries ${m.ledgerCarrying.toFixed(2)} but the position values `
      + `at ${m.derivedCarrying.toFixed(2)} as of ${periodEnd}. `
      + `Record the manager's statement for this period, or confirm the notices since it.`,
    )
  }

  for (const p of positions) {
    if (p.stalenessDays === null) {
      warnings.push(`${p.name}: no manager statement has been received; carried at cost.`)
    } else if (p.stalenessDays > STALE_NAV_DAYS) {
      warnings.push(
        `${p.name}: newest NAV is as of ${p.navAsOf} (${p.stalenessDays} days before ${periodEnd}).`,
      )
    }
  }

  return { blockers, warnings }
}

export interface ValuationBasisRow {
  name: string
  navAsOf: string | null
  basis: NavBasis | 'unreported'
  stalenessDays: number | null
  carryingValue: number
  /** True when carrying value differs from the reported NAV — i.e. cash flows were rolled in. */
  rolledForward: boolean
}

/**
 * The disclosure an auditor asks for by name: which valuation each position carries, struck
 * when, on what basis, and whether we adjusted it. Generated, because a typed version of this
 * table is stale the first time a statement is restated.
 */
export function valuationBasisNote(positions: FundPosition[]): ValuationBasisRow[] {
  return positions.map(p => ({
    name: p.name,
    navAsOf: p.navAsOf,
    basis: p.navBasis ?? 'unreported',
    stalenessDays: p.stalenessDays,
    carryingValue: p.carryingValue,
    rolledForward: p.reportedNav !== null && Math.abs(p.carryingValue - p.reportedNav) >= CENT,
  }))
}

export interface ManagerStatementFigures {
  companyId: string
  reportedContributions: number | null
  reportedDistributions: number | null
  reportedUnfunded: number | null
}

export interface TieOutRow {
  name: string
  field: 'contributions' | 'distributions' | 'unfunded'
  ours: number
  theirs: number
  /** ours − theirs. Negative means the manager counts more than we do. */
  difference: number
}

/**
 * Our register against the manager's own since-inception figures. A gap on contributions is
 * almost always a call notice that never reached us — which is exactly the error a quarterly
 * close is supposed to catch and a spreadsheet never does.
 */
export function managerTieOut(
  positions: FundPosition[],
  statements: ManagerStatementFigures[],
): TieOutRow[] {
  const byCompany = new Map(statements.map(s => [s.companyId, s]))
  const rows: TieOutRow[] = []

  for (const p of positions) {
    const s = byCompany.get(p.companyId)
    if (!s) continue
    const compare = (field: TieOutRow['field'], ours: number, theirs: number | null | undefined) => {
      if (theirs === null || theirs === undefined) return   // manager did not report it
      const difference = ours - theirs
      if (Math.abs(difference) < CENT) return
      rows.push({ name: p.name, field, ours, theirs, difference })
    }
    compare('contributions', p.contributed, s.reportedContributions)
    compare('distributions', p.distributed, s.reportedDistributions)
    compare('unfunded', p.unfunded, s.reportedUnfunded)
  }
  return rows
}
