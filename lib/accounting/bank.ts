// Bank ingestion: parse a transaction feed (CSV/Excel paste), dedup it, suggest
// a chart account per row, and build a balanced draft entry. Source-agnostic —
// Plaid/Ramp/QuickBooks connectors normalize into the same ParsedTxn shape and
// reuse everything below. Pure and testable; the API does the persistence.

import { roundCents } from './ledger'
import type { Posting } from './types'
import { DEFAULT_CHART } from './chart'
import { categorizeBankRow } from './bank-categorize'

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
export function parseTransactionsCsv(raw: string): ParseResult {
  // Bank websites wrap cell text in zero-width characters (and a BOM can lead a file). trim() does
  // not remove them, so "09/30/26" plus an invisible space stops being a date and the header stops
  // being found. Strip them before anything reads the text.
  const text = raw.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
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

  // A web table copies as tab-separated cells, except that a cell holding a line break (a two-line
  // description) breaks its row across lines. When the row reading stumbles, read the same text as a
  // stream of cells and keep whichever reading parses more rows with fewer errors.
  if (errors.length > 0) {
    const stacked = parseStackedTransactions(text)
    if (stacked && (stacked.rows.length > rows.length || (stacked.rows.length === rows.length && stacked.errors.length < errors.length))) {
      return stacked
    }
  }
  return { rows, errors }
}

/**
 * A table pasted one cell per line:
 *
 *   Date / Activity Type / Description / Amount / 09/30/26 / Interest Income /
 *   ACME BANK N.A. / (Period 09/01-09/30) / 0.37
 *
 * The header is a run of lines that are each a column name (with a date and an amount, or
 * debit/credit). Each transaction starts at a line that is a date, and runs to the next one. A
 * description can wrap over several lines, so columns are filled from both ends: those before the
 * description take one line each from the front, those after it one line each from the back, and
 * the description is whatever is left in the middle. Returns null when the text is not this shape.
 */
