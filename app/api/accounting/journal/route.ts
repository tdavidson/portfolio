import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). The middleware has already checked the caller's
// grant for this route + method; these resolve identity and keep the demo out of writes.
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { dbError } from '@/lib/api-error'
import { persistEntry } from '@/lib/accounting/persist'
import { assertBalanced } from '@/lib/accounting/ledger'
import { closedPeriodRanges, dateInAnyClosedPeriod } from '@/lib/accounting/periods'
import { fundCurrency } from '@/lib/accounting/currency'
import { resolvePeriod, customPeriod, type PeriodPreset } from '@/lib/accounting/statement-period'
import type { JournalEntry, Posting } from '@/lib/accounting/types'
import { vendorInFund } from '@/lib/accounting/vendors'
import { ACTUAL_BOOK, isLedgerBook, type LedgerBook } from '@/lib/accounting/books'
import { reversalOf, reversalDateError } from '@/lib/accounting/reversal'
import { postExistingEntryWithAllocation, setGeneratedAllocationStatus } from '@/lib/accounting/continuous-allocation'
import { owningTransactions, releaseOwnership, planRelease, deleteOwners } from '@/lib/accounting/ownership'
import { entriesAwaitingBankMatch, AWAITING_BANK_MATCH_REASON } from '@/lib/accounting/investment-bank-match'

// A database failure after the owning transactions were already deleted: still generic to the
// client, but it must say what is gone.
function failedAfterRelease(error: { message: string }, context: string, released: { removed: unknown[]; unlinked: string[] }) {
  console.error(`[${context}]`, error.message)
  return NextResponse.json(
    { error: 'An unexpected error occurred.', removedTransactions: released.removed, unlinkedRegisterRows: released.unlinked },
    { status: 500 },
  )
}

// GET — the vehicle's journal entries with postings, or a single entry via ?id=.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)

  // ?book=tax lists the book-to-tax adjusting entries instead of the ledger. Read-only from the
  // journal's point of view: they are written and rewritten by the tax run (book-tax-run.ts).
  const bookParam = req.nextUrl.searchParams.get('book')
  const book: LedgerBook = isLedgerBook(bookParam) ? bookParam : ACTUAL_BOOK

  const base = admin
    .from('journal_entries' as any)
    .select('*, journal_postings(*)')
    .eq('book', book)
    .eq('fund_id', gate.fundId)
    .eq('vehicle_id', vehicleId)

  const id = req.nextUrl.searchParams.get('id')
  if (id) {
    const { data, error } = await base.eq('id', id).maybeSingle()
    if (error) return dbError(error, 'accounting-journal')
    if (!data) return NextResponse.json(null)
    // The transactions that own it — the entry view names them beside void, unpost and reverse.
    return NextResponse.json({ ...(data as object), owned_by: await owningTransactions(admin, gate.fundId, data as any) })
  }

  // List path: resolve the period window (default YTD), then hand filtering + pagination
  // to the RPC so search spans account names/amounts across all pages.
  const sp = req.nextUrl.searchParams
  const preset = (sp.get('preset') as PeriodPreset | null) ?? 'ytd'
  const period = preset === 'custom'
    ? customPeriod(sp.get('start'), sp.get('end'))
    : resolvePeriod(preset)
  const limit = Math.min(Math.max(parseInt(sp.get('limit') ?? '50', 10) || 50, 1), 200)
  const offset = Math.max(parseInt(sp.get('offset') ?? '0', 10) || 0, 0)
  // Status filter: draft | posted | void picks exactly that one. Anything else — including
  // 'all' and an omitted param — means draft + posted: a voided entry has been discarded, and
  // leaving it in the default list is the opposite of discarding it. Ask for 'void' to see them.
  const statusParam = sp.get('status')
  const statuses = ['draft', 'posted', 'void'].includes(statusParam ?? '')
    ? [statusParam as string]
    : ['draft', 'posted']

  // ?adjusting=1 lists only entries flagged adjusting — the AJE list; ?adjusting=0 only the rest.
  const adjParam = sp.get('adjusting')
  const adjusting = adjParam === '1' || adjParam === 'true' ? true : adjParam === '0' || adjParam === 'false' ? false : null

  const { data, error } = await admin.rpc('journal_search' as any, {
    p_fund_id: gate.fundId,
    p_vehicle_id: vehicleId,
    p_start: period.start,
    p_end: period.end,
    p_query: sp.get('q'),
    p_statuses: statuses,
    p_limit: limit,
    p_offset: offset,
    p_book: book,
    p_adjusting: adjusting,
  })
  if (error) return dbError(error, 'accounting-journal')
  return NextResponse.json(data ?? { entries: [], total: 0 })
}

