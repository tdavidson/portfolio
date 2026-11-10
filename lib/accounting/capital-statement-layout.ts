// The layout of a partner's capital account statement: which rows, in what order, with what
// figures in each column. Shared by the PDF (lp-statement-pdf.ts) and the web view
// (funds/capital-accounts/[lpEntityId]/view.tsx) so the two can't drift. Pure: no I/O, safe to
// import from a client component.
//
// Up to three columns, left to right: the statement period, year to date, inception to date. A
// column that would only repeat another is left out (statementColumns). The statement is the
// roll-forward and the commitment summary, and ends there.

import { ACTIVITY_FIELDS, CAPITAL_ACCOUNT_LABELS, type CapitalAccount } from './capital-account'
import { ytdWindow } from './statement-period'
import type { StatementBasis } from './statement-basis'

export const STATEMENT_COLUMNS = ['Statement period', 'Year to date', 'Inception to date'] as const

/**
 * The columns a statement for `period` prints, left to right, leaving out any that would repeat
 * another: an inception-to-date statement (no start date) drops the statement-period column, and
 * one whose period IS year to date (the YTD preset, or a Q1 statement) drops the year-to-date one.
 */
export function statementColumns<T>(
  period: { start?: string | null; end?: string | null },
  values: { period: T; ytd: T; itd: T },
  today: Date = new Date(),
): { label: (typeof STATEMENT_COLUMNS)[number]; value: T }[] {
  const ytd = ytdWindow(period, today)
  const periodIsYtd = period.start === ytd.start && (period.end ?? ytd.end) === ytd.end
  return [
    ...(period.start ? [{ label: STATEMENT_COLUMNS[0], value: values.period }] : []),
    ...(periodIsYtd ? [] : [{ label: STATEMENT_COLUMNS[1], value: values.ytd }]),
    { label: STATEMENT_COLUMNS[2], value: values.itd },
  ]
}

/** The roll-forward lines that make up the partner's profit and loss, in statement order. Carried
 *  interest stays outside: it reallocates profit between partners rather than earning it. */
export const PNL_FIELDS: (keyof CapitalAccount)[] = [
  'managementFees', 'expenses', 'operatingIncome', 'realizedGains', 'unrealizedGains', 'fxTranslation',
]
/** Capital movements printed above the profit and loss lines. */
const PRE_PNL_FIELDS: (keyof CapitalAccount)[] = ['contributions', 'distributions']

export type StatementRowStyle = 'plain' | 'total'

export interface StatementRow {
  key: string
  label: string
  values: number[]
  style: StatementRowStyle
}

/**
 * The roll-forward rows for the given columns. A line shows only if it moved in ANY column (an SPV
 * shouldn't print four empty rows). Contributions and distributions come first, then the partner's
 * share of fees, expenses, income and gains, then the rest. Every line sits at the same level and
 * they sum to ending capital; there is no net profit or loss subtotal (not a line LPs are used to).
 */
export function rollForwardRows(accounts: CapitalAccount[]): StatementRow[] {
  const lines = ACTIVITY_FIELDS.filter(f => accounts.some(a => Math.abs(a[f]) > 0.004))
  const row = (f: keyof CapitalAccount, style: StatementRowStyle = 'plain'): StatementRow =>
    ({ key: f, label: CAPITAL_ACCOUNT_LABELS[f], values: accounts.map(a => a[f]), style })
  return [
    row('beginning'),
    ...lines.filter(f => !PNL_FIELDS.includes(f) && PRE_PNL_FIELDS.includes(f)).map(f => row(f)),
    ...lines.filter(f => PNL_FIELDS.includes(f)).map(f => row(f)),
    ...lines.filter(f => !PNL_FIELDS.includes(f) && !PRE_PNL_FIELDS.includes(f)).map(f => row(f)),
    row('ending', 'total'),
  ]
}

/** The commitment summary's last line names the basis: off fair value it is not the NAV. */
const ENDING_LABELS: Record<StatementBasis, string> = {
  fair_value: 'Ending capital (NAV)',
  cost: 'Ending capital (cost basis)',
  cash_only: 'Ending capital (contributions and income)',
}

export interface SummaryRow {
  label: string
  /** One per column; null is a blank cell. */
  values: (number | null)[]
  format: 'money' | 'percent'
}

/**
 * The commitment summary, laid out in the roll-forward's columns.
 *
 * Capital is recognized when it is CALLED, not when the cash lands — which is why "Called capital"
 * is the headline and matches the contributions line in the roll-forward. The receivable gets its
 * own line whenever there is one. Capital called is a flow, so it has a figure for each column; the
 * rest are balances at the period end and sit under inception to date only.
 */
export function commitmentSummaryRows(
  accounts: CapitalAccount[],
  row: { commitment: number; called: number | null; outstanding: number | null; receivable: number | null; ending: number | null },
  ownership: number,
  basis: StatementBasis = 'fair_value',
): SummaryRow[] {
  const last = (v: number | null): (number | null)[] => [...accounts.slice(1).map(() => null), v]
  return [
    { label: 'Commitment', values: last(row.commitment), format: 'money' },
    { label: 'Called capital', values: [...accounts.slice(0, -1).map(a => a.contributions), row.called], format: 'money' },
    ...(Math.abs(row.receivable ?? 0) > 0.004
      ? [{ label: '— of which not yet funded', values: last(row.receivable), format: 'money' as const }]
      : []),
    { label: 'Remaining to be called', values: last(row.outstanding), format: 'money' },
    { label: 'Ownership', values: last(ownership), format: 'percent' },
    { label: ENDING_LABELS[basis], values: last(row.ending), format: 'money' },
  ]
}
