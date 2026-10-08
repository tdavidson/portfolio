// lib/portfolio/fof-nav.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { draftEntryForTransaction, retractEntriesForTransaction } from '@/lib/accounting/from-portfolio'
import { loadPostedLedger } from '@/lib/accounting/load'
import { vehicleNameById } from '@/lib/accounting/vehicle-id'
import { ledgerCarryingByHolding, loadFofData } from './fof-load'
import type { NavBasis } from './fof-metrics'
import { transactionForNav } from './fof-register'
import { periodEndMarks } from './fof-valuation'

/**
 * A manager NAV statement and the mark it books — the ONE way a NAV reaches the ledger
 * (plans/spec-ledger-one-writer.md §4). Every writer of fund_nav_statements calls this module.
 *
 * Saving a statement books, at its as-of date, the difference between the value the register
 * derives for that date (the reported NAV) and what the ledger carries there, as an
 * `unrealized_gain_change` with valuation_change_source 'nav'. The transaction derives and posts like
 * any other (from-portfolio.ts) and is linked from the statement, so changing or deleting the
 * statement takes its mark back first.
 *
 * Marks are deltas against the ledger, so anything that changes what the ledger carries at a
 * statement's date leaves that statement's mark stale. Two things do: a capital event confirmed
 * after the statement but dated before it (fof-register.ts), and an edit to an earlier statement.
 * Both re-book every statement from the one affected onward, oldest first (rebookNavsFrom), so each
 * is derived against a ledger that already holds the corrected marks before it, the books end at the
 * newest NAV, and the close (fofCloseIssues) never blocks on something nothing can clear. When the
 * ledger moves some other way (a transaction edited by hand), the holding's "Re-book mark" does the
 * same from its newest statement.
 */

const BASES: NavBasis[] = ['final', 'preliminary', 'estimate']

export interface NavFields {
  reportedNav: number
  basis?: NavBasis
  receivedDate?: string | null
  reportedContributions?: number | null
  reportedDistributions?: number | null
  reportedUnfunded?: number | null
}

export interface NavInput extends NavFields {
  companyId: string
  /** The entity that holds the fund. Null saves the statement and books nothing. */
  vehicleId: string | null
  asOfDate: string
  source?: 'manual' | 'extracted'
}

export type NavBookingStatus = 'booked' | 'no_change' | 'before_ledger_start' | 'no_entity' | 'refused'

export interface NavBooking {
  status: NavBookingStatus
  transactionId?: string
  /** The mark booked: the reported NAV less what the ledger carried at the as-of date. */
  delta?: number
  /** False only when the entry was kept as a draft because the partner allocation failed. */
  posted?: boolean
  /** What happened to the ledger, in plain words, for the person who saved the statement. */
  message: string
}

export type NavSaveResult =
  | {
      ok: true; navId: string; booking: NavBooking; later?: NavBooking[]
      /** The NAV this save replaced for the same date, when it was a different figure. */
      replacedNav?: number
    }
  | { ok: false; error: string }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const NO_ENTITY = 'Saved. This statement names no entity, so no mark was booked — choose the entity that holds the fund to book it.'

function navColumns(f: Partial<NavFields>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (f.reportedNav !== undefined) out.reported_nav = f.reportedNav
  if (f.basis !== undefined) out.basis = f.basis
  if (f.receivedDate !== undefined) out.received_date = f.receivedDate
  if (f.reportedContributions !== undefined) out.reported_contributions = f.reportedContributions
  if (f.reportedDistributions !== undefined) out.reported_distributions = f.reportedDistributions
  if (f.reportedUnfunded !== undefined) out.reported_unfunded = f.reportedUnfunded
  return out
}

function invalid(f: Partial<NavFields> & { asOfDate?: string }): string | null {
  if (f.asOfDate !== undefined && !ISO_DATE.test(f.asOfDate)) return 'asOfDate must be a date (YYYY-MM-DD).'
  if (f.basis !== undefined && !BASES.includes(f.basis)) return 'basis must be final, preliminary or estimate.'
  if (f.reportedNav !== undefined && !Number.isFinite(f.reportedNav)) return 'reportedNav must be a number.'
  for (const k of ['reportedContributions', 'reportedDistributions', 'reportedUnfunded'] as const) {
    const v = f[k]
    if (v !== undefined && v !== null && !Number.isFinite(v)) return `${k} must be a number.`
  }
  return null
}