// PUT — replace a DRAFT entry's postings (and date/memo). Posted entries are
// immutable; reverse or void them instead.
export async function PUT(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const group = await resolveGroupOr400(admin, gate, body?.group ?? req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)

  const { id, entryDate, memo, postings } = body
  if (!id || !Array.isArray(postings) || postings.length === 0) {
    return NextResponse.json({ error: 'id and at least one posting are required' }, { status: 400 })
  }

  const { data: existing } = await admin
    .from('journal_entries' as any)
    .select('id, status, entry_date, source_type, source_ref')
    .eq('book', ACTUAL_BOOK)
    .eq('id', id).eq('fund_id', gate.fundId).eq('vehicle_id', vehicleId)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'Entry not found' }, { status: 404 })
  if ((existing as any).status !== 'draft') return NextResponse.json({ error: 'Only draft entries can be edited — reverse or void a posted entry.' }, { status: 400 })
  // The source type is kept unless the caller sets it: editing a bank-drafted capital call must
  // not silently turn it into a "manual" entry that the roll-forward files under Other.
  const sourceType: string = typeof body.sourceType === 'string' && body.sourceType ? body.sourceType : ((existing as any).source_type ?? 'manual')
  const reference = typeof body.reference === 'string' && body.reference.trim() ? body.reference.trim().slice(0, 80) : null
  // The payee. Absent leaves it alone; null clears it; an id must be one of this fund's vendors.
  const vendorPatch = 'vendorId' in body ? { vendor_id: await vendorInFund(admin, gate.fundId, body.vendorId) } : {}

  // The fund's currency, never a client-supplied one. The ledger is denominated in a single
  // currency by design (see lib/accounting/currency.ts); accepting `p.currency` from the body
  // would let a posting balance against the wrong denomination.
  const currency = await fundCurrency(admin, gate.fundId)
  const normalized: Posting[] = postings.map((p: any) => ({ accountId: p.accountId, amount: Number(p.amount), currency, lpEntityId: p.lpEntityId ?? null }))
  if (normalized.some(p => !p.accountId || !Number.isFinite(p.amount))) {
    return NextResponse.json({ error: 'Each posting needs an accountId and a numeric amount' }, { status: 400 })
  }
  const newDate = entryDate || (existing as any).entry_date
  const entry: JournalEntry = { fundId: gate.fundId, entryDate: newDate, memo: memo ?? null, sourceType, postings: normalized }
  try { assertBalanced(entry) } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }) }

  const closed = await closedPeriodRanges(admin, gate.fundId, group)
  if (dateInAnyClosedPeriod(closed, newDate) || dateInAnyClosedPeriod(closed, (existing as any).entry_date)) {
    return NextResponse.json({ error: 'That date falls in a closed period — reopen it to edit.' }, { status: 400 })
  }

  // A derived draft (the allocation-failure fallback) edited by hand no longer says what its
  // transaction says: delete the transaction, and the edited lines are adopted when it posts.
  const released = await releaseOwnership(admin, gate.fundId, existing as any)
  if ('error' in released) return NextResponse.json({ error: released.error }, { status: 400 })

  // Insert the new postings first, then drop the old ones — so a failure never
  // leaves the entry without lines.
  const { data: oldRows } = await admin.from('journal_postings' as any).select('id').eq('book', ACTUAL_BOOK).eq('journal_entry_id', id)
  const oldIds = ((oldRows as any[]) ?? []).map(r => r.id)
  const { error: insErr } = await admin.from('journal_postings' as any).insert(
    normalized.map(p => ({ fund_id: gate.fundId, portfolio_group: group, vehicle_id: vehicleId, journal_entry_id: id, account_id: p.accountId, amount: p.amount, currency: p.currency, lp_entity_id: p.lpEntityId ?? null }))
  )
  if (insErr) return failedAfterRelease(insErr, 'accounting-journal-update', released)
  if (oldIds.length) await admin.from('journal_postings' as any).delete().in('id', oldIds)
  const adjustingPatch = typeof body.adjusting === 'boolean' ? { adjusting: body.adjusting } : {}
  await admin.from('journal_entries' as any).update({ entry_date: newDate, memo: memo ?? null, source_type: sourceType, reference, ...adjustingPatch, ...vendorPatch }).eq('id', id).eq('fund_id', gate.fundId)

  const { data: full } = await admin.from('journal_entries' as any).select('*, journal_postings(*)').eq('id', id).eq('book', ACTUAL_BOOK).single()
  return NextResponse.json({ ...((full ?? { id }) as object), removedTransactions: released.removed, unlinkedRegisterRows: released.unlinked })
}

