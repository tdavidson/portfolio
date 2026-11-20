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
import { fundCurrency } from '@/lib/accounting/currency'
import { resolvePeriod, customPeriod, type PeriodPreset } from '@/lib/accounting/statement-period'
import type { JournalEntry, Posting } from '@/lib/accounting/types'
import { vendorInFund } from '@/lib/accounting/vendors'
import { ACTUAL_BOOK, isLedgerBook, type LedgerBook } from '@/lib/accounting/books'
import { owningTransactions } from '@/lib/accounting/ownership'
import { changeEntryState } from '@/lib/accounting/journal-state'
import { editDraftEntry } from '@/lib/accounting/journal-edit'
import { loadMayTouchInvestments, NEEDS_INVESTMENTS_WRITE } from '@/lib/accounting/investment-access'
import { loadGateAccess } from '@/lib/access/request-context'
import { isProposer, markProposed, proposerChangeProblem, PROPOSER_REFUSAL } from '@/lib/accounting/proposals'

// The postings are stamped in the fund's currency; when it cannot be read, nothing is written.
function currencyUnread(e: unknown) {
  console.error('[accounting-journal-currency]', e instanceof Error ? e.message : e)
  return NextResponse.json({ error: "The fund's currency could not be read, so nothing was saved. Try again." }, { status: 500 })
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
    // Display only: an unreadable list degrades to none (void/unpost/reverse re-read and refuse).
    let ownedBy: Awaited<ReturnType<typeof owningTransactions>> = []
    try {
      ownedBy = await owningTransactions(admin, gate.fundId, data as any)
    } catch (e) {
      console.error('[accounting-journal-owned-by]', e instanceof Error ? e.message : e)
    }
    return NextResponse.json({ ...(data as object), owned_by: ownedBy })
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
  const page = (data ?? { entries: [], total: 0 }) as { entries?: { id: string }[]; total?: number }
  return NextResponse.json({ ...page, entries: await withProposers(admin, gate.fundId, book, page.entries ?? []) })
}

/**
 * Who proposed each entry on the page (proposed_by, and their email for the journal's badge). The
 * search RPC predates proposals, so they are read beside it. Display only: if the read fails the
 * page still lists, with no badges.
 */
async function withProposers<T extends { id: string }>(admin: ReturnType<typeof createAdminClient>, fundId: string, book: LedgerBook, entries: T[]) {
  if (entries.length === 0) return entries
  const { data, error } = await (admin as any)
    .from('journal_entries').select('id, proposed_by').eq('fund_id', fundId).eq('book', book)
    .in('id', entries.map(e => e.id)).not('proposed_by', 'is', null)
  if (error || !data?.length) return entries
  const byId = new Map<string, string>((data as { id: string; proposed_by: string }[]).map(r => [r.id, r.proposed_by]))
  const emails = new Map<string, string | null>()
  await Promise.all([...new Set(byId.values())].map(async uid => {
    const { data: u } = await admin.auth.admin.getUserById(uid)
    emails.set(uid, u?.user?.email ?? null)
  }))
  return entries.map(e => {
    const uid = byId.get(e.id)
    return uid ? { ...e, proposed_by: uid, proposed_by_email: emails.get(uid) ?? null } : e
  })
}

