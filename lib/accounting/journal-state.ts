// Changing a journal entry's state, shared by PATCH /api/accounting/journal and the unpost_entry,
// reverse_entry and void_entry agent tools:
//   post    → a draft becomes posted (it hits the ledger)
//   unpost  → back to draft so it can be edited and re-posted
//   void    → from POSTED, reverse its effect on the ledger (audit-safe correction);
//             from DRAFT, discard it — the only way to get rid of a draft, which until now
//             was a one-way door you could only edit or post. The bank page has always done
//             this to drafts via its Ignore action; the journal simply couldn't reach it.
//   reverse → a dated contra-entry; the original stays posted.
// All but reverse are refused if the entry falls in a closed period (reopen it first).
//
// The reply is the route's response as it always was: a status and a JSON body, the body carrying
// what was released on failure too (removedTransactions, unlinkedRegisterRows). Unpost, reverse and
// voiding a posted entry are admin-only (lib/access/admin-only.ts: the middleware by action for the
// route, ADMIN_ONLY_TOOLS for the tools; voiding a posted entry is checked here, from the row).

import type { SupabaseClient } from '@supabase/supabase-js'
import { adminOnlyDenial, HANDLER_CHECKED } from '@/lib/access/admin-only'
import { auditReason, recordAudit } from '@/lib/audit/events'
import { persistEntry } from './persist'
import { closedPeriodRanges, dateInAnyClosedPeriod } from './periods'
import { ACTUAL_BOOK } from './books'
import { reversalOf, reversalDateError } from './reversal'
import { postExistingEntryWithAllocation, setGeneratedAllocationStatus } from './continuous-allocation'
import { releaseOwnership, planRelease, deleteOwners, isLiveInvestmentReversalHalf, HALF_OF_A_PAIR } from './ownership'
import { isInvestmentAccount, loadVehicleChart } from './investment-accounts'
import { NEEDS_INVESTMENTS_WRITE } from './investment-access'

export interface EntryStateCaller {
  fundId: string
  role: string
  userId: string
  /** Whether the caller may also write investments (lib/accounting/investment-access.ts); read once, when needed. */
  mayTouchInvestments: () => Promise<boolean>
}

export interface EntryStateReply {
  status: number
  body: Record<string, unknown>
}

export interface EntryStateRequest {
  id?: unknown
  action?: unknown
  reason?: unknown
  reverseDate?: unknown
  post?: unknown
}

const reply = (body: Record<string, unknown>, status = 200): EntryStateReply => ({ status, body })

// A database failure after the owning transactions were already deleted: still generic to the
// client, but it must say what is gone.
function failedAfterRelease(error: { message: string }, context: string, released: { removed: unknown[]; unlinked: string[] }): EntryStateReply {
  console.error(`[${context}]`, error.message)
  return reply({ error: 'An unexpected error occurred.', removedTransactions: released.removed, unlinkedRegisterRows: released.unlinked }, 500)
}

