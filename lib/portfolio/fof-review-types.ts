// lib/portfolio/fof-review-types.ts
//
// What a manager's email proposes for a fund holding, as stored in parsing_reviews.payload, and the
// rules for who sees and how a person corrects a proposal. Pure — no Supabase, no server imports —
// so the review cards import it in the browser.

export const FUND_REVIEW_TYPES = ['fund_nav', 'fund_capital_call', 'fund_distribution'] as const
export type FundReviewType = (typeof FUND_REVIEW_TYPES)[number]
export const isFundReviewType = (t: string | null | undefined): t is FundReviewType =>
  (FUND_REVIEW_TYPES as readonly string[]).includes(t ?? '')

export const FUND_REVIEW_LABELS: Record<FundReviewType, string> = {
  fund_nav: 'Manager NAV',
  fund_capital_call: 'Capital call',
  fund_distribution: 'Distribution',
}

interface FromDocument {
  /** The fund as the document prints it. */
  fundName: string
  confidence: 'high' | 'medium' | 'low'
  /** The line the figures were read from, so review happens against the document. */
  sourceText: string | null
}

export interface FundNavProposal extends FromDocument {
  kind: 'nav'
  asOfDate: string
  reportedNav: number
}

export interface FundNoticeProposal extends FromDocument {
  kind: 'call' | 'distribution'
  eventDate: string
  dueDate: string | null
  noticeNumber: string | null
  purpose: string | null
  amount: number
  /** The document gave no date for this cash movement; eventDate is its valuation date or the email's. */
  dateAssumed: boolean
}

export type FundProposal = FundNavProposal | FundNoticeProposal

export const issueTypeFor = (p: FundProposal): FundReviewType =>
  p.kind === 'nav' ? 'fund_nav' : p.kind === 'call' ? 'fund_capital_call' : 'fund_distribution'

/**
 * The reviews this caller may see. A fund review is about ONE entity's position, so it needs that
 * entity; one naming no entity is for unscoped callers to assign. Any other review is scoped by its
 * company elsewhere. The same rule RLS applies (20261009100000_parsing_reviews_fund_register.sql).
 */
export function scopeFundReviews<T extends { issue_type: string; vehicle_id?: string | null }>(
  rows: T[],
  access: { vehicles: { all: boolean; ids: string[] } },
): T[] {
  if (access.vehicles.all) return rows
  return rows.filter(r => !isFundReviewType(r.issue_type) || (!!r.vehicle_id && access.vehicles.ids.includes(r.vehicle_id)))
}

const ISO = /^\d{4}-\d{2}-\d{2}$/

/** A proposal with a person's corrections applied, or why the corrections cannot be used. */
export function applyEdits(p: FundProposal, edits?: Record<string, unknown> | null): FundProposal | { error: string } {
  if (!edits || Object.keys(edits).length === 0) return p
  const out: Record<string, unknown> = { ...p }
  for (const [k, v] of Object.entries(edits)) {
    if ((p.kind === 'nav' && k === 'asOfDate') || (p.kind !== 'nav' && k === 'eventDate')) {
      if (typeof v !== 'string' || !ISO.test(v)) return { error: `${k} must be a date (YYYY-MM-DD).` }
      out[k] = v
    } else if (p.kind !== 'nav' && k === 'dueDate') {
      if (v !== null && v !== '' && (typeof v !== 'string' || !ISO.test(v))) return { error: 'dueDate must be a date (YYYY-MM-DD).' }
      out.dueDate = v || null
    } else if (p.kind === 'nav' && k === 'reportedNav') {
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0) return { error: 'reportedNav must be a number, not negative.' }
      out.reportedNav = n
    } else if (p.kind !== 'nav' && k === 'amount') {
      const n = Number(v)
      if (!Number.isFinite(n) || n <= 0) return { error: 'amount must be a positive number.' }
      out.amount = n
    } else if (p.kind !== 'nav' && (k === 'noticeNumber' || k === 'purpose')) {
      out[k] = typeof v === 'string' && v.trim() ? v.trim() : null
    } else {
      return { error: `${k} cannot be changed on this proposal.` }
    }
  }
  if (p.kind !== 'nav' && 'eventDate' in edits) out.dateAssumed = false
  return out as unknown as FundProposal
}
