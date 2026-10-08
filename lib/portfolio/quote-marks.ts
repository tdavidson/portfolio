// lib/portfolio/quote-marks.ts
//
// The quoted mark one entity owes on one holding, and the action that books it — on the holding's
// own page (plans/spec-ledger-one-writer.md §6), per (holding, entity). A feed has no entity: one
// feed prices the holding for every entity, and each entity's ledger carries its own units at its
// own value, so each books its own mark.
//
// Booking is a TRANSACTION, not a journal entry: an unrealized_gain_change with
// valuation_change_source = 'quote', derived and posted by draftEntryForTransaction like any
// recorded mark. Investment value reaches the ledger in no other way.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadPostedLedger } from '@/lib/accounting/load'
import { fundCurrency } from '@/lib/accounting/currency'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { draftEntryForTransaction, type LedgerDraftResult } from '@/lib/accounting/from-portfolio'
import { buildSoiPositions, type SoiCompany } from '@/lib/accounting/soi'
import { ledgerCarryingByHolding } from './fof-load'
import {
  feedActiveOn, feedFromRow, observationFromRow, periodEndQuoteMarks, quoteAsOf,
  type PendingQuoteMark,
} from './quotes'

export interface QuoteMarkCheck {
  mark: PendingQuoteMark | null
  /** Why there is no mark, in words a person can act on. Null when `mark` is set. */
  problem: string | null
}

export type BookQuoteMarkResult =
  | { booked: false; reason: string }
  | { booked: true; transactionId: string; mark: PendingQuoteMark; ledger: LedgerDraftResult }

const none = (problem: string): QuoteMarkCheck => ({ mark: null, problem })
const unread = (what: string, error: { message?: string } | unknown) =>
  none(`Could not read ${what}: ${(error as { message?: string })?.message ?? String(error)}`)

/** A thrown read, carrying what was being read so the refusal names the right thing. */
class ReadFailure {
  constructor(readonly what: string, readonly error: unknown) {}
}
const labelled = <T>(what: string, p: Promise<T>): Promise<T> =>
  p.catch(e => { throw new ReadFailure(what, e) })

/**
 * The mark `group` owes on `companyId` at `asOf`, or why there is none.
 *
 * Every read is checked: a mark struck from a partial read — no observations, half the
 * transactions, an empty ledger — is a confident wrong number, so a failed read is a refusal.
 */
export async function quoteMarkForHolding(
  admin: SupabaseClient,
  fundId: string,
  companyId: string,
  group: string,
  asOf: string,
): Promise<QuoteMarkCheck> {
  const { data: feedRows, error: feedError } = await (admin as any).from('price_feeds').select('*')
    .eq('fund_id', fundId).eq('company_id', companyId)
    .order('created_at', { ascending: false }).limit(1)
  if (feedError) return unread('the price feed', feedError)
  const row = ((feedRows as any[]) ?? [])[0]
  if (!row) return none('This holding has no price feed.')
  const feed = feedFromRow(row)
  if (!feedActiveOn(feed, asOf)) return none(`The ${feed.symbol} feed does not price this holding on ${asOf}.`)

  // An entity that is not a vehicle has no ledger, and an empty ledger would carry the holding at
  // zero — the whole quoted value would be booked as a gain.
  let vehicleId: string | null
  try {
    vehicleId = await vehicleIdByName(admin, fundId, group)
  } catch (e) {
    return unread("the fund's entities", e)
  }
  if (!vehicleId) return none(`${group} is not one of this fund's entities.`)

  let ledger: Awaited<ReturnType<typeof loadPostedLedger>>
  let currency: string
  let obs: { data: unknown; error: unknown }
  let txns: { data: unknown; error: unknown }
  let co: { data: unknown; error: unknown }
  try {
    ;[obs, txns, co, ledger, currency] = await Promise.all([
      (admin as any).from('price_observations').select('*').eq('fund_id', fundId).eq('feed_id', feed.id).lte('as_of_date', asOf),
      (admin as any).from('investment_transactions').select('*').eq('fund_id', fundId).eq('company_id', companyId),
      (admin as any).from('companies').select('id, name, holding_type, status, industry, stage, portfolio_group')
        .eq('fund_id', fundId).eq('id', companyId).maybeSingle(),
      labelled(`${group}'s ledger`, loadPostedLedger(admin, fundId, group, asOf, new Map([[group, vehicleId]]))),
      labelled("the fund's currency", fundCurrency(admin, fundId)),
    ])
  } catch (e) {
    return e instanceof ReadFailure ? unread(e.what, e.error) : unread("the holding's data", e)
  }
  if (obs.error) return unread(`the ${feed.symbol} quotes`, obs.error)
  if (txns.error) return unread("the holding's transactions", txns.error)
  if (co.error) return unread('the holding', co.error)
  const company = co.data as SoiCompany | null
  if (!company) return none('Holding not found.')

  // The close refuses this case (quoteCloseIssues); booking it here would be the confident wrong
  // number the close exists to stop — 40,000 pence reported as 40,000 pounds.
  if (feed.quoteCurrency !== currency) {
    return none(`${feed.symbol} is quoted in ${feed.quoteCurrency} but the fund reports in ${currency}. Translating a quote is not supported — mark this position by hand.`)
  }

  const observations = ((obs.data as any[]) ?? []).map(observationFromRow)
  if (!quoteAsOf(observations, feed.id, asOf)) {
    return none(`No ${feed.symbol} quote on or before ${asOf} — enter the closing price first.`)
  }

  // Units through the schedule's own roll-up, cut at the date: split-adjusted, this entity only.
  const upTo = ((txns.data as any[]) ?? []).filter(t => !t.transaction_date || t.transaction_date <= asOf)
  const position = buildSoiPositions(upTo, [company], group, new Date(asOf))[0]
  if (!position) return none(`${group} holds no ${company.name} on ${asOf}.`)

  const carrying = ledgerCarryingByHolding(ledger.accounts as any, ledger.postings as any).get(companyId) ?? 0
  const [mark] = periodEndQuoteMarks(
    [{ companyId, name: position.name, shares: position.shares ?? 0, ledgerCarrying: carrying }],
    [feed], observations, asOf,
  )
  return mark
    ? { mark, problem: null }
    : none(`The ledger already carries ${position.name} in ${group} at its quoted value on ${asOf}.`)
}