// POST — create a balanced journal entry with its postings.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json()
  const group = await resolveGroupOr400(admin, gate, body?.group ?? req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  const { entryDate, memo, sourceType, sourceRef, status, postings } = body
  if (!entryDate || !Array.isArray(postings) || postings.length === 0) {
    return NextResponse.json({ error: 'entryDate and at least one posting are required' }, { status: 400 })
  }
  const reference = typeof body.reference === 'string' && body.reference.trim() ? body.reference.trim().slice(0, 80) : null
  // The fund's currency, never a client-supplied one. The ledger is denominated in a single
  // currency by design (see lib/accounting/currency.ts); accepting `p.currency` from the body
  // would let a posting balance against the wrong denomination.
  const currency = await fundCurrency(admin, gate.fundId)
  const normalized: Posting[] = postings.map((p: any) => ({ accountId: p.accountId, amount: Number(p.amount), currency, lpEntityId: p.lpEntityId ?? null }))
  if (normalized.some(p => !p.accountId || !Number.isFinite(p.amount))) {
    return NextResponse.json({ error: 'Each posting needs an accountId and a numeric amount' }, { status: 400 })
  }

  const vendorId = await vendorInFund(admin, gate.fundId, body.vendorId)
  const entry: JournalEntry = { fundId: gate.fundId, entryDate, memo: memo ?? null, sourceType: sourceType ?? 'manual', sourceRef: sourceRef ?? null, reference, adjusting: body.adjusting === true, vendorId, postings: normalized }
  const result = await persistEntry(admin, gate.fundId, group, user.id, entry, status === 'posted' ? 'posted' : 'draft')
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 })

  const { data: full } = await admin.from('journal_entries' as any).select('*, journal_postings(*)').eq('book', ACTUAL_BOOK).eq('id', result.entryId).single()
  return NextResponse.json(full ?? { id: result.entryId })
}

