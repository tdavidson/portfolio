// Editing a DRAFT journal entry: its lines (account, signed amount, partner), date, memo, reference,
// payee, source type and adjusting flag. Shared by PUT /api/accounting/journal (the entry form's
// Save) and the edit_draft_entry agent tool, so both doors run the same checks in the same order:
//
//   - a proposer edits only their own proposals, while still drafts (proposerChangeProblem);
//   - posted entries are immutable: unpost, reverse or void them instead;
//   - every line's account must be this entity's, and its partner one of this entity's partners
//     (validatePostings, the same check a new entry gets);
//   - the lines balance, and neither the old nor the new date falls in a closed period;
//   - a derived draft (the allocation-failure fallback) gives up the investment transaction it
//     came from, which needs investments write.
//
// Postings are replaced wholesale: the new lines are inserted before the old ones are deleted, so a
// failure never leaves the entry without lines. The reply is the route's response as it always was:
// a status and a JSON body that carries what was released (removedTransactions, unlinkedRegisterRows).

import type { SupabaseClient } from '@supabase/supabase-js'
import { validatePostings } from './persist'
import { assertBalanced } from './ledger'
import { closedPeriodRanges, dateInAnyClosedPeriod } from './periods'
import { fundCurrency } from './currency'
import type { JournalEntry, Posting } from './types'
import { vendorInFund } from './vendors'
import { ACTUAL_BOOK } from './books'
import { planRelease, deleteOwners } from './ownership'
import { NEEDS_INVESTMENTS_WRITE } from './investment-access'
import { proposerChangeProblem } from './proposals'

export interface DraftEditCaller {
  fundId: string
  userId: string | null
  /** The caller has the `propose` level here, not write (lib/accounting/proposals.ts isProposer). */
  proposing: boolean
  /** Whether the caller may also write investments (lib/accounting/investment-access.ts); read once, when needed. */
  mayTouchInvestments: () => Promise<boolean>
}

export interface DraftEditRequest {
  id?: unknown
  entryDate?: unknown
  memo?: unknown
  reference?: unknown
  sourceType?: unknown
  vendorId?: unknown
  adjusting?: unknown
  /** Every line of the entry, in full: { accountId, amount (signed, debit positive), lpEntityId? }. */
  postings?: unknown
}

export interface DraftEditOptions {
  /**
   * Leave the memo and reference as they are when the request omits them. The entry form always
   * sends both, so for the web an absent memo has always meant "no memo"; a tool caller that only
   * re-points a line should not wipe the memo by leaving it out. null still clears either.
   */
  keepOmitted?: boolean
}

export interface DraftEditReply {
  status: number
  body: Record<string, unknown>
}

const reply = (body: Record<string, unknown>, status = 200): DraftEditReply => ({ status, body })

// A database failure after the owning transactions were already deleted: still generic to the
// client, but it must say what is gone.
function failedAfterRelease(error: { message: string }, context: string, released: { removed: unknown[]; unlinked: string[] }): DraftEditReply {
  console.error(`[${context}]`, error.message)
  return reply({ error: 'An unexpected error occurred.', removedTransactions: released.removed, unlinkedRegisterRows: released.unlinked }, 500)
}