/**
 * Record the mark as a transaction on the holding and derive it (posts). If derivation refuses —
 * a closed period, a missing account — the transaction is removed again, so the tracker never
 * carries a mark the books do not.
 */
export async function bookQuoteMark(
  admin: SupabaseClient,
  fundId: string,
  userId: string,
  companyId: string,
  group: string,
  asOf: string,
): Promise<BookQuoteMarkResult> {
  const check = await quoteMarkForHolding(admin, fundId, companyId, group, asOf)
  if (!check.mark) return { booked: false, reason: check.problem ?? 'Nothing to book.' }
  const m = check.mark

  // The ledger only sees POSTED entries, so a mark whose entry was kept as a draft (the partner
  // allocation failed) still looks owed — as does the first click of a double click. One quoted
  // mark per (holding, entity, date): a second would book the same gain twice.
  const { data: existing, error: existingError } = await (admin as any)
    .from('investment_transactions').select('id')
    .eq('fund_id', fundId).eq('company_id', companyId).eq('portfolio_group', group)
    .eq('transaction_date', asOf).eq('transaction_type', 'unrealized_gain_change')
    .eq('valuation_change_source', 'quote').limit(1)
  if (existingError) return { booked: false, reason: `Could not read the holding's marks: ${existingError.message}` }
  if (((existing as unknown[]) ?? []).length > 0) {
    return { booked: false, reason: `A quoted mark is already booked for ${group} on ${asOf}.` }
  }

  const { data: txn, error } = await (admin as any)
    .from('investment_transactions')
    .insert({
      fund_id: fundId,
      company_id: companyId,
      transaction_type: 'unrealized_gain_change',
      transaction_date: asOf,
      unrealized_value_change: m.delta,
      // Both, as the FX path sets both: computeSummary reads the price for a priced position and
      // the value change for everything else, so the mark lands either way without double-counting.
      current_share_price: m.price,
      valuation_change_source: 'quote',
      portfolio_group: group,
      notes: `${m.symbol} at ${m.price} on ${m.quoteDate} (Level ${m.level})`,
    })
    .select('*')
    .single()
  if (error || !txn) return { booked: false, reason: error?.message ?? 'Could not record the mark.' }

  const ledger = await draftEntryForTransaction(admin, fundId, userId, txn, m.name)
  if (!ledger.drafted) {
    // No entry, no mark: a transaction left behind would be a value the ledger does not carry.
    const refused = ledger.reason ?? 'The ledger refused the mark.'
    const { error: deleteError } = await (admin as any).from('investment_transactions')
      .delete().eq('id', txn.id).eq('fund_id', fundId)
    if (deleteError) {
      return {
        booked: false,
        reason: `${refused} The mark was recorded on the holding but could not be removed (${deleteError.message}), so the holding shows a mark the ledger does not carry — delete it from the holding's transactions.`,
      }
    }
    return { booked: false, reason: refused }
  }
  return { booked: true, transactionId: txn.id, mark: m, ledger }
}
