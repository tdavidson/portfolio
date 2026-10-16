// The pure half of receipts and partnership invoices: parsing what a model read off a receipt,
// scoring which entry a receipt belongs to, what an entry bills, and the quarter arithmetic. No I/O,
// so every rule here is pinned by receipts-core.test.ts without a database.

import { roundCents } from './ledger'

// ── What a receipt says ─────────────────────────────────────────────────────────────────────

export interface ReceiptFields {
  vendorName: string | null
  receiptDate: string | null
  amount: number | null
  currency: string | null
  description: string | null
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** A YYYY-MM-DD that is a real calendar date, else null. */
export function isoDateOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().slice(0, 10)
  if (!ISO_DATE.test(s)) return null
  const d = new Date(`${s}T00:00:00Z`)
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s
}

/** A money amount from a model or a form: "1,234.50", "$12", 12.5. Positive only; a refund is still evidence of its own size. */
export function amountOrNull(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''))
  if (!Number.isFinite(n) || n === 0) return null
  return roundCents(Math.abs(n))
}

function textOrNull(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().replace(/\s+/g, ' ')
  return s ? s.slice(0, max) : null
}

/**
 * The model's JSON, read defensively. Anything it got wrong (a date that isn't one, a total in
 * words) becomes null rather than a wrong value: a blank field is visibly blank, a wrong one is
 * matched against the wrong entry.
 */
export function parseReceiptExtraction(raw: string): (ReceiptFields & { isReceipt: boolean }) | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start < 0 || end < start) return null
    const p = JSON.parse(cleaned.slice(start, end + 1))
    if (!p || typeof p !== 'object') return null
    const currency = textOrNull(p.currency, 10)?.toUpperCase() ?? null
    return {
      isReceipt: p.is_receipt !== false,
      vendorName: textOrNull(p.vendor_name ?? p.vendor, 120),
      receiptDate: isoDateOrNull(p.receipt_date ?? p.date),
      amount: amountOrNull(p.total ?? p.amount),
      currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
      description: textOrNull(p.description, 300),
    }
  } catch {
    return null
  }
}

// ── Does this email carry a receipt? ────────────────────────────────────────────────────────

const RECEIPT_SUBJECT = /\b(receipts?|invoice|order confirmation|payment (received|confirmation)|your order|paid|billing statement|purchase)\b/i
const RECEIPT_TAG = /^\s*(\[receipt\]|receipt:|rcpt:|expense:)/i
const RECEIPT_ATTACHMENT = /(receipt|invoice|order)/i

export interface ReceiptSignal {
  subject: string
  /** The address it was sent to, for plus-addressing (`inbound+receipts@…`). */
  to?: string | null
  attachmentNames: string[]
  /** The text body, for an e-receipt that arrives as the email itself. */
  body?: string | null
  isFundMember: boolean
}

const BODY_TOTAL = /\b(total|amount (paid|charged)|grand total|order total)\b[^\n]{0,40}?[$€£]?\s?\d[\d,]*\.\d{2}/i

/**
 * Whether an inbound email is a receipt someone sent in, decided before the routing classifier.
 *
 * Deterministic and deliberately narrow, because the cost of a false positive is high: a
 * portfolio company's update filed as a receipt is a KPI letter nobody reads. So it takes a member
 * of the fund saying so, explicitly: a subject tagged "Receipt:" / "[receipt]", or the
 * `+receipts` address, decides it on its own; otherwise a member's mail whose subject reads like a
 * receipt and that carries a receipt-like attachment or states a total. Mail from outside the fund is never a
 * receipt here; vendors do not get to write to the books. An e-receipt that IS the email (no
 * attachment, a total in the body) counts the same as an attached one.
 */
export function looksLikeReceipt(s: ReceiptSignal): boolean {
  if (!s.isFundMember) return false
  const local = (s.to ?? '').split('@')[0] ?? ''
  if (/\+(receipts?|expenses?)$/i.test(local)) return true
  if (RECEIPT_TAG.test(s.subject)) return true
  const subjectSays = RECEIPT_SUBJECT.test(s.subject.replace(/^\s*((fwd?|fw):\s*)+/i, ''))
  const attachmentSays = s.attachmentNames.some(n => RECEIPT_ATTACHMENT.test(n))
  const bodySays = BODY_TOTAL.test(s.body ?? '')
  return subjectSays && (attachmentSays || bodySays)
}

/** The attachments worth keeping as receipts: PDFs and images. Signature logos and calendar files are not receipts. */
export function isReceiptFile(contentType: string | null | undefined, sizeBytes: number | null | undefined): boolean {
  const t = (contentType ?? '').toLowerCase()
  if (t === 'application/pdf') return true
  // A 4 KB inline image is an email signature, not a photographed receipt.
  if (t.startsWith('image/')) return (sizeBytes ?? 0) >= 15_000
  return false
}

// ── Matching a receipt to an entry ──────────────────────────────────────────────────────────

export interface MatchCandidate {
  kind: 'entry' | 'bank'
  id: string
  date: string
  /** The size of the entry (its debits) or the bank transaction (absolute). */
  amount: number
  description: string | null
  status: string
}

export interface ScoredCandidate extends MatchCandidate {
  score: number
  reason: string
}