export async function changeEntryState(
  admin: SupabaseClient,
  who: EntryStateCaller,
  group: string,
  vehicleId: string | null,
  body: EntryStateRequest | any,
): Promise<EntryStateReply> {
  const { id, action } = body
  if (!id || !['post', 'unpost', 'void', 'reverse'].includes(action)) {
    return reply({ error: "id and action ('post'|'unpost'|'void'|'reverse') are required" }, 400)
  }

  const { data: existing } = await admin
    .from('journal_entries' as any)
    .select('id, status, entry_date, memo, source_type, reference, reversed_by, adjusting, source_ref')
    .eq('book', ACTUAL_BOOK)
    .eq('id', id).eq('fund_id', who.fundId).eq('vehicle_id', vehicleId)
    .maybeSingle()
  if (!existing) return reply({ error: 'Entry not found' }, 404)

  const status = (existing as any).status
  // Voiding a POSTED entry undoes the books, so it is admin-only like unpost and reverse (which the
  // middleware refuses by action); voiding a draft is just discarding it. Only the row says which.
  if (action === 'void' && status === 'posted') {
    const denial = adminOnlyDenial(who.role, HANDLER_CHECKED.voidPostedEntry)
    if (denial) return reply({ error: denial }, 403)
  }
  // Undoing what was posted needs a reason, recorded with who did it (accounting_audit_events).
  // Discarding a draft does not: nothing it held was ever on the books.
  const reason = auditReason(body.reason)
  if (!reason && (action === 'unpost' || action === 'reverse' || (action === 'void' && status === 'posted'))) {
    return reply({ error: `A reason is required to ${action} a posted entry.` }, 400)
  }
  const audit = (a: 'entry.post' | 'entry.unpost' | 'entry.void' | 'entry.reverse', details: Record<string, unknown> = {}) => recordAudit(admin, {
    fundId: who.fundId, vehicleId, actorId: who.userId, action: a, subjectType: 'journal_entry', subjectId: id, reason,
    details: { entryDate: (existing as any).entry_date, memo: (existing as any).memo ?? null, reference: (existing as any).reference ?? null, priorStatus: status, ...details },
  })
  // Void, unpost and reverse on an OWNED entry delete the transactions that own it (spec §1) —
  // which needs investments write as well as accounting write.
  let mayInvest: boolean | null = null
  const mayTouch = async () => (mayInvest ??= await who.mayTouchInvestments())
  const release = async (): Promise<Awaited<ReturnType<typeof releaseOwnership>> | 'denied'> => {
    const plan = await planRelease(admin, who.fundId, existing as any)
    if ('error' in plan) return plan
    if (plan.removed.length > 0 && !(await mayTouch())) return 'denied'
    return (await deleteOwners(admin, who.fundId, existing as any, plan)) ?? plan
  }

  // reverse → a dated contra-entry (lib/accounting/reversal.ts). The original stays posted and
  // may sit in a CLOSED period — that is the case a reversal exists for — so the closed-period
  // check applies to the reversal's date, not the original's. Lands as a draft unless asked to
  // post, so the correction is seen before it hits the accounts.
  if (action === 'reverse') {
    const ex = existing as any
    if (status !== 'posted') {
      return reply({ error: 'Only a posted entry can be reversed — a draft can be edited or discarded.' }, 400)
    }
    if (ex.reversed_by) {
      // A discarded reversal draft leaves the link behind; only a live reversal blocks a second one.
      const { data: prior } = await admin.from('journal_entries' as any).select('status').eq('book', ACTUAL_BOOK).eq('id', ex.reversed_by).maybeSingle()
      if (prior && (prior as any).status !== 'void') {
        return reply({ error: 'That entry has already been reversed.' }, 400)
      }
    }
    const reverseDate: string | undefined = body.reverseDate
    const dateErr = reversalDateError(ex.entry_date, reverseDate)
    if (dateErr) return reply({ error: dateErr }, 400)
    const closed = await closedPeriodRanges(admin, who.fundId, group)
    if (dateInAnyClosedPeriod(closed, reverseDate!)) {
      return reply({ error: 'The reversal date falls in a closed period — pick a date in an open one.' }, 400)
    }
    const { data: postingRows } = await admin
      .from('journal_postings' as any)
      .select('account_id, amount, currency, lp_entity_id')
      .eq('book', ACTUAL_BOOK).eq('journal_entry_id', id)
    const plan = await planRelease(admin, who.fundId, ex)
    if ('error' in plan) return reply({ error: plan.error }, 400)
    // A posted reversal deletes the transactions now; a draft one when it posts (checked then).
    if (body.post === true && plan.removed.length > 0 && !(await mayTouch())) return reply({ error: NEEDS_INVESTMENTS_WRITE }, 403)
    const reversal = reversalOf({
      id, fundId: who.fundId, entryDate: ex.entry_date, memo: ex.memo, sourceType: ex.source_type, reference: ex.reference, adjusting: ex.adjusting === true,
      postings: ((postingRows as any[]) ?? []).map(p => ({ accountId: p.account_id, amount: Number(p.amount), currency: p.currency ?? 'USD', lpEntityId: p.lp_entity_id ?? null })),
    }, reverseDate!)
    const reversalStatus = body.post === true ? 'posted' : 'draft'
    const result = await persistEntry(admin, who.fundId, group, who.userId, reversal, reversalStatus)
    if ('error' in result) return reply({ error: result.error }, 400)
    // Without the link a second reverse is allowed and the backfill no longer sees the pair (it
    // would adopt the original as a fresh purchase). So a failed link undoes the reversal.
    const { error: linkErr } = await admin.from('journal_entries' as any).update({ reversed_by: result.entryId }).eq('id', id).eq('fund_id', who.fundId)
    if (linkErr) {
      console.error('[journal-reverse-link]', linkErr.message)
      const allocation = await setGeneratedAllocationStatus(admin, who.fundId, result.entryId, 'void')
      const { error: voidErr } = await admin.from('journal_entries' as any).update({ status: 'void', posted_at: null })
        .eq('book', ACTUAL_BOOK).eq('id', result.entryId).eq('fund_id', who.fundId)
      const undone = !allocation.error && !voidErr
      return reply({
        error: undone
          ? 'The reversal could not be linked to this entry, so it was discarded. Nothing changed — try again.'
          : `The reversal could not be linked to this entry, and discarding it failed too. Void reversal ${result.entryId} from the journal, then try again.`,
        removedTransactions: [], unlinkedRegisterRows: [],
      }, 500)
    }
    // A reversal saved as a draft changes nothing on the books, so the tracker keeps the
    // transaction; posting the draft releases it (postExistingEntryWithAllocation).
    await audit('entry.reverse', { reversalId: result.entryId, reverseDate, reversalStatus })
    if (reversalStatus === 'draft') {
      return reply({ ok: true, reversalId: result.entryId, status: reversalStatus, reverseDate, removedTransactions: [], unlinkedRegisterRows: [] })
    }
    // Only now, with the reversal on the books (owned as a pair while the transaction still
    // exists), delete the owners. A failed reversal above leaves everything as it was.
    const failed = await deleteOwners(admin, who.fundId, ex, plan)
    return reply({
      ok: true, reversalId: result.entryId, status: reversalStatus, reverseDate,
      removedTransactions: failed ? failed.removed : plan.removed, unlinkedRegisterRows: failed ? failed.unlinked : plan.unlinked,
      ...(failed ? { warning: `The reversal was created, but ${failed.error}` } : {}),
    })
  }
  if (action === 'post' && status !== 'draft') {
    return reply({ error: 'Only a draft entry can be posted' }, 400)
  }
  if (action === 'unpost' && status !== 'posted') {
    return reply({ error: 'Only a posted entry can be unposted' }, 400)
  }
  // Void takes a draft (discard) or a posted entry (reverse). Only an already-void entry
  // has nothing left to do.
  if (action === 'void' && status !== 'draft' && status !== 'posted') {
    return reply({ error: 'That entry is already void' }, 400)
  }

  const closed = await closedPeriodRanges(admin, who.fundId, group)
  if (dateInAnyClosedPeriod(closed, (existing as any).entry_date)) {
    return reply({ error: 'That entry is in a closed period — reopen it first.' }, 400)
  }

  if (action === 'post') {
    // postExistingEntryWithAllocation rolls its own failure back to draft. Reverting here as well
    // would undo ANOTHER request's post when this one merely lost the race to it.
    const allocated = await postExistingEntryWithAllocation(admin, who.fundId, group, who.userId, id, { investments: await mayTouch() })
    if ('error' in allocated) {
      return reply({ error: `Entry was not posted: ${allocated.error}` }, allocated.error === NEEDS_INVESTMENTS_WRITE ? 403 : 400)
    }
    // Keep any bank transaction that points at this entry in step.
    await admin.from('bank_transactions' as any).update({ status: 'reconciled' }).eq('journal_entry_id', id).eq('fund_id', who.fundId)
    await audit('entry.post')
    // Posting a reversal draft deletes the transactions that owned the entry it reverses.
    return reply({
      ok: true, status: 'posted',
      removedTransactions: allocated.removedTransactions ?? [], unlinkedRegisterRows: allocated.unlinkedRegisterRows ?? [],
      ...(allocated.warning ? { warning: allocated.warning } : {}),
    })
  }

  // Either half of a live reversal pair on investment accounts: voiding or unposting it would
  // break the pair the tracker was reconciled against. Reverse the reversal instead.
  if (action === 'void' || action === 'unpost') {
    try {
      const chart = await loadVehicleChart(admin, who.fundId, vehicleId!)
      const investment = new Set(chart.filter(isInvestmentAccount).map(a => a.id))
      if (await isLiveInvestmentReversalHalf(admin, who.fundId, existing as any, investment)) {
        return reply({ error: HALF_OF_A_PAIR }, 400)
      }
    } catch (e) {
      return reply({ error: e instanceof Error ? e.message : String(e) }, 400)
    }
  }

  if (action === 'unpost') {
    const released = await release()
    if (released === 'denied') return reply({ error: NEEDS_INVESTMENTS_WRITE }, 403)
    if ('error' in released) return reply({ error: released.error, removedTransactions: released.removed ?? [], unlinkedRegisterRows: released.unlinked ?? [] }, 400)
    const linked = await setGeneratedAllocationStatus(admin, who.fundId, id, 'draft')
    if (linked.error) return reply({ error: linked.error, removedTransactions: released.removed, unlinkedRegisterRows: released.unlinked }, 400)
    const { error } = await admin.from('journal_entries' as any).update({ status: 'draft', posted_at: null }).eq('id', id).eq('fund_id', who.fundId)
    if (error) return failedAfterRelease(error, 'journal-unpost', released)
    // Keep any bank transaction that points at this entry in step.
    await admin.from('bank_transactions' as any).update({ status: 'drafted' }).eq('journal_entry_id', id).eq('fund_id', who.fundId)
    await audit('entry.unpost', { removedTransactions: released.removed })
    return reply({ ok: true, status: 'draft', removedTransactions: released.removed, unlinkedRegisterRows: released.unlinked })
  }

  // `posted_at: null` matches what the bank page's Ignore writes, so an entry voided from
  // either surface looks identical afterwards.
  const released = await release()
  if (released === 'denied') return reply({ error: NEEDS_INVESTMENTS_WRITE }, 403)
  if ('error' in released) return reply({ error: released.error, removedTransactions: released.removed ?? [], unlinkedRegisterRows: released.unlinked ?? [] }, 400)
  const linked = await setGeneratedAllocationStatus(admin, who.fundId, id, 'void')
  if (linked.error) return reply({ error: linked.error, removedTransactions: released.removed, unlinkedRegisterRows: released.unlinked }, 400)
  const { error } = await admin.from('journal_entries' as any).update({ status: 'void', posted_at: null }).eq('id', id).eq('fund_id', who.fundId)
  if (error) return failedAfterRelease(error, 'journal-void', released)
  await admin.from('bank_transactions' as any).update({ status: 'ignored' }).eq('journal_entry_id', id).eq('fund_id', who.fundId)
  await audit('entry.void', { removedTransactions: released.removed })
  return reply({ ok: true, status: 'void', removedTransactions: released.removed, unlinkedRegisterRows: released.unlinked })
}
