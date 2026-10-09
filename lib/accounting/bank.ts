// Bank ingestion: parse a transaction feed (CSV/Excel paste), dedup it, suggest
// a chart account per row, and build a balanced draft entry. Source-agnostic —
// Plaid/Ramp/QuickBooks connectors normalize into the same ParsedTxn shape and
// reuse everything below. Pure and testable; the API does the persistence.

import { roundCents } from './ledger'
import type { Posting } from './types'

export interface ParsedTxn {
  date: string        // ISO YYYY-MM-DD
  amount: number      // signed: + inflow, - outflow
  description: string
  counterparty?: string
  activity?: string   // transaction type/activity column (e.g. brokerage "Interest Income")
}

// ---------------------------------------------------------------------------
// CSV / TSV parsing
// ---------------------------------------------------------------------------

/** Split one delimited line, honoring double-quoted fields. */
export function splitLine(line: string, delim: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else inQuotes = false
      } else cur += c
    } else if (c === '"') inQuotes = true
    else if (c === delim) { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out.map(s => s.trim())
}

/**
 * Split text into logical CSV records, honoring newlines embedded inside quoted
 * fields (common in brokerage exports, e.g. a multi-line Description). A newline
 * only ends a record when it's outside quotes.
 */
export function splitRecords(text: string): string[] {
  const records: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') { cur += '""'; i++; continue } // escaped quote
      inQuotes = !inQuotes
      cur += c
    } else if ((c === '\n' || c === '\r') && !inQuotes) {
      if (c === '\r' && text[i + 1] === '\n') i++ // CRLF
      records.push(cur)
      cur = ''
    } else {
      cur += c
    }
  }
  records.push(cur)
  // Strip carriage returns, NOT surrounding whitespace.
  //
  // This used to be `.map(r => r.trim())`, which is invisible for CSV and destructive for TSV:
  // a tab IS whitespace, so a record whose first columns are empty — `\t\t\tThird\tFourth`, the
  // shape every QuickBooks continuation line and many bank exports use — lost its leading tabs
  // and every field shifted left, putting the account where the memo belongs. Callers that want
  // a trimmed CELL still get one: splitLine trims each field.
  return records.map(r => r.replace(/\r/g, '')).filter(r => r.trim().length > 0)
}

/** Normalize a date string to ISO (YYYY-MM-DD). Accepts ISO and M/D/Y. */
export function normalizeDate(s: string): string | null {
  const t = s.trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10)
  const m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/)
  if (m) {
    let [, mo, d, y] = m
    if (y.length === 2) y = '20' + y
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  return null
}

export function parseAmount(s: string): number | null {
  if (s == null) return null
  const neg = /^\(.*\)$/.test(s.trim()) // (123.45) accounting negative
  const cleaned = s.replace(/[(),$\s]/g, '')
  if (cleaned === '' || isNaN(Number(cleaned))) return null
  const n = Number(cleaned)
  return neg ? -Math.abs(n) : n
}

// Word-boundary "contains" matching, ordered so the more specific columns win:
// debit/credit before a bare "amount" (so "Debit Amount" is a debit, not an
// amount), and date before amount (so "Value Date" is a date). This resolves the
// common real-world variants — "Posting Date", "Transaction Amount", "Withdrawal
// Amount", "Deposit Amount", "Amount (USD)", etc. — that an exact-match list misses.
const HEADER_RULES: { key: string; re: RegExp }[] = [
  { key: 'debit',        re: /\b(debit|withdrawal|withdrawals|money out|outflow)\b/ },
  { key: 'credit',       re: /\b(credit|deposit|deposits|money in|inflow)\b/ },
  { key: 'date',         re: /\b(date|posted)\b/ },
  { key: 'amount',       re: /\b(amount|value)\b/ },
  { key: 'counterparty', re: /\b(counterparty|payee|merchant|vendor)\b/ },
  { key: 'activity',     re: /\b(activity|transaction type|txn type|type)\b/ },
  { key: 'description',  re: /\b(description|memo|name|details|narrative)\b/ },
]

function matchHeader(cell: string): string | null {
  const c = cell.toLowerCase().trim()
  for (const rule of HEADER_RULES) if (rule.re.test(c)) return rule.key
  return null
}

/** Most likely delimiter for a line: tab, comma, or semicolon (EU exports). */
export function pickDelim(line: string): string {
  const candidates: [string, number][] = [
    ['\t', (line.match(/\t/g) ?? []).length],
    [',', (line.match(/,/g) ?? []).length],
    [';', (line.match(/;/g) ?? []).length],
  ]
  candidates.sort((a, b) => b[1] - a[1])
  return candidates[0][1] > 0 ? candidates[0][0] : ','
}