export async function editDraftEntry(
  admin: SupabaseClient,
  who: DraftEditCaller,
  group: string,
  vehicleId: string | null,
  body: DraftEditRequest | any,
  opts: DraftEditOptions = {},
): Promise<DraftEditReply> {
  const { id, entryDate, postings } = body ?? {}
  if (!id || !Array.isArray(postings) || postings.length === 0) {
    return reply({ error: 'id and at least one posting are required' }, 400)
  }
  // A proposer (the `propose` level, not write) edits only their own proposals, while still drafts.
  if (who.proposing) {
    const problem = who.userId
      ? await proposerChangeProblem(admin, { fundId: who.fundId, entryId: String(id), userId: who.userId })
      : 'You can propose journal entries, and change or withdraw only your own proposals while they are drafts.'
    if (problem) return reply({ error: problem }, 403)
  }

  const { data: existing } = await admin
    .from('journal_entries' as any)
    .select('id, status, entry_date, memo, reference, source_type, source_ref')
    .eq('book', ACTUAL_BOOK)
    .eq('id', id).eq('fund_id', who.fundId).eq('vehicle_id', vehicleId)
    .maybeSingle()
  if (!existing) return reply({ error: 'Entry not found' }, 404)
  if ((existing as any).status !== 'draft') return reply({ error: 'Only draft entries can be edited — reverse or void a posted entry.' }, 400)
  // The source type is kept unless the caller sets it: editing a bank-drafted capital call must
  // not silently turn it into a "manual" entry that the roll-forward files under Other.
  const sourceType: string = typeof body.sourceType === 'string' && body.sourceType ? body.sourceType : ((existing as any).source_type ?? 'manual')
  const keep = opts.keepOmitted === true
  const reference = keep && body.reference === undefined
    ? ((existing as any).reference ?? null)
    : (typeof body.reference === 'string' && body.reference.trim() ? body.reference.trim().slice(0, 80) : null)
  const memo = keep && body.memo === undefined ? ((existing as any).memo ?? null) : (body.memo ?? null)
  // The payee. Absent leaves it alone; null clears it; an id must be one of this fund's vendors.
  const vendorPatch = 'vendorId' in body ? { vendor_id: await vendorInFund(admin, who.fundId, body.vendorId) } : {}

  // The fund's currency, never a client-supplied one. The ledger is denominated in a single
  // currency by design (see lib/accounting/currency.ts); accepting `p.currency` from the body
  // would let a posting balance against the wrong denomination.
  let currency: string
  try { currency = await fundCurrency(admin, who.fundId) } catch (e) {
    console.error('[accounting-journal-currency]', e instanceof Error ? e.message : e)
    return reply({ error: "The fund's currency could not be read, so nothing was saved. Try again." }, 500)
  }
  const normalized: Posting[] = postings.map((p: any) => ({ accountId: p?.accountId, amount: Number(p?.amount), currency, lpEntityId: p?.lpEntityId ?? null }))
  if (normalized.some(p => !p.accountId || !Number.isFinite(p.amount))) {
    return reply({ error: 'Each posting needs an accountId and a numeric amount' }, 400)
  }
  // The same account and partner checks as a new entry (persistEntry): a leg on another entity's
  // account would drop out of every statement, and a partner from elsewhere would be booked here.
  if (!vehicleId) return reply({ error: 'Entry not found' }, 404)
  const postingProblem = await validatePostings(admin, who.fundId, vehicleId, group, normalized)
  if (postingProblem) return reply({ error: postingProblem }, 400)
  const newDate = entryDate || (existing as any).entry_date
  const entry: JournalEntry = { fundId: who.fundId, entryDate: newDate, memo, sourceType, postings: normalized }
  try { assertBalanced(entry) } catch (e) { return reply({ error: (e as Error).message }, 400) }

  const closed = await closedPeriodRanges(admin, who.fundId, group)
  if (dateInAnyClosedPeriod(closed, newDate) || dateInAnyClosedPeriod(closed, (existing as any).entry_date)) {
    return reply({ error: 'That date falls in a closed period — reopen it to edit.' }, 400)
  }

  // A derived draft (the allocation-failure fallback) edited by hand no longer says what its
  // transaction says: delete the transaction, and the edited lines are adopted when it posts.
  const plan = await planRelease(admin, who.fundId, existing as any)
  if ('error' in plan) return reply({ error: plan.error, removedTransactions: [], unlinkedRegisterRows: [] }, 400)
  if (plan.removed.length > 0 && !(await who.mayTouchInvestments())) return reply({ error: NEEDS_INVESTMENTS_WRITE }, 403)
  const releaseFailed = await deleteOwners(admin, who.fundId, existing as any, plan)
  if (releaseFailed) return reply({ error: releaseFailed.error, removedTransactions: releaseFailed.removed, unlinkedRegisterRows: releaseFailed.unlinked }, 400)
  const released = plan

  // Insert the new postings first, then drop the old ones — so a failure never
  // leaves the entry without lines.
  const { data: oldRows } = await admin.from('journal_postings' as any).select('id').eq('book', ACTUAL_BOOK).eq('journal_entry_id', id)
  const oldIds = ((oldRows as any[]) ?? []).map(r => r.id)
  const { error: insErr } = await admin.from('journal_postings' as any).insert(
    normalized.map(p => ({ fund_id: who.fundId, portfolio_group: group, vehicle_id: vehicleId, journal_entry_id: id, account_id: p.accountId, amount: p.amount, currency: p.currency, lp_entity_id: p.lpEntityId ?? null }))
  )
  if (insErr) return failedAfterRelease(insErr, 'accounting-journal-update', released)
  if (oldIds.length) await admin.from('journal_postings' as any).delete().in('id', oldIds)
  const adjustingPatch = typeof body.adjusting === 'boolean' ? { adjusting: body.adjusting } : {}
  await admin.from('journal_entries' as any).update({ entry_date: newDate, memo, source_type: sourceType, reference, ...adjustingPatch, ...vendorPatch }).eq('id', id).eq('fund_id', who.fundId)

  const { data: full } = await admin.from('journal_entries' as any).select('*, journal_postings(*)').eq('id', id).eq('book', ACTUAL_BOOK).single()
  return reply({ ...((full ?? { id }) as object), removedTransactions: released.removed, unlinkedRegisterRows: released.unlinked })
}