// PATCH — change an entry's state:
//   post   → a draft becomes posted (it hits the ledger)
//   unpost → back to draft so it can be edited and re-posted
//   void   → from POSTED, reverse its effect on the ledger (audit-safe correction);
//            from DRAFT, discard it — the only way to get rid of a draft, which until now
//            was a one-way door you could only edit or post. The bank page has always done
//            this to drafts via its Ignore action; the journal simply couldn't reach it.
// All are refused if the entry falls in a closed period (reopen it first).
export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const group = await resolveGroupOr400(admin, gate, body?.group ?? req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)

  const { id, action } = body
  if (!id || !['post', 'unpost', 'void', 'reverse'].includes(action)) {
    return NextResponse.json({ error: "id and action ('post'|'unpost'|'void'|'reverse') are required" }, { status: 400 })
  }

  const { data: existing } = await admin
    .from('journal_entries' as any)
    .select('id, status, entry_date, memo, source_type, reference, reversed_by, adjusting, source_ref')
    .eq('book', ACTUAL_BOOK)
    .eq('id', id).eq('fund_id', gate.fundId).eq('vehicle_id', vehicleId)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'Entry not found' }, { status: 404 })

  const status = (existing as any).status
  // Void, unpost and reverse on an OWNED entry delete the transactions that own it (spec §1).
  const release = async () => releaseOwnership(admin, gate.fundId, existing as any)

  // reverse → a dated contra-entry (lib/accounting/reversal.ts). The original stays posted and
  // may sit in a CLOSED period — that is the case a reversal exists for — so the closed-period
  // check applies to the reversal's date, not the original's. Lands as a draft unless asked to
  // post, so the correction is seen before it hits the accounts.
  if (action === 'reverse') {
    const ex = existing as any
    if (status !== 'posted') {
      return NextResponse.json({ error: 'Only a posted entry can be reversed — a draft can be edited or discarded.' }, { status: 400 })
    }
    if (ex.reversed_by) {
      // A discarded reversal draft leaves the link behind; only a live reversal blocks a second one.
      const { data: prior } = await admin.from('journal_entries' as any).select('status').eq('book', ACTUAL_BOOK).eq('id', ex.reversed_by).maybeSingle()
      if (prior && (prior as any).status !== 'void') {
        return NextResponse.json({ error: 'That entry has already been reversed.' }, { status: 400 })
      }
    }
    const reverseDate: string | undefined = body.reverseDate
    const dateErr = reversalDateError(ex.entry_date, reverseDate)
    if (dateErr) return NextResponse.json({ error: dateErr }, { status: 400 })
    const closed = await closedPeriodRanges(admin, gate.fundId, group)
    if (dateInAnyClosedPeriod(closed, reverseDate!)) {
      return NextResponse.json({ error: 'The reversal date falls in a closed period — pick a date in an open one.' }, { status: 400 })
    }
    const { data: postingRows } = await admin
      .from('journal_postings' as any)
      .select('account_id, amount, currency, lp_entity_id')
      .eq('book', ACTUAL_BOOK).eq('journal_entry_id', id)
    const plan = await planRelease(admin, gate.fundId, ex)
    if ('error' in plan) return NextResponse.json({ error: plan.error }, { status: 400 })
    const reversal = reversalOf({
      id, fundId: gate.fundId, entryDate: ex.entry_date, memo: ex.memo, sourceType: ex.source_type, reference: ex.reference, adjusting: ex.adjusting === true,
      postings: ((postingRows as any[]) ?? []).map(p => ({ accountId: p.account_id, amount: Number(p.amount), currency: p.currency ?? 'USD', lpEntityId: p.lp_entity_id ?? null })),
    }, reverseDate!)
    const reversalStatus = body.post === true ? 'posted' : 'draft'
    const result = await persistEntry(admin, gate.fundId, group, user.id, reversal, reversalStatus)
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 })
    await admin.from('journal_entries' as any).update({ reversed_by: result.entryId }).eq('id', id).eq('fund_id', gate.fundId)
    // Only now, with the reversal on the books (owned as a pair while the transaction still
    // exists), delete the owners. A failed reversal above leaves everything as it was.
    const failed = await deleteOwners(admin, gate.fundId, ex, plan)
    return NextResponse.json({
      ok: true, reversalId: result.entryId, status: reversalStatus, reverseDate,
      removedTransactions: failed ? [] : plan.removed, unlinkedRegisterRows: failed ? [] : plan.unlinked,
      ...(failed ? { warning: `The reversal was created, but ${failed.error}` } : {}),
    })
  }
  if (action === 'post' && status !== 'draft') {
    return NextResponse.json({ error: 'Only a draft entry can be posted' }, { status: 400 })
  }
  if (action === 'unpost' && status !== 'posted') {
    return NextResponse.json({ error: 'Only a posted entry can be unposted' }, { status: 400 })
  }
  // Void takes a draft (discard) or a posted entry (reverse). Only an already-void entry
  // has nothing left to do.
  if (action === 'void' && status !== 'draft' && status !== 'posted') {
    return NextResponse.json({ error: 'That entry is already void' }, { status: 400 })
  }

  const closed = await closedPeriodRanges(admin, gate.fundId, group)
  if (dateInAnyClosedPeriod(closed, (existing as any).entry_date)) {
    return NextResponse.json({ error: 'That entry is in a closed period — reopen it first.' }, { status: 400 })
  }

  if (action === 'post') {
    // A derived investment entry that moves cash posts through its bank match, not from here —
    // otherwise the bank import's own draft for the same wire could be posted too.
    if ((await entriesAwaitingBankMatch(admin, gate.fundId, group, [id])).has(id)) {
      return NextResponse.json({ error: AWAITING_BANK_MATCH_REASON }, { status: 400 })
    }
    // postExistingEntryWithAllocation rolls its own failure back to draft. Reverting here as well
    // would undo ANOTHER request's post when this one merely lost the race to it.
    const allocated = await postExistingEntryWithAllocation(admin, gate.fundId, group, user.id, id)
    if ('error' in allocated) {
      return NextResponse.json({ error: `Entry was not posted: ${allocated.error}` }, { status: 400 })
    }
    // Keep any bank transaction that points at this entry in step.
    await admin.from('bank_transactions' as any).update({ status: 'reconciled' }).eq('journal_entry_id', id).eq('fund_id', gate.fundId)
    return NextResponse.json({ ok: true, status: 'posted' })
  }

  if (action === 'unpost') {
    const released = await release()
    if ('error' in released) return NextResponse.json({ error: released.error }, { status: 400 })
    const linked = await setGeneratedAllocationStatus(admin, gate.fundId, id, 'draft')
    if (linked.error) return NextResponse.json({ error: linked.error, removedTransactions: released.removed, unlinkedRegisterRows: released.unlinked }, { status: 400 })
    const { error } = await admin.from('journal_entries' as any).update({ status: 'draft', posted_at: null }).eq('id', id).eq('fund_id', gate.fundId)
    if (error) return failedAfterRelease(error, 'journal-unpost', released)
    // Keep any bank transaction that points at this entry in step.
    await admin.from('bank_transactions' as any).update({ status: 'drafted' }).eq('journal_entry_id', id).eq('fund_id', gate.fundId)
    return NextResponse.json({ ok: true, status: 'draft', removedTransactions: released.removed, unlinkedRegisterRows: released.unlinked })
  }

  // `posted_at: null` matches what the bank page's Ignore writes, so an entry voided from
  // either surface looks identical afterwards.
  const released = await release()
  if ('error' in released) return NextResponse.json({ error: released.error }, { status: 400 })
  const linked = await setGeneratedAllocationStatus(admin, gate.fundId, id, 'void')
  if (linked.error) return NextResponse.json({ error: linked.error, removedTransactions: released.removed, unlinkedRegisterRows: released.unlinked }, { status: 400 })
  const { error } = await admin.from('journal_entries' as any).update({ status: 'void', posted_at: null }).eq('id', id).eq('fund_id', gate.fundId)
  if (error) return failedAfterRelease(error, 'journal-void', released)
  await admin.from('bank_transactions' as any).update({ status: 'ignored' }).eq('journal_entry_id', id).eq('fund_id', gate.fundId)
  return NextResponse.json({ ok: true, status: 'void', removedTransactions: released.removed, unlinkedRegisterRows: released.unlinked })
}