export interface ParseResult {
  rows: ParsedTxn[]
  errors: string[]
}

/**
 * Parse pasted CSV/TSV bank transactions. Detects the delimiter and maps common
 * headers (date, description, amount OR debit/credit, counterparty). Rows that
 * can't be parsed are reported, not silently dropped.
 */
export function parseTransactionsCsv(text: string): ParseResult {
  const lines = splitRecords(text)
  if (lines.length === 0) return { rows: [], errors: ['No rows found'] }

  // Bank/broker exports often prepend title or account-metadata rows before the
  // real header, so scan the first several lines for the row that carries a date
  // column plus an amount (or debit/credit) column, rather than assuming row 1.
  let headerIdx = -1
  let delim = ','
  let cols: (string | null)[] = []
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const d = pickDelim(lines[i])
    const c = splitLine(lines[i], d).map(matchHeader)
    if (c.includes('date') && (c.includes('amount') || c.includes('credit') || c.includes('debit'))) {
      headerIdx = i; delim = d; cols = c; break
    }
  }
  if (headerIdx === -1) {
    // No delimited header. A table copied out of a bank's web page often arrives one CELL per line
    // (no tabs, no commas), which the row parser above cannot see. Try that shape before giving up.
    const stacked = parseStackedTransactions(text)
    if (stacked) return stacked
    return { rows: [], errors: ['Could not find a date column and an amount (or debit/credit) column in the header'] }
  }

  const has = (k: string) => cols.includes(k)
  const idx = (k: string) => cols.indexOf(k)
  const rows: ParsedTxn[] = []
  const errors: string[] = []

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], delim)
    const rawDate = cells[idx('date')] ?? ''
    const date = normalizeDate(rawDate)
    if (!date) { errors.push(`Row ${i + 1}: unparseable date "${rawDate}"`); continue }

    let amount: number | null = null
    if (has('amount')) amount = parseAmount(cells[idx('amount')] ?? '')
    else {
      const credit = has('credit') ? parseAmount(cells[idx('credit')] ?? '') ?? 0 : 0
      const debit = has('debit') ? parseAmount(cells[idx('debit')] ?? '') ?? 0 : 0
      amount = roundCents(Math.abs(credit) - Math.abs(debit))
    }
    if (amount == null || isNaN(amount)) { errors.push(`Row ${i + 1}: unparseable amount`); continue }

    rows.push({
      date,
      amount: roundCents(amount),
      description: ((has('description') ? cells[idx('description')] : '') ?? '').replace(/\s+/g, ' ').trim(),
      counterparty: has('counterparty') ? cells[idx('counterparty')] : undefined,
      activity: has('activity') ? (cells[idx('activity')] ?? '').trim() : undefined,
    })
  }

  return { rows, errors }
}

/**
 * A table pasted one cell per line:
 *
 *   Date / Activity Type / Description / Amount / 09/30/26 / Interest Income /
 *   MORGAN STANLEY BANK N.A. / (Period 09/01-09/30) / 0.49
 *
 * The header is a run of lines that are each a column name (with a date and an amount, or
 * debit/credit). Each transaction starts at a line that is a date, and runs to the next one. A
 * description can wrap over several lines, so columns are filled from both ends: those before the
 * description take one line each from the front, those after it one line each from the back, and
 * the description is whatever is left in the middle. Returns null when the text is not this shape.
 */
export function parseStackedTransactions(text: string): ParseResult | null {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0)

  // Header candidates: every run of 2+ consecutive column-name lines that names a date and money.
  // A title above the table ("Account activity") can look like a column name too, so every start
  // inside a run is a candidate, and the one that parses the most rows cleanly wins.
  const candidates: { start: number; cols: string[] }[] = []
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const run: string[] = []
    for (let j = i; j < lines.length; j++) {
      const k = matchHeader(lines[j])
      // A date value is not a header; stop at the first line that is data.
      if (!k || normalizeDate(lines[j])) break
      run.push(k)
    }
    if (run.length >= 2 && run.includes('date') && (run.includes('amount') || run.includes('credit') || run.includes('debit'))) {
      candidates.push({ start: i, cols: run })
    }
  }
  let best: ParseResult | null = null
  for (const c of candidates) {
    const r = parseStackedBody(lines, c.start, c.cols)
    if (!r) continue
    if (!best || r.rows.length > best.rows.length || (r.rows.length === best.rows.length && r.errors.length < best.errors.length)) best = r
  }
  return best
}

