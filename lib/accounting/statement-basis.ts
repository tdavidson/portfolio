// The basis a partner's capital account statement is presented on. A REPORTING FILTER only: the
// ledger and the close's allocations are untouched, and every basis is read from the same postings.
//
//   fair_value  — the books as they stand (the default): every allocation, marks included.
//   cost        — leaves out the partner's share of unrealized appreciation and the currency
//                 translation of unrealized value. Realized gains and losses stay: the books realize
//                 them on cost too (proceeds reduce cost until it is recovered; the excess is gain).
//   cash_only   — also leaves out realized gains and losses (write-offs included), so what is left is
//                 contributions, distributions, fees, expenses and operating income.
//
// The filter drops the excluded postings BEFORE the roll-forward is built, so every column follows:
// a period's beginning balance is the prior period's ending on the same basis (not fair value less
// this period's marks), and the statement foots:
//
//   ending(cost)      = ending(fair value) − ITD unrealized − ITD FX translation
//   ending(cash_only) = ending(cost)       − ITD realized
//
// Pure: no I/O, safe to import from a client component.

import { bucketForSourceType, type CapitalAccount, type CapitalPosting } from './capital-account'

export const STATEMENT_BASES = ['fair_value', 'cost', 'cash_only'] as const
export type StatementBasis = (typeof STATEMENT_BASES)[number]
export const DEFAULT_STATEMENT_BASIS: StatementBasis = 'fair_value'

/** The roll-forward lines each basis leaves out. */
export const BASIS_EXCLUDED_LINES: Record<StatementBasis, (keyof CapitalAccount)[]> = {
  fair_value: [],
  cost: ['unrealizedGains', 'fxTranslation'],
  cash_only: ['unrealizedGains', 'fxTranslation', 'realizedGains'],
}

/** The toggle's labels. */
export const BASIS_LABELS: Record<StatementBasis, string> = {
  fair_value: 'Fair value',
  cost: 'Cost basis',
  cash_only: 'Contributions and income only',
}

/** The line printed on the statement so an LP can tell which version they hold. Null on fair value,
 *  which is the statement as it has always been. */
export const BASIS_NOTES: Record<StatementBasis, string | null> = {
  fair_value: null,
  cost: 'Presented on a cost basis; excludes unrealized appreciation.',
  cash_only: 'Presented on contributions and income only; excludes realized and unrealized gains and losses.',
}

export function isStatementBasis(v: unknown): v is StatementBasis {
  return typeof v === 'string' && (STATEMENT_BASES as readonly string[]).includes(v)
}

/**
 * A requested basis, or the fallback when none was asked for. Anything else is an error rather than
 * a silent fair-value statement: a cost statement sent out as fair value is the mistake to prevent.
 */
export function parseStatementBasis(v: unknown, fallback: StatementBasis = DEFAULT_STATEMENT_BASIS): StatementBasis | { error: string } {
  if (v === undefined || v === null || v === '') return fallback
  if (isStatementBasis(v)) return v
  return { error: `basis must be one of ${STATEMENT_BASES.join(', ')}` }
}

/** Whether a posting to a partner's capital survives the basis. Keyed on the same line the
 *  roll-forward files it under (bucketForSourceType), so the filter and the statement can't disagree. */
export function postingInBasis(p: Pick<CapitalPosting, 'sourceType' | 'amount'>, basis: StatementBasis): boolean {
  const excluded = BASIS_EXCLUDED_LINES[basis]
  return excluded.length === 0 || !excluded.includes(bucketForSourceType(p.sourceType, p.amount))
}

/** The postings a statement on `basis` is built from. */
export function postingsForBasis<T extends Pick<CapitalPosting, 'sourceType' | 'amount'>>(postings: T[], basis: StatementBasis): T[] {
  return basis === 'fair_value' ? postings : postings.filter(p => postingInBasis(p, basis))
}

/** What the basis took out of a fair-value roll-forward: the excluded lines, summed. Fair-value
 *  ending less this is the basis's ending, which is the footing check. */
export function basisExclusion(account: CapitalAccount, basis: StatementBasis): number {
  const sum = BASIS_EXCLUDED_LINES[basis].reduce((s, f) => s + account[f], 0)
  return Math.round((sum + Number.EPSILON) * 100) / 100
}