/** Save (insert, or replace the statement for that holding, entity and date) and book its mark. */
export async function saveNavStatement(
  admin: SupabaseClient,
  fundId: string,
  userId: string | null,
  input: NavInput,
): Promise<NavSaveResult> {
  const bad = invalid(input)
  if (bad) return { ok: false, error: bad }

  // One statement per holding, entity and as-of date: a corrected statement REPLACES the one for that
  // date, and its mark is re-derived below — the old link is not preserved.
  const find = async (): Promise<{ id: string; reported_nav: number | string | null } | null> => {
    let q = (admin as any).from('fund_nav_statements').select('id, reported_nav')
      .eq('fund_id', fundId).eq('company_id', input.companyId).eq('as_of_date', input.asOfDate)
    q = input.vehicleId ? q.eq('vehicle_id', input.vehicleId) : q.is('vehicle_id', null)
    const { data, error } = await q.maybeSingle()
    if (error) throw new Error(error.message)
    return (data as { id: string; reported_nav: number | string | null } | null) ?? null
  }

  let existing: Awaited<ReturnType<typeof find>>
  try { existing = await find() } catch (e) { return { ok: false, error: (e as Error).message } }
  let navId = existing?.id ?? null
  let inserted = false
  if (!navId) {
    const { data, error } = await (admin as any).from('fund_nav_statements').insert({
      ...navColumns({ basis: 'final', ...input }),
      fund_id: fundId,
      company_id: input.companyId,
      vehicle_id: input.vehicleId,
      as_of_date: input.asOfDate,
      source: input.source ?? 'manual',
      created_by: userId,
    }).select('id').single()
    if (!error && data) { navId = (data as { id: string }).id; inserted = true }
    // Two saves of the same statement at once: the loser updates the winner's row.
    else if (/duplicate|unique/i.test(error?.message ?? '')) {
      try { existing = await find() } catch (e) { return { ok: false, error: (e as Error).message } }
      navId = existing?.id ?? null
    }
    else return { ok: false, error: error?.message ?? 'The statement could not be saved.' }
  }
  if (!navId) return { ok: false, error: 'The statement could not be saved.' }
  if (!inserted) {
    // Replacing a statement keeps its basis unless this save names one.
    const { error } = await (admin as any).from('fund_nav_statements')
      .update(navColumns(input)).eq('id', navId).eq('fund_id', fundId)
    if (error) return { ok: false, error: error.message }
  }
  const result = await afterChange(admin, fundId, userId, navId, input.companyId, input.vehicleId, input.asOfDate)
  const old = existing && !inserted ? Number(existing.reported_nav) : null
  if (result.ok && old !== null && Number.isFinite(old) && Math.abs(old - input.reportedNav) >= 0.005) {
    result.replacedNav = old
    result.booking = {
      ...result.booking,
      message: `${result.booking.message} It replaced the NAV of ${formatAmount(old)} already recorded for ${input.asOfDate}.`,
    }
  }
  return result
}

const formatAmount = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })

/** Change a statement's figures (never its date — another date is another statement). */
export async function editNavStatement(
  admin: SupabaseClient,
  fundId: string,
  userId: string | null,
  navId: string,
  fields: Partial<NavFields>,
): Promise<NavSaveResult> {
  const bad = invalid(fields)
  if (bad) return { ok: false, error: bad }
  const columns = navColumns(fields)
  if (Object.keys(columns).length === 0) return { ok: false, error: 'Nothing to change.' }
  const { data: nav } = await (admin as any).from('fund_nav_statements')
    .select('id, company_id, vehicle_id, as_of_date').eq('fund_id', fundId).eq('id', navId).maybeSingle()
  if (!nav) return { ok: false, error: 'That statement no longer exists.' }
  const { error } = await (admin as any).from('fund_nav_statements').update(columns).eq('id', navId).eq('fund_id', fundId)
  if (error) return { ok: false, error: error.message }
  return afterChange(admin, fundId, userId, navId, nav.company_id, nav.vehicle_id ?? null, nav.as_of_date)
}

/** Take the statement's mark back, then delete it. Refused — nothing changes — if the mark cannot be taken back. */
export async function deleteNavStatement(
  admin: SupabaseClient,
  fundId: string,
  userId: string | null,
  navId: string,
): Promise<{ ok: true; later?: NavBooking[] } | { ok: false; error: string }> {
  const { data: nav } = await (admin as any).from('fund_nav_statements')
    .select('*').eq('fund_id', fundId).eq('id', navId).maybeSingle()
  if (!nav) return { ok: false, error: 'That statement no longer exists.' }
  if (nav.investment_transaction_id) {
    const refused = await unbook(admin, fundId, userId, nav)
    if (refused) return { ok: false, error: refused.message }
  }
  const { error } = await (admin as any).from('fund_nav_statements').delete().eq('id', navId).eq('fund_id', fundId)
  if (error) return { ok: false, error: error.message }
  const later = nav.vehicle_id
    ? await rebookNavsFrom(admin, fundId, userId, { companyId: nav.company_id, vehicleId: nav.vehicle_id, since: nav.as_of_date, inclusive: false })
    : []
  return later.length ? { ok: true, later } : { ok: true }
}

