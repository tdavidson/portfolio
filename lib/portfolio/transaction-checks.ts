// lib/portfolio/transaction-checks.ts
//
// The rules investment_transactions' CHECK constraints enforce, said in words before a write so the
// caller gets a sentence instead of a raw constraint violation — and, on an edit, before the ledger
// entry is retracted: a row the database will refuse must not cost the transaction its journal entry.
// Used by POST /api/companies/[id]/investments (the new row) and PATCH …/[txnId] (the edited row).

export const TRANSACTION_TYPES = ['investment', 'proceeds', 'escrow_receipt', 'unrealized_gain_change', 'round_info', 'split', 'income']
export const INCOME_KINDS = ['staking', 'airdrop', 'dividend', 'other']
export const INCOME_SETTLEMENTS = ['cash', 'in_kind']
export const VALUATION_CHANGE_SOURCES = ['mark', 'fx', 'quote', 'nav']

/**
 * An income row is meaningless without its kind, settlement and amount, and in-kind income
 * without units recognises a value that landed nowhere. The database enforces all of it.
 */
export function incomeError(row: any): string | null {
  if (row.transaction_type !== 'income') return null
  if (!INCOME_KINDS.includes(row.income_kind)) {
    return `income_kind must be one of: ${INCOME_KINDS.join(', ')}.`
  }
  if (!INCOME_SETTLEMENTS.includes(row.income_settlement)) {
    return `income_settlement must be one of: ${INCOME_SETTLEMENTS.join(', ')} — cash income lands in the bank, in-kind income lands in the position.`
  }
  const amount = Number(row.income_amount)
  if (row.income_amount == null || row.income_amount === '' || !Number.isFinite(amount) || amount < 0) {
    return 'Enter the income amount — its fair value on the day it was received.'
  }
  if (!row.transaction_date) {
    return 'Income needs a date — its fair value on that day becomes the basis of any units received.'
  }
  if (row.income_settlement === 'in_kind' && !(Number(row.shares_acquired) > 0)) {
    return 'In-kind income needs the number of units received — the units are the income.'
  }
  return null
}

/** A split row is meaningless without a positive ratio and a date, and the DB enforces both. */
export function splitError(row: any): string | null {
  if (row.transaction_type !== 'split') return null
  const ratio = Number(row.split_ratio)
  if (row.split_ratio == null || row.split_ratio === '' || !Number.isFinite(ratio) || ratio <= 0) {
    return 'A split needs a positive split_ratio — new shares per old share (2-for-1 forward = 2, 1-for-10 reverse = 0.1).'
  }
  if (!row.transaction_date) {
    return 'A split needs a transaction_date — its effective date places it in the share history.'
  }
  return null
}

const NUMERIC_FIELDS = [
  'investment_cost', 'interest_converted', 'shares_acquired', 'share_price', 'split_ratio',
  'income_amount', 'fee_amount', 'cost_basis_exited', 'proceeds_received', 'proceeds_escrow',
  'proceeds_written_off', 'proceeds_per_share', 'unrealized_value_change', 'current_share_price',
  'postmoney_valuation', 'ownership_pct', 'latest_postmoney_valuation', 'exit_valuation',
  'original_investment_cost', 'original_share_price', 'original_postmoney_valuation',
  'original_proceeds_received', 'original_proceeds_per_share', 'original_exit_valuation',
  'original_unrealized_value_change', 'original_current_share_price', 'original_latest_postmoney_valuation',
  'fx_rate', 'prior_fx_rate', 'fx_value_change', 'original_position_value',
  'interest_rate', 'dividend_rate',
]
const DATE_FIELDS = ['transaction_date', 'maturity_date']

const ISO = /^\d{4}-\d{2}-\d{2}$/
const isRealDate = (v: unknown): boolean => {
  if (typeof v !== 'string' || !ISO.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}
/** What Postgres takes for a numeric column: a finite number, or a string that is one. */
const isNumeric = (v: unknown): boolean =>
  (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))

/**
 * Why the database would refuse this row, or null. `row` is the WHOLE row as it would be written
 * (on an edit, the stored row with the changes applied), because several constraints span fields.
 */
export function transactionRowError(row: Record<string, unknown>): string | null {
  if (!TRANSACTION_TYPES.includes(row.transaction_type as string)) return 'Invalid transaction_type'
  for (const k of NUMERIC_FIELDS) {
    if (row[k] != null && !isNumeric(row[k])) return `${k} must be a number.`
  }
  for (const k of DATE_FIELDS) {
    if (row[k] != null && !isRealDate(row[k])) return `${k} must be a date (YYYY-MM-DD).`
  }
  const positive = (k: string) => row[k] == null || Number(row[k]) > 0
  if (!positive('split_ratio')) return 'split_ratio must be positive.'
  if (!positive('fx_rate')) return 'fx_rate must be positive.'
  if (!positive('prior_fx_rate')) return 'prior_fx_rate must be positive.'
  if (row.income_amount != null && Number(row.income_amount) < 0) return 'income_amount cannot be negative.'
  if (row.fee_amount != null && Number(row.fee_amount) < 0) return 'fee_amount cannot be negative.'
  for (const k of ['interest_rate', 'dividend_rate']) {
    const r = row[k]
    if (r != null && (Number(r) < 0 || Number(r) >= 1)) return `${k} is a fraction from 0 up to 1 (8% = 0.08).`
  }
  if (row.income_kind != null && !INCOME_KINDS.includes(row.income_kind as string)) {
    return `income_kind must be one of: ${INCOME_KINDS.join(', ')}.`
  }
  if (row.income_settlement != null && !INCOME_SETTLEMENTS.includes(row.income_settlement as string)) {
    return `income_settlement must be one of: ${INCOME_SETTLEMENTS.join(', ')}.`
  }
  if (row.valuation_change_source != null && !VALUATION_CHANGE_SOURCES.includes(row.valuation_change_source as string)) {
    return `valuation_change_source must be one of: ${VALUATION_CHANGE_SOURCES.join(', ')}.`
  }
  return splitError(row) ?? incomeError(row)
}
