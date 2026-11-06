// The terms of a financing round, stored on the investment transaction they belong to
// (investment_transactions.round_terms): what an investor letter's "New investments" section
// states, and what the books otherwise can't say (the round's size, its valuation or cap, the
// lead, the rights the fund got).
//
// They are descriptive only. No figure here reaches the ledger, a mark or a return: setting them
// changes this column and nothing else, so it is allowed in a closed period too.

import type { SupabaseClient } from '@supabase/supabase-js'
import { groupWriteDenial } from '@/lib/access/scope'
import { done, dbFail, fail, type Outcome } from '@/lib/service-outcome'

export interface RoundTerms {
  /** The whole round, all investors together. */
  round_size: number | null
  valuation: number | null
  /** What `valuation` is: a pre-money or post-money valuation, or a SAFE or note's cap. */
  valuation_basis: 'pre_money' | 'post_money' | 'cap' | null
  /** The currency the round was priced in, when not the fund's. */
  currency: string | null
  /** The lead investor, as the letter may name it. */
  lead: string | null
  /** e.g. "Series A preferred", "SAFE", "convertible note". */
  security: string | null
  /** A SAFE or note's discount, in percent. */
  discount_pct: number | null
  /** The fund's rights: pro rata, a board seat, information rights. */
  rights: string | null
  notes: string | null
}

const BASES = ['pre_money', 'post_money', 'cap'] as const

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,$\s]/g, ''))
  return Number.isFinite(n) && n >= 0 ? n : null
}
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

/** Known fields only, bounded. Unknown or bad values drop out. */
export function cleanRoundTerms(x: any): RoundTerms {
  const basis = typeof x?.valuation_basis === 'string' ? x.valuation_basis.toLowerCase().replace(/[\s-]+/g, '_') : null
  const discount = num(x?.discount_pct)
  return {
    round_size: num(x?.round_size),
    valuation: num(x?.valuation),
    valuation_basis: (BASES as readonly string[]).includes(basis) ? basis as RoundTerms['valuation_basis'] : null,
    currency: str(x?.currency, 3)?.toUpperCase() ?? null,
    lead: str(x?.lead, 200),
    security: str(x?.security, 120),
    discount_pct: discount !== null && discount <= 100 ? discount : null,
    rights: str(x?.rights, 1000),
    notes: str(x?.notes, 2000),
  }
}

export function isEmptyRoundTerms(t: RoundTerms | null | undefined): boolean {
  return !t || Object.values(t).every(v => v === null)
}

/** The terms as one line a letter's brief can quote. */
export function roundTermsLine(t: RoundTerms, fmtMoney: (n: number, currency?: string | null) => string): string | null {
  if (isEmptyRoundTerms(t)) return null
  const parts: string[] = []
  if (t.security) parts.push(t.security)
  if (t.round_size != null) parts.push(`round size ${fmtMoney(t.round_size, t.currency)}`)
  if (t.valuation != null) {
    const label = t.valuation_basis === 'pre_money' ? 'pre-money valuation' : t.valuation_basis === 'post_money' ? 'post-money valuation' : t.valuation_basis === 'cap' ? 'valuation cap' : 'valuation (basis not recorded)'
    parts.push(`${label} ${fmtMoney(t.valuation, t.currency)}`)
  }
  if (t.discount_pct != null) parts.push(`${t.discount_pct}% discount`)
  if (t.lead) parts.push(`led by ${t.lead}`)
  if (t.rights) parts.push(`rights: ${t.rights}`)
  if (t.notes) parts.push(t.notes)
  return parts.join('; ')
}

/**
 * Set the round terms on one of a company's investment (or round) transactions. A member limited
 * to some entities may only set them on a transaction of one of theirs.
 */
export async function setRoundTerms(
  admin: SupabaseClient, ctx: { fundId: string; vehicleNames: string[] | null },
  companyId: string, transactionId: string, input: unknown,
): Promise<Outcome<{ transaction_id: string; round_terms: RoundTerms | null }>> {
  const { data: txn, error } = await (admin as any).from('investment_transactions')
    .select('id, company_id, transaction_type, portfolio_group')
    .eq('id', transactionId).eq('fund_id', ctx.fundId).eq('company_id', companyId).maybeSingle()
  if (error) return dbFail(error, 'round-terms')
  if (!txn) return fail(404, 'No such transaction on this company. list_investments gives the ids.')
  const denied = groupWriteDenial(ctx.vehicleNames, txn.portfolio_group)
  if (denied) return fail(403, denied)
  if (!['investment', 'round_info'].includes(txn.transaction_type)) {
    return fail(400, 'Round terms belong on an investment or a round transaction.')
  }
  const terms = cleanRoundTerms(input)
  const value = isEmptyRoundTerms(terms) ? null : terms
  const { error: upErr } = await (admin as any).from('investment_transactions')
    .update({ round_terms: value }).eq('id', transactionId).eq('fund_id', ctx.fundId)
  if (upErr) return dbFail(upErr, 'round-terms')
  return done({ transaction_id: transactionId, round_terms: value })
}