function parseStackedBody(lines: string[], start: number, cols: string[]): ParseResult | null {
  const body = lines.slice(start + cols.length)
  const records: { line: number; cells: string[] }[] = []
  body.forEach((l, i) => {
    if (normalizeDate(l)) records.push({ line: start + cols.length + i + 1, cells: [l] })
    else if (records.length) records[records.length - 1].cells.push(l)
  })
  if (!records.length) return null

  // Which column absorbs the extra lines: the description if there is one, else the last text column.
  const wide = cols.includes('description') ? cols.indexOf('description')
    : Math.max(...cols.map((c, i) => (['counterparty', 'activity'].includes(c) ? i : -1)))
  const rows: ParsedTxn[] = []
  const errors: string[] = []

  for (const r of records) {
    const cell: Record<string, string> = {}
    // A blank cell (an empty debit, say) vanishes in this kind of paste, so a record shorter than the
    // header cannot be placed with certainty. Say so rather than guess which column is missing.
    if (r.cells.length < cols.length || (wide < 0 && r.cells.length !== cols.length)) {
      errors.push(`Line ${r.line}: expected at least ${cols.length} values, found ${r.cells.length} — a blank cell may have been dropped; paste as CSV instead`)
      continue
    }
    if (wide < 0) {
      cols.forEach((c, i) => { cell[c] = r.cells[i] })
    } else {
      const before = cols.slice(0, wide)
      const after = cols.slice(wide + 1)
      before.forEach((c, i) => { cell[c] = r.cells[i] })
      after.forEach((c, i) => { cell[c] = r.cells[r.cells.length - after.length + i] })
      cell[cols[wide]] = r.cells.slice(before.length, r.cells.length - after.length).join(' ')
    }

    const date = normalizeDate(cell.date ?? '')
    if (!date) { errors.push(`Line ${r.line}: unparseable date "${cell.date ?? ''}"`); continue }
    let amount: number | null
    if (cols.includes('amount')) amount = parseAmount(cell.amount ?? '')
    else {
      const credit = parseAmount(cell.credit ?? '') ?? 0
      const debit = parseAmount(cell.debit ?? '') ?? 0
      amount = roundCents(Math.abs(credit) - Math.abs(debit))
    }
    if (amount == null || isNaN(amount)) { errors.push(`Line ${r.line}: unparseable amount "${cell.amount ?? ''}"`); continue }
    rows.push({
      date,
      amount: roundCents(amount),
      description: (cell.description ?? '').replace(/\s+/g, ' ').trim(),
      counterparty: cell.counterparty,
      activity: cell.activity?.trim(),
    })
  }
  return { rows, errors }
}

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