const daysBetween = (a: string, b: string) =>
  Math.abs((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000)

/** How far either side of the receipt date a charge may post. Card charges settle a few days late. */
export const MATCH_WINDOW_DAYS = 10

/**
 * Score one candidate against a receipt, 0 (no match) to 1. AMOUNT IS REQUIRED: a receipt is
 * matched to the charge for the same money, and a near-miss in amount is a different charge (a
 * tip, a currency conversion) that a person should look at, not one we pick for them. Within the
 * amount, closer in date and a vendor name in the description rank higher.
 */
export function scoreCandidate(
  receipt: Pick<ReceiptFields, 'amount' | 'receiptDate' | 'vendorName'>,
  c: MatchCandidate,
): ScoredCandidate | null {
  if (receipt.amount == null) return null
  const diff = Math.abs(roundCents(c.amount) - receipt.amount)
  // Exact to the cent, or within 2% for a converted foreign charge.
  const exact = diff < 0.005
  if (!exact && diff > receipt.amount * 0.02) return null

  let score = exact ? 0.6 : 0.35
  const reasons = [exact ? 'same amount' : 'amount within 2%']

  if (receipt.receiptDate) {
    const d = daysBetween(receipt.receiptDate, c.date)
    if (d > MATCH_WINDOW_DAYS) return null
    score += 0.25 * (1 - d / MATCH_WINDOW_DAYS)
    reasons.push(d === 0 ? 'same day' : `${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'} apart`)
  }

  const vendorWord = (receipt.vendorName ?? '').toLowerCase().split(/[^a-z0-9]+/).find(w => w.length >= 4)
  if (vendorWord && (c.description ?? '').toLowerCase().includes(vendorWord)) {
    score += 0.15
    reasons.push('vendor named')
  }
  return { ...c, score: Math.min(1, Math.round(score * 100) / 100), reason: reasons.join(', ') }
}

/** Every candidate that scores, best first. */
export function rankCandidates(
  receipt: Pick<ReceiptFields, 'amount' | 'receiptDate' | 'vendorName'>,
  candidates: MatchCandidate[],
  limit = 5,
): ScoredCandidate[] {
  return candidates
    .map(c => scoreCandidate(receipt, c))
    .filter((c): c is ScoredCandidate => c !== null)
    .sort((a, b) => b.score - a.score || a.date.localeCompare(b.date))
    .slice(0, limit)
}

// ── What an invoice bills ───────────────────────────────────────────────────────────────────

export interface ReceivableEntry {
  id: string
  sourceType: string | null
  postings: { id: string; accountId: string; amount: number }[]
}

/**
 * The postings a partnership invoice bills: each DEBIT to the payer's "Due from <fund>" account,
 * one line per posting (an entry that splits a cost between two funds puts one posting on each
 * fund's account, so each fund is billed its share and nothing else).
 *
 * Left out: entries the intercompany module wrote. A management fee accrual is its own charge with
 * its own settlement, and a settlement is the payment, not a cost; billing either here would
 * charge the fund twice. Credits to the account (a refund, a payment booked by hand) are left out
 * too: an invoice bills what was spent, and the balance on the books is what remains unpaid.
 */
export function billablePostings(
  entries: ReceivableEntry[],
  receivableAccountId: string,
  alreadyBilled: Set<string>,
): { entryId: string; postingId: string; amount: number }[] {
  const out: { entryId: string; postingId: string; amount: number }[] = []
  for (const e of entries) {
    if (e.sourceType === 'intercompany' || e.sourceType === 'intercompany_settlement') continue
    for (const p of e.postings) {
      if (p.accountId !== receivableAccountId || alreadyBilled.has(p.id)) continue
      const amount = roundCents(Number(p.amount))
      if (amount > 0) out.push({ entryId: e.id, postingId: p.id, amount })
    }
  }
  return out
}

/** The size of an entry, for matching: its debits. */
export function entryGross(postings: { amount: number }[]): number {
  return roundCents(postings.filter(p => Number(p.amount) > 0).reduce((s, p) => s + Number(p.amount), 0))
}

// ── Quarters and invoice numbers ────────────────────────────────────────────────────────────

export interface Quarter { year: number; quarter: 1 | 2 | 3 | 4; start: string; end: string; label: string }

export function quarterBounds(year: number, quarter: number): Quarter {
  if (!Number.isInteger(year) || year < 1900 || year > 2999) throw new Error('year must be a four-digit year')
  if (![1, 2, 3, 4].includes(quarter)) throw new Error('quarter must be 1, 2, 3 or 4')
  const q = quarter as 1 | 2 | 3 | 4
  const startMonth = (q - 1) * 3 + 1
  const endMonth = startMonth + 2
  const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate()
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    year, quarter: q,
    start: `${year}-${pad(startMonth)}-01`,
    end: `${year}-${pad(endMonth)}-${pad(lastDay)}`,
    label: `Q${q} ${year}`,
  }
}

/** The quarter a date falls in. */
export function quarterOf(date: string): Quarter {
  const [y, m] = date.split('-').map(Number)
  return quarterBounds(y, Math.floor((m - 1) / 3) + 1)
}

/** The last full quarter before `today` — what "bill last quarter" means on the first of the month. */
export function previousQuarter(today: string): Quarter {
  const q = quarterOf(today)
  return q.quarter === 1 ? quarterBounds(q.year - 1, 4) : quarterBounds(q.year, q.quarter - 1)
}

/**
 * A readable, unique-per-pair invoice number: PE-2026Q3-<payer prefix>. The payer's id prefix
 * keeps two funds' invoices for the same quarter apart, and a reissue after a void gets a suffix
 * from the caller.
 */
export function invoiceNumber(q: Quarter, toVehicleId: string, attempt = 0): string {
  const base = `PE-${q.year}Q${q.quarter}-${toVehicleId.slice(0, 6).toUpperCase()}`
  return attempt > 0 ? `${base}-${attempt + 1}` : base
}