export function parseStackedTransactions(text: string): ParseResult | null {
  // Tabs and line breaks are both cell boundaries here: some cells arrive tab-separated, others on
  // their own line, often in the same paste. Commas are not — descriptions contain them.
  const lines = text.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').split(/\t|\r?\n/).map(l => l.trim()).filter(l => l.length > 0)

  // Header candidates. A header runs from a line that is a known column name down to the first line
  // that is a date (where the data starts), and keeps the columns it does not use — Quantity, Price,
  // Balance — as placeholders, because they still occupy a line in every row. A title above the table
  // ("Account activity") can look like a column name too, so every start is a candidate, and the one
  // that parses the most rows cleanly wins.
  const candidates: { start: number; cols: (string | null)[] }[] = []
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    if (!matchHeader(lines[i]) || normalizeDate(lines[i])) continue
    const run: (string | null)[] = []
    let ok = false
    for (let j = i; j < lines.length && j < i + 25; j++) {
      if (normalizeDate(lines[j])) { ok = true; break }
      // A number or a dash is a value, not a column name: this start is inside the data.
      if (parseAmount(lines[j]) != null || /^[-–—]$/.test(lines[j])) break
      run.push(matchHeader(lines[j]))
    }
    if (ok && run.length >= 2 && run.includes('date') && (run.includes('amount') || run.includes('credit') || run.includes('debit'))) {
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

function parseStackedBody(lines: string[], start: number, cols: (string | null)[]): ParseResult | null {
  const body = lines.slice(start + cols.length)
  const records: { line: number; cells: string[] }[] = []
  body.forEach((l, i) => {
    if (normalizeDate(l)) records.push({ line: start + cols.length + i + 1, cells: [l] })
    else if (records.length) records[records.length - 1].cells.push(l)
  })
  if (!records.length) return null

  // Which column absorbs the extra lines: the description if there is one, else the last text column.
  const wide = cols.includes('description') ? cols.indexOf('description')
    : Math.max(...cols.map((c, i) => (c && ['counterparty', 'activity'].includes(c) ? i : -1)))
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
      cols.forEach((c, i) => { if (c) cell[c] = r.cells[i] })
    } else {
      const before = cols.slice(0, wide)
      const after = cols.slice(wide + 1)
      before.forEach((c, i) => { if (c) cell[c] = r.cells[i] })
      after.forEach((c, i) => { if (c) cell[c] = r.cells[r.cells.length - after.length + i] })
      cell[cols[wide]!] = r.cells.slice(before.length, r.cells.length - after.length).join(' ')
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

/**
 * The fund-chart suggestion, for callers that have no entity chart to hand. Anything that books
 * a real entity should call `categorizeBankRow` (bank-categorize.ts) with THAT entity's chart:
 * the codes below mean other things on a management company's or a GP entity's chart.
 */
export function suggestCategory(t: ParsedTxn): Category {
  const c = categorizeBankRow(t, { chart: DEFAULT_CHART })
  // The fund chart has an account for every rule and both fallbacks, so this is never null.
  return { accountCode: c.accountCode ?? (t.amount >= 0 ? '3100' : '5100'), sourceType: c.sourceType, label: c.label, confidence: c.confidence }
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

/**
 * The posting a bank draft's account picker re-points, or null when the entry is not a simple
 * two-line draft. Normally that is its one non-cash line. But an import whose suggested account
 * is not on the vehicle's chart (a GP entity has no 3100 or 5100) drafts the other side to cash
 * too, so both lines sit on 1000 — and there the counter-leg is the cash line signed against
 * the bank amount, since `bankEntryPostings` puts the bank amount on the cash side.
 */
export function counterPosting<P extends { account_id: string; amount: number | string }>(
  postings: P[], cashId: string | undefined, bankAmount: number,
): P | null {
  const nonCash = postings.filter(p => p.account_id !== cashId)
  if (nonCash.length === 1) return nonCash[0]
  if (nonCash.length > 0 || postings.length !== 2 || !bankAmount) return null
  const against = postings.filter(p => Math.sign(Number(p.amount)) === -Math.sign(bankAmount))
  return against.length === 1 ? against[0] : null
}

// ---------------------------------------------------------------------------
// Bank reconciliation
// ---------------------------------------------------------------------------

export interface BankTxnState {
  amount: number
  matched: boolean // has a posted ledger entry
  /**
   * Posted as cash-to-cash (every line on 1000, netting to zero): money moving between two bank
   * accounts the books both carry on 1000, such as the move from an old bank to the one this feed
   * is from. The ledger already holds that cash in the opening balance, so the row is left out of
   * the bank side too; counting it would double the carried-over balance.
   */
  cashTransfer?: boolean
}

export interface BankRecSummary {
  bankEndingBalance: number
  ledgerCashBalance: number
  difference: number
  matchedCount: number
  unmatchedCount: number
  unmatchedTotal: number
  /** Rows left out of the bank side as cash-to-cash transfers (see BankTxnState.cashTransfer). */
  transferCount: number
  transferTotal: number
  tiesOut: boolean
}

/**
 * The bank feed's opening balance: ledger cash before its first transaction. A feed rarely starts
 * on the day the books do, so without this a vehicle with years of history can never tie. The
 * cash it held before the feed began is taken from the ledger, and only activity from the feed's
 * first day on is compared.
 */
export function openingCashBefore(postings: Posting[], cashAccountId: string | undefined, txnDates: string[]): number {
  if (!cashAccountId || txnDates.length === 0) return 0
  const first = txnDates.reduce((a, b) => (b < a ? b : a))
  return roundCents(postings
    .filter(p => p.accountId === cashAccountId && p.entryDate && p.entryDate < first)
    .reduce((s, p) => s + p.amount, 0))
}

/**
 * The posted entries that only move cash between bank accounts on the cash account: every line on
 * `cashAccountId`, netting to zero. A feed row posted this way is a transfer from an account
 * outside the feed (BankTxnState.cashTransfer).
 */
export function cashTransferEntryIds(
  postings: { entryId: string; accountId: string; amount: number }[], cashAccountId: string | undefined,
): Set<string> {
  const out = new Set<string>()
  if (!cashAccountId) return out
  const byEntry = new Map<string, { onlyCash: boolean; net: number }>()
  for (const p of postings) {
    const e = byEntry.get(p.entryId) ?? { onlyCash: true, net: 0 }
    if (p.accountId !== cashAccountId) e.onlyCash = false
    e.net += p.amount
    byEntry.set(p.entryId, e)
  }
  for (const [id, e] of byEntry) if (e.onlyCash && roundCents(e.net) === 0) out.add(id)
  return out
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
  const transfers = txns.filter(t => t.matched && t.cashTransfer)
  const bankEndingBalance = roundCents(txns.reduce((s, t) => s + (t.matched && t.cashTransfer ? 0 : t.amount), openingCash))
  const unmatched = txns.filter(t => !t.matched)
  const difference = roundCents(ledgerCashBalance - bankEndingBalance)
  return {
    bankEndingBalance,
    ledgerCashBalance: roundCents(ledgerCashBalance),
    difference,
    matchedCount: txns.length - unmatched.length,
    unmatchedCount: unmatched.length,
    unmatchedTotal: roundCents(unmatched.reduce((s, t) => s + t.amount, 0)),
    transferCount: transfers.length,
    transferTotal: roundCents(transfers.reduce((s, t) => s + t.amount, 0)),
    tiesOut: difference === 0 && unmatched.length === 0,
  }
}