function fnv1a(s: string, seed: number): number {
  let h = seed
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const dedupKey = (t: ParsedTxn) =>
  `${t.date}|${t.amount.toFixed(2)}|${(t.description || '').toLowerCase().trim()}`

/**
 * The ORIGINAL 32-bit hash. Kept only so re-importing a file that was imported before this
 * change is still recognised as a duplicate — existing `bank_transactions` rows carry these.
 * Never write one.
 */
export function legacyDedupHash(t: ParsedTxn): string {
  return fnv1a(dedupKey(t), 0x811c9dc5).toString(16).padStart(8, '0')
}

/**
 * Stable non-crypto hash for import idempotency.
 *
 * Two changes from the original:
 *
 * 1. 64-BIT, not 32. A 32-bit hash has a ~50% chance of at least one collision by ~77k rows —
 *    entirely reachable on a multi-year feed — and a collision here means a real transaction
 *    is silently skipped as a "duplicate".
 *
 * 2. `occurrence` DISAMBIGUATES GENUINE DUPLICATES. Two identical wire fees on the same day,
 *    same amount, same description are two real transactions, and the old hash collapsed them
 *    into one and dropped the second without a word. Numbering them within the file keeps them
 *    distinct — while a RE-import of that same file reproduces the same numbering, so it is
 *    still correctly skipped. Idempotency is preserved; the false positive is not.
 */
export function dedupHash(t: ParsedTxn, occurrence = 0): string {
  const s = occurrence > 0 ? `${dedupKey(t)}|#${occurrence}` : dedupKey(t)
  const a = fnv1a(s, 0x811c9dc5)
  const b = fnv1a(s, 0x9e3779b9)
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------
// Categorization (deterministic first pass; AI can refine)
// ---------------------------------------------------------------------------

/** Why a bank row can't post an escrow release itself. */
export const ESCROW_VIA_HOLDING =
  'An escrow release is recorded as an escrow receipt on the holding, which posts it. Record the receipt there, then link this bank row to it under "Investments with no bank transaction".'

export interface Category {
  /** Chart account code for the NON-cash side of the entry. */
  accountCode: string
  sourceType: string
  label: string
  confidence: 'high' | 'low'
}

const RULES: { re: RegExp; accountCode: string; sourceType: string; label: string }[] = [
  { re: /capital call|drawdown|contribution|subscription/i, accountCode: '3100', sourceType: 'capital_call', label: 'Capital call' },
  { re: /distribution|redemption/i, accountCode: '3100', sourceType: 'distribution', label: 'Distribution' },
  // An escrow release CLEARS the receivable booked at exit — it is not new income. The escrow
  // receipt recorded on the holding posts that (Dr cash, Cr 1350), so this row is flagged as an
  // escrow release and LINKED to the receipt's entry; posting it to 1350 itself is refused
  // (ESCROW_VIA_HOLDING), or the receivable would clear twice.
  { re: /escrow|holdback/i, accountCode: '1350', sourceType: 'realized_gain', label: 'Escrow release — link it to the receipt on the holding' },
  { re: /management fee|mgmt fee/i, accountCode: '5000', sourceType: 'management_fee', label: 'Management fee' },
  { re: /audit|legal|tax|accounting|admin|filing|fund expense|organization/i, accountCode: '5100', sourceType: 'partnership_expense', label: 'Partnership expense' },
  // Interest/dividend is handled before this list (direction-aware: income on an
  // inflow, expense on an outflow).
]

/**
 * Suggest the non-cash account + source type for a transaction. Keyword rules
 * first; otherwise fall back by direction (inflow → unallocated LP capital as a
 * likely call; outflow → partnership expense), flagged low-confidence for review.
 */
export function suggestCategory(t: ParsedTxn): Category {
  // Match against the description AND the activity/type column — brokerage feeds
  // put the meaningful keyword (e.g. "Interest Income") in a separate Activity
  // column while the description is just the counterparty name.
  const text = `${t.description || ''} ${t.activity || ''}`
  // Interest/dividend: income when received (inflow), expense when paid (outflow,
  // e.g. brokerage margin interest → the dedicated 5300 Interest expense account).
  if (/interest|dividend/i.test(text)) {
    return t.amount >= 0
      ? (/dividend/i.test(text)
          // Two K-1 boxes, so two accounts. The word in the bank line is the only signal there
          // is at this point, and it is a better one than lumping both into interest.
          ? { accountCode: '4130', sourceType: 'income', label: 'Dividend income', confidence: 'high' }
          : { accountCode: '4100', sourceType: 'income', label: 'Interest income', confidence: 'high' })
      : { accountCode: '5300', sourceType: 'partnership_expense', label: 'Interest expense', confidence: 'high' }
  }
  for (const r of RULES) {
    if (r.re.test(text)) {
      return { accountCode: r.accountCode, sourceType: r.sourceType, label: r.label, confidence: 'high' }
    }
  }
  return t.amount >= 0
    ? { accountCode: '3100', sourceType: 'capital_call', label: 'Unclassified inflow', confidence: 'low' }
    : { accountCode: '5100', sourceType: 'partnership_expense', label: 'Unclassified expense', confidence: 'low' }
}

/**
 * Two-line balanced postings for a bank transaction: an inflow debits cash and
 * credits the other account; an outflow does the reverse.
 */
export function bankEntryPostings(amount: number, cashAccountId: string, otherAccountId: string, currency = 'USD'): Posting[] {
  const amt = roundCents(amount)
  return [
    { accountId: cashAccountId, amount: amt, currency, lpEntityId: null },
    { accountId: otherAccountId, amount: roundCents(-amt), currency, lpEntityId: null },
  ]
}

// ---------------------------------------------------------------------------
// Bank reconciliation
// ---------------------------------------------------------------------------

export interface BankTxnState {
  amount: number
  matched: boolean // has a posted ledger entry
}

export interface BankRecSummary {
  bankEndingBalance: number
  ledgerCashBalance: number
  difference: number
  matchedCount: number
  unmatchedCount: number
  unmatchedTotal: number
  tiesOut: boolean
}

/**
 * Reconcile the ledger's cash against the bank feed. The bank's ending balance
 * is the opening balance plus every imported transaction; it should equal the
 * ledger cash balance once every transaction is matched to a posted entry. The
 * difference and the unmatched items localize what's left to book.
 */
export function summarizeBankRec(
  txns: BankTxnState[],
  ledgerCashBalance: number,
  openingCash = 0
): BankRecSummary {
  const bankEndingBalance = roundCents(txns.reduce((s, t) => s + t.amount, openingCash))
  const unmatched = txns.filter(t => !t.matched)
  const difference = roundCents(ledgerCashBalance - bankEndingBalance)
  return {
    bankEndingBalance,
    ledgerCashBalance: roundCents(ledgerCashBalance),
    difference,
    matchedCount: txns.length - unmatched.length,
    unmatchedCount: unmatched.length,
    unmatchedTotal: roundCents(unmatched.reduce((s, t) => s + t.amount, 0)),
    tiesOut: difference === 0 && unmatched.length === 0,
  }
}