// PUT — replace a DRAFT entry's postings (and date/memo). Posted entries are
// immutable; reverse or void them instead. The edit itself is lib/accounting/journal-edit.ts,
// shared with the edit_draft_entry tool.
export async function PUT(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const group = await resolveGroupOr400(admin, gate, body?.group ?? req.nextUrl.searchParams.get('group'), { proposals: true })
  if (group instanceof NextResponse) return group
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)

  const out = await editDraftEntry(admin, {
    fundId: gate.fundId, userId: user.id,
    proposing: isProposer(await loadGateAccess(admin, gate), vehicleId),
    mayTouchInvestments: () => loadMayTouchInvestments(admin, gate, user.id),
  }, group, vehicleId, body)
  return NextResponse.json(out.body, { status: out.status })
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
  const group = await resolveGroupOr400(admin, gate, body?.group ?? req.nextUrl.searchParams.get('group'), { proposals: true })
  if (group instanceof NextResponse) return group

  const { entryDate, memo, sourceType, sourceRef, status, postings } = body
  if (!entryDate || !Array.isArray(postings) || postings.length === 0) {
    return NextResponse.json({ error: 'entryDate and at least one posting are required' }, { status: 400 })
  }
  const reference = typeof body.reference === 'string' && body.reference.trim() ? body.reference.trim().slice(0, 80) : null
  // The fund's currency, never a client-supplied one. The ledger is denominated in a single
  // currency by design (see lib/accounting/currency.ts); accepting `p.currency` from the body
  // would let a posting balance against the wrong denomination.
  let currency: string
  try { currency = await fundCurrency(admin, gate.fundId) } catch (e) { return currencyUnread(e) }
  const normalized: Posting[] = postings.map((p: any) => ({ accountId: p.accountId, amount: Number(p.amount), currency, lpEntityId: p.lpEntityId ?? null }))
  if (normalized.some(p => !p.accountId || !Number.isFinite(p.amount))) {
    return NextResponse.json({ error: 'Each posting needs an accountId and a numeric amount' }, { status: 400 })
  }

  const vendorId = await vendorInFund(admin, gate.fundId, body.vendorId)
  const entry: JournalEntry = { fundId: gate.fundId, entryDate, memo: memo ?? null, sourceType: sourceType ?? 'manual', sourceRef: sourceRef ?? null, reference, adjusting: body.adjusting === true, vendorId, postings: normalized }
  // A proposer's entry is always a draft, marked as their proposal, whatever status they asked for.
  // Their accounting level, lowered to their level in this entity (fund_member_vehicles.level).
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  const proposing = isProposer(await loadGateAccess(admin, gate), vehicleId)
  const finalStatus = !proposing && status === 'posted' ? 'posted' : 'draft'
  // Posting adopts any investment lines as transactions — refused without investments write.
  const adoptOpts = finalStatus === 'posted' ? { investments: await loadMayTouchInvestments(admin, gate, user.id) } : {}
  const result = await persistEntry(admin, gate.fundId, group, user.id, entry, finalStatus, ACTUAL_BOOK, true, adoptOpts)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.error === NEEDS_INVESTMENTS_WRITE ? 403 : 400 })
  if (proposing) {
    const marked = await markProposed(admin, { fundId: gate.fundId, vehicleId, entryId: result.entryId, userId: user.id })
    if (marked) return NextResponse.json({ error: marked.error, id: result.entryId }, { status: 500 })
  }

  const { data: full } = await admin.from('journal_entries' as any).select('*, journal_postings(*)').eq('book', ACTUAL_BOOK).eq('id', result.entryId).single()
  return NextResponse.json({ ...((full ?? { id: result.entryId }) as object), ...(proposing ? { proposed: true } : {}) })
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
  const group = await resolveGroupOr400(admin, gate, body?.group ?? req.nextUrl.searchParams.get('group'), { proposals: true })
  if (group instanceof NextResponse) return group
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)

  // A proposer may only withdraw (void) a draft they proposed. Posting, unposting and reversing
  // stay with write.
  if (isProposer(await loadGateAccess(admin, gate), vehicleId)) {
    if (body?.action !== 'void') return NextResponse.json({ error: PROPOSER_REFUSAL }, { status: 403 })
    const problem = await proposerChangeProblem(admin, { fundId: gate.fundId, entryId: String(body?.id ?? ''), userId: user.id })
    if (problem) return NextResponse.json({ error: problem }, { status: 403 })
  }

  // The state change itself is lib/accounting/journal-state.ts, shared with the unpost_entry,
  // reverse_entry and void_entry tools.
  const out = await changeEntryState(admin, {
    fundId: gate.fundId, role: gate.role, userId: user.id,
    mayTouchInvestments: () => loadMayTouchInvestments(admin, gate, user.id),
  }, group, vehicleId, body)
  return NextResponse.json(out.body, { status: out.status })
}