async function afterChange(
  admin: SupabaseClient, fundId: string, userId: string | null,
  navId: string, companyId: string, vehicleId: string | null, asOfDate: string,
): Promise<NavSaveResult> {
  const booking = await bookNavMark(admin, fundId, userId, navId)
  // Every newer statement was booked against a ledger that carried this one's old mark.
  const later = vehicleId
    ? await rebookNavsFrom(admin, fundId, userId, { companyId, vehicleId, since: asOfDate, inclusive: false })
    : []
  return { ok: true, navId, booking, ...(later.length ? { later } : {}) }
}

/**
 * Take back what this statement booked: retract its transaction's entry, delete the transaction,
 * clear the link. Returns a refusal (and changes nothing) when the entry cannot be retracted.
 */
async function unbook(admin: SupabaseClient, fundId: string, userId: string | null, nav: any): Promise<NavBooking | null> {
  const txnId = nav.investment_transaction_id as string
  const { data: txn } = await (admin as any).from('investment_transactions')
    .select('*').eq('fund_id', fundId).eq('id', txnId).maybeSingle()
  if (txn) {
    const retracted = await retractEntriesForTransaction(admin, fundId, txnId, { userId, original: txn })
    if (retracted.reason) return { status: 'refused', message: `Its earlier mark could not be taken back. ${retracted.reason}` }
    const { error } = await (admin as any).from('investment_transactions').delete().eq('id', txnId).eq('fund_id', fundId)
    if (error) return { status: 'refused', message: `Its earlier mark could not be removed: ${error.message}` }
  }
  const { error: unlinkError } = await (admin as any).from('fund_nav_statements')
    .update({ investment_transaction_id: null }).eq('id', nav.id).eq('fund_id', fundId)
  if (unlinkError) return { status: 'refused', message: `Its earlier mark was taken back, but the statement could not be updated to say so: ${unlinkError.message}` }
  return null
}

/** Book (or re-book) the mark one statement implies. Never throws. */
export async function bookNavMark(
  admin: SupabaseClient,
  fundId: string,
  userId: string | null,
  navId: string,
): Promise<NavBooking> {
  let unbooked = false
  // After the earlier mark was taken back, every failure has to say so: the ledger now carries none.
  const fail = (message: string): NavBooking => ({
    status: 'refused',
    message: unbooked ? `${message} Its earlier mark was taken back, so the ledger carries no mark for this statement.` : message,
  })
  try {
    const { data: nav } = await (admin as any).from('fund_nav_statements')
      .select('*').eq('fund_id', fundId).eq('id', navId).maybeSingle()
    if (!nav) return { status: 'refused', message: 'That statement no longer exists.' }

    const group = nav.vehicle_id ? await vehicleNameById(admin, fundId, nav.vehicle_id) : null
    const { data: settings } = nav.vehicle_id
      ? await (admin as any).from('vehicle_accounting_settings')
          .select('ledger_start_date').eq('fund_id', fundId).eq('vehicle_id', nav.vehicle_id).maybeSingle()
      : { data: null }
    const ledgerStartDate: string | null = settings?.ledger_start_date ?? null
    const asOf: string = nav.as_of_date
    const bookable = !!group && !(ledgerStartDate && asOf < ledgerStartDate)

    // The mark this statement implies against what the ledger carries right now. `derived` is false
    // when the register's position does not carry THIS statement (a stale or partial load): a mark
    // computed from it would be a delta against the wrong value.
    const compute = async () => {
      const [fof, ledger] = await Promise.all([
        loadFofData(admin, fundId, asOf, group!),
        loadPostedLedger(admin, fundId, group!, asOf),
      ])
      const position = fof.positions.find(p => p.companyId === nav.company_id)
      const derived = !!position && position.navAsOf === asOf && position.reportedNav !== null
        && Math.abs(position.reportedNav - Number(nav.reported_nav)) < 0.005
      const mark = position && derived
        ? periodEndMarks([position], ledgerCarryingByHolding(ledger.accounts as any, ledger.postings as any), asOf)[0] ?? null
        : null
      const draft = mark
        ? transactionForNav(
            { companyId: nav.company_id, asOfDate: asOf, reportedNav: mark.derivedCarrying, basis: nav.basis },
            { carriedValue: mark.ledgerCarrying, ledgerStartDate },
          )
        : null
      return { position, draft, derived }
    }
    const UNDERIVED = 'Saved, but its mark could not be derived from the fund register; nothing was booked.'

    if (nav.investment_transaction_id) {
      // Same reported NAV, same carrying value with the existing mark in place: it is already right.
      // Retracting and re-posting would change nothing, and would fail in a closed period for it.
      if (bookable) {
        const current = await compute()
        // Refuse before taking anything back: an underived mark must not cost the ledger its current one.
        if (!current.derived) return fail(UNDERIVED)
        if (current.position && !current.draft) {
          return { status: 'no_change', transactionId: nav.investment_transaction_id, message: 'Saved. Its mark already matches this statement, so nothing was re-booked.' }
        }
      }
      const refused = await unbook(admin, fundId, userId, nav)
      if (refused) return refused
      unbooked = true
    }
    if (!group) return { status: 'no_entity', message: NO_ENTITY + (unbooked ? ' Its earlier mark was taken back.' : '') }
    if (!bookable) {
      return { status: 'before_ledger_start', message: `Saved. It is dated before this entity's ledger starts (${ledgerStartDate}), so no mark was booked.${unbooked ? ' Its earlier mark was taken back.' : ''}` }
    }

    const { draft, derived } = await compute()
    if (!derived) return fail(UNDERIVED)
    if (!draft) {
      return {
        status: 'no_change',
        message: 'Saved. The ledger already carries this value, so there was no mark to book.'
          + (unbooked ? ' Its earlier mark was taken back.' : ''),
      }
    }

    const { data: holding } = await admin.from('companies')
      .select('name, holding_type').eq('id', nav.company_id).eq('fund_id', fundId).maybeSingle()
    const { data: txn, error } = await (admin as any).from('investment_transactions').insert({
      ...draft,
      fund_id: fundId,
      portfolio_group: group,
      valuation_change_source: 'nav',
      notes: `Manager NAV as of ${asOf}`,
    }).select('*').single()
    if (error || !txn) return fail(`Saved, but the mark could not be recorded: ${error?.message ?? 'insert failed'}`)

    const entry = await draftEntryForTransaction(admin, fundId, userId, txn, (holding as any)?.name ?? 'Fund')
    if (!entry.drafted) {
      // No entry, no mark: a transaction left behind would be a value the ledger does not carry.
      await (admin as any).from('investment_transactions').delete().eq('id', txn.id).eq('fund_id', fundId)
      return fail(`Saved, but its mark was not booked. ${entry.reason ?? ''}`.trim())
    }
    const { error: linkError } = await (admin as any).from('fund_nav_statements')
      .update({ investment_transaction_id: txn.id }).eq('id', nav.id).eq('fund_id', fundId)
    const posted = entry.posted !== false
    const unlinked = linkError
      ? ` But the statement could not be linked to its mark (${linkError.message}), so changing or deleting the statement will not take this mark back — reverse it on the holding's transactions if you change it.`
      : ''
    return {
      status: 'booked',
      transactionId: txn.id,
      delta: draft.unrealized_value_change,
      posted,
      message: (posted ? 'Saved, and its mark posted to the ledger.' : `Saved; its mark is kept as a draft entry: ${entry.reason ?? 'the partner allocation failed'}`) + unlinked,
    }
  } catch (e) {
    return fail(`Saved, but its mark was not booked: ${(e as Error).message}`)
  }
}

/**
 * Re-book EVERY statement for a holding and entity dated after `since` (or on it, when inclusive),
 * oldest first, so each is derived against a ledger that already holds the earlier corrected marks.
 * A refusal (a closed period) does not stop the rest; each booking is returned, refusals included.
 */
export async function rebookNavsFrom(
  admin: SupabaseClient,
  fundId: string,
  userId: string | null,
  at: { companyId: string; vehicleId: string; since: string; inclusive: boolean },
): Promise<NavBooking[]> {
  const q = (admin as any).from('fund_nav_statements').select('id')
    .eq('fund_id', fundId).eq('company_id', at.companyId).eq('vehicle_id', at.vehicleId)
  const { data, error } = await (at.inclusive ? q.gte('as_of_date', at.since) : q.gt('as_of_date', at.since))
    .order('as_of_date', { ascending: true })
  if (error) return [{ status: 'refused', message: `The statements after this one could not be read, so none was re-booked: ${error.message}` }]
  const out: NavBooking[] = []
  for (const row of ((data as { id: string }[] | null) ?? [])) out.push(await bookNavMark(admin, fundId, userId, row.id))
  return out
}
