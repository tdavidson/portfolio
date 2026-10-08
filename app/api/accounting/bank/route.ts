import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). The middleware has already checked the caller's
// grant for this route + method; these resolve identity and keep the demo out of writes.
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { accountIdByCode } from '@/lib/accounting/persist'
import { RECEIVABLE_CODE, DISTRIBUTION_PAYABLE_CODE } from '@/lib/accounting/chart'
import { loadEntityNames } from '@/lib/accounting/load'
import { closedPeriodRanges, dateInAnyClosedPeriod } from '@/lib/accounting/periods'
import { dbError } from '@/lib/api-error'
import { ACTUAL_BOOK } from '@/lib/accounting/books'
import { postExistingEntryWithAllocation, setGeneratedAllocationStatus } from '@/lib/accounting/continuous-allocation'
import { underReview, reviewKind } from '@/lib/accounting/bank-review'
import { loadOwnedCashEntries, ownedCandidates } from '@/lib/accounting/investment-bank-match'
import { entryCarriesInvestments, BANK_ROW_IS_AN_INVESTMENT } from '@/lib/accounting/ownership'
import { loadQuickBooksCashEntries, quickBooksCandidates, quickBooksAlreadyClaimed, readAll } from '@/lib/accounting/bank-quickbooks-match'

// GET — list a vehicle's staged bank transactions.
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

  const { data, error } = await admin
    .from('bank_transactions' as any)
    .select('id, txn_date, amount, description, counterparty, status, suggested_account_code, journal_entry_id, raw')
    .eq('fund_id', gate.fundId)
    .eq('vehicle_id', vehicleId)
    .order('txn_date', { ascending: false })
    .limit(1000)
  if (error) return dbError(error, 'bank-transactions')

  // What the row's ENTRY actually posts to, derived rather than remembered.
  //
  // `bank_transactions.suggested_account_code` is a denormalized copy written by the
  // categorizer and the booking paths. Editing the entry in the journal modal changes the
  // postings and never touches that column, so the bank page went on showing the old account —
  // an entry re-pointed to a partner still read "Partners' capital — LP (unallocated)". The
  // ledger is the truth; the column is only a hint for the categorizer.
  //
  // Also derived here: the partner a settlement belongs to (a row posting to 1300/2300 names an
  // obligation, not a person), and whether the entry SPLITS across several accounts — which is
  // why re-pointing it is refused.
  const rows = (data as any[]) ?? []
  // Rows held for a person: a possible QuickBooks duplicate, or one of several posted investment
  // entries (lib/accounting/bank-review.ts). Candidates are recomputed here rather than stored, so
  // they never go stale.
  const pending = rows.filter(r => r.status === 'unmatched' && underReview(r.raw))
  const duplicateCandidates = new Map<string, unknown[]>()
  if (pending.length && vehicleId) {
    try {
      const codes = await accountIdByCode(admin, gate.fundId, group)
      const cashId = codes.get('1000')
      const dates = pending.map(t => t.txn_date)
      const [qbEntries, ownedEntries, linked] = await Promise.all([
        cashId ? loadQuickBooksCashEntries(admin, gate.fundId, vehicleId, cashId, dates) : [],
        cashId ? loadOwnedCashEntries(admin, gate.fundId, vehicleId, cashId, dates) : [],
        readAll<any>((from, to) => admin.from('bank_transactions' as any).select('journal_entry_id, raw')
          .eq('fund_id', gate.fundId).eq('vehicle_id', vehicleId).not('journal_entry_id', 'is', null).order('id').range(from, to)),
      ])
      const linkedIds = new Set(linked.map(r => r.journal_entry_id as string))
      for (const t of pending) {
        const row = { date: t.txn_date, amount: Number(t.amount), description: t.description ?? '' }
        duplicateCandidates.set(t.id, reviewKind(t.raw) === 'investment'
          ? ownedCandidates(row, ownedEntries, new Set()).map(e => ({ ...e, claimed: linkedIds.has(e.id) }))
          : quickBooksCandidates(row, qbEntries).map(e => ({ ...e, claimed: quickBooksAlreadyClaimed(e, linked) })))
      }
    } catch (e) { return NextResponse.json({ error: `Could not check suggested matches: ${(e as Error).message}` }, { status: 500 }) }
  }
  const entryIds = Array.from(new Set(rows.map(r => r.journal_entry_id).filter(Boolean)))

  const partnerByEntry = new Map<string, string>()
  const acctByEntry = new Map<string, { code: string; name: string } | 'split'>()

  if (entryIds.length > 0) {
    const { data: chart } = await admin
      .from('chart_of_accounts' as any)
      .select('id, code, name')
      .eq('fund_id', gate.fundId).eq('vehicle_id', vehicleId)
    const acctById = new Map(((chart as any[]) ?? []).map(a => [a.id as string, { code: a.code as string, name: a.name as string }]))
    const codes = await accountIdByCode(admin, gate.fundId, group)
    const cashId = codes.get('1000')
    const settleIds = new Set([codes.get(RECEIVABLE_CODE), codes.get(DISTRIBUTION_PAYABLE_CODE)].filter(Boolean) as string[])

    const { data: postings } = await admin
      .from('journal_postings' as any)
      .select('journal_entry_id, account_id, lp_entity_id')
      .eq('book', ACTUAL_BOOK)
      .eq('fund_id', gate.fundId)
      .in('journal_entry_id', entryIds)

    const nonCashByEntry = new Map<string, Set<string>>()
    for (const p of ((postings as any[]) ?? [])) {
      if (p.lp_entity_id && settleIds.has(p.account_id)) partnerByEntry.set(p.journal_entry_id, p.lp_entity_id)
      if (p.account_id === cashId) continue
      const set = nonCashByEntry.get(p.journal_entry_id) ?? new Set<string>()
      set.add(p.account_id)
      nonCashByEntry.set(p.journal_entry_id, set)
    }
    for (const [entryId, accts] of Array.from(nonCashByEntry.entries())) {
      if (accts.size !== 1) { acctByEntry.set(entryId, 'split'); continue }
      const found = acctById.get(Array.from(accts)[0])
      if (found) acctByEntry.set(entryId, found)
    }
  }
  const names = partnerByEntry.size > 0 ? await loadEntityNames(admin, gate.fundId, group) : new Map<string, string>()

  return NextResponse.json(rows.map(r => {
    const lpEntityId = r.journal_entry_id ? partnerByEntry.get(r.journal_entry_id) ?? null : null
    const acct = r.journal_entry_id ? acctByEntry.get(r.journal_entry_id) : undefined
    const split = acct === 'split'
    return {
      ...r,
      raw: undefined,
      import_differences: r.raw?.importDifferences ?? [],
      quickbooks_linked: reviewKind(r.raw) === 'quickbooks' && !!r.journal_entry_id,
      investment_linked: reviewKind(r.raw) === 'investment' && !!r.journal_entry_id,
      review_kind: reviewKind(r.raw),
      duplicate_review: underReview(r.raw) && r.status === 'unmatched',
      duplicate_candidates: duplicateCandidates.get(r.id) ?? [],
      // What to SHOW. Falls back to the stored hint only when there is no entry to read.
      entry_account_code: split ? null : acct?.code ?? null,
      entry_account_name: split ? null : acct?.name ?? null,
      entry_is_split: split,
      settled_lp_entity_id: lpEntityId,
      settled_lp_name: lpEntityId ? names.get(lpEntityId) ?? null : null,
    }
  }))
}

// POST — act on a staged transaction.
// { action: 'post' | 'ignore' | 'setAccount' | 'unpost', id, accountCode?, group? }
// or bulk: { action: 'postMany', ids: string[], group? }
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const { action, id, ids, accountCode, group: bodyGroup } = await req.json().catch(() => ({}))
  const group = await resolveGroupOr400(admin, gate, bodyGroup ?? req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)

  /**
   * The entry-state guard the bank routes used to be missing.
   *
   * `unpost` and `restore` checked the closed period; `post`, `postMany` and `ignore` did
   * not, and none of them checked the entry's STATUS. So bank-posting a draft dated inside a
   * closed month injected P&L into locked books, and posting a transaction whose entry had
   * been voided (by `ignore`) resurrected that entry straight to `posted` — a transition the
   * journal route explicitly forbids.
   *
   * Returns an error string, or null when the transition is allowed.
   */
  const guardEntry = async (
    entryIds: string[],
    allowed: ('draft' | 'posted')[]
  ): Promise<string | null> => {
    if (entryIds.length === 0) return null
    const { data: entries } = await admin
      .from('journal_entries' as any)
      .select('id, status, entry_date')
      .eq('book', ACTUAL_BOOK)
      .eq('fund_id', gate.fundId)
      .in('id', entryIds)

    const closed = await closedPeriodRanges(admin, gate.fundId, group as string)
    for (const e of ((entries as any[]) ?? [])) {
      if (!allowed.includes(e.status)) {
        return e.status === 'void'
          ? 'That entry was voided. Restore the transaction to draft it again.'
          : `That entry is already ${e.status}.`
      }
      if (e.entry_date && dateInAnyClosedPeriod(closed, e.entry_date)) {
        return `That entry is dated ${e.entry_date}, inside a closed period — reopen it first.`
      }
    }
    return null
  }

  // Bulk post: flip a set of drafted transactions (and their draft entries) to
  // posted in one call.
  if (action === 'postMany') {
    const list = (Array.isArray(ids) ? ids : []).filter(Boolean)
    if (list.length === 0) return NextResponse.json({ error: 'ids (array) is required for postMany' }, { status: 400 })
    const { data: rows } = await admin
      .from('bank_transactions' as any)
      .select('id, journal_entry_id')
      .eq('fund_id', gate.fundId)
      .eq('vehicle_id', vehicleId)
      .in('id', list)
      .eq('status', 'drafted')
    const txnIds = ((rows as any[]) ?? []).map(r => r.id)
    const entryIds = ((rows as any[]) ?? []).map(r => r.journal_entry_id).filter(Boolean)

    const problem = await guardEntry(entryIds, ['draft'])
    if (problem) return NextResponse.json({ error: problem }, { status: 400 })

    // Posting a reversal draft deletes the transactions that owned the entry it reverses; say which,
    // and say when that part failed (the reversal still posted).
    const released = { removedTransactions: [] as unknown[], unlinkedRegisterRows: [] as string[], warnings: [] as string[] }
    if (entryIds.length) {
      for (const entryId of entryIds) {
        const result = await postExistingEntryWithAllocation(admin, gate.fundId, group, user.id, entryId)
        if ('error' in result) return NextResponse.json({ error: result.error, ...released }, { status: 400 })
        released.removedTransactions.push(...(result.removedTransactions ?? []))
        released.unlinkedRegisterRows.push(...(result.unlinkedRegisterRows ?? []))
        if (result.warning) released.warnings.push(result.warning)
      }
    }
    if (txnIds.length) await admin.from('bank_transactions' as any).update({ status: 'reconciled' }).in('id', txnIds).eq('fund_id', gate.fundId)
    return NextResponse.json({ ok: true, posted: txnIds.length, ...released })
  }

  if (!id || !['post', 'ignore', 'setAccount', 'unpost', 'restore'].includes(action)) {
    return NextResponse.json({ error: 'action (post|ignore|setAccount|unpost|restore) and id are required' }, { status: 400 })
  }

  const { data: txn } = await admin
    .from('bank_transactions' as any)
    .select('id, journal_entry_id, status, raw')
    .eq('id', id)
    .eq('fund_id', gate.fundId)
    .eq('vehicle_id', vehicleId)
    .maybeSingle()
  if (!txn) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  const entryId = (txn as any).journal_entry_id
  if (entryId && underReview((txn as any).raw)) {
    return NextResponse.json({ error: 'This bank row is linked to an existing journal entry. Manage that entry from the Journal.' }, { status: 400 })
  }

  // An entry investment transactions own (or half of a live reversal pair on investment accounts)
  // is not this page's to unpost, void, restore or re-point: there, acting on the entry is
  // deleting the transaction. Read once, only for the actions that would touch the entry.
  // Fails closed — a read that cannot tell is a refusal, not "not owned".
  let investment = false
  if (entryId && ['unpost', 'ignore', 'restore', 'setAccount'].includes(action)) {
    try {
      const { data: e, error: eErr } = await admin.from('journal_entries' as any).select('id, status, reversed_by, source_ref')
        .eq('book', ACTUAL_BOOK).eq('fund_id', gate.fundId).eq('id', entryId).maybeSingle()
      if (eErr) throw new Error(eErr.message)
      investment = !!e && !!vehicleId && await entryCarriesInvestments(admin, gate.fundId, vehicleId, e as any)
    } catch (e) {
      console.error('[bank-entry-ownership]', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Could not check whether this row is an investment payment, so nothing was changed. Try again.' }, { status: 500 })
    }
    if (investment && action !== 'ignore') return NextResponse.json({ error: BANK_ROW_IS_AN_INVESTMENT }, { status: 400 })
  }

  // Override the suggested account before posting: re-point the draft entry's
  // single non-cash posting to the chosen chart account.
  if (action === 'setAccount') {
    if ((txn as any).status !== 'drafted') return NextResponse.json({ error: 'Only a drafted transaction can be re-categorized' }, { status: 400 })
    const code = String(accountCode ?? '').trim()
    if (!code) return NextResponse.json({ error: 'accountCode is required' }, { status: 400 })
    const codes = await accountIdByCode(admin, gate.fundId, group)
    const newAccountId = codes.get(code)
    if (!newAccountId) return NextResponse.json({ error: 'Unknown account for this vehicle' }, { status: 400 })
    if (!entryId) return NextResponse.json({ error: 'No draft entry to update' }, { status: 400 })

    // The account CARRIES the partner: a per-LP capital account has its own lp_entity_id, and
    // the capital roll-forward only counts a posting when the posting AND the account both
    // have one (load.ts:107-126). Re-pointing account_id alone put the money on the partner's
    // account with a null tag — visible in the trial balance, invisible in that partner's
    // capital account, statement and the LP portal. Carry the tag across, and clear it when
    // moving to a general account so a stale partner can't linger on a re-categorized row.
    const { data: acct } = await admin
      .from('chart_of_accounts' as any)
      .select('lp_entity_id')
      .eq('id', newAccountId)
      .maybeSingle()
    const newLpEntityId = (acct as any)?.lp_entity_id ?? null

    const cashId = codes.get('1000')
    const { data: postings } = await admin
      .from('journal_postings' as any)
      .select('id, account_id')
      .eq('book', ACTUAL_BOOK)
      .eq('journal_entry_id', entryId)
    const nonCash = ((postings as any[]) ?? []).filter(p => p.account_id !== cashId)
    if (nonCash.length !== 1) return NextResponse.json({ error: 'This entry has a custom allocation — edit it in the Journal.' }, { status: 400 })

    await admin.from('journal_postings' as any)
      .update({ account_id: newAccountId, lp_entity_id: newLpEntityId })
      .eq('id', nonCash[0].id)
    await admin.from('bank_transactions' as any).update({ suggested_account_code: code }).eq('id', id).eq('fund_id', gate.fundId)
    return NextResponse.json({ ok: true, suggested_account_code: code })
  }

  if (action === 'post') {
    if ((txn as any).status !== 'drafted') {
      return NextResponse.json({ error: 'Only a drafted transaction can be posted.' }, { status: 400 })
    }
    if (entryId) {
      const problem = await guardEntry([entryId], ['draft'])
      if (problem) return NextResponse.json({ error: problem }, { status: 400 })

      const result = await postExistingEntryWithAllocation(admin, gate.fundId, group, user.id, entryId)
      if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 })
      await admin.from('bank_transactions' as any).update({ status: 'reconciled' }).eq('id', id).eq('fund_id', gate.fundId)
      return NextResponse.json({
        ok: true, status: 'reconciled',
        removedTransactions: result.removedTransactions ?? [], unlinkedRegisterRows: result.unlinkedRegisterRows ?? [],
        ...(result.warning ? { warning: result.warning } : {}),
      })
    }
    await admin.from('bank_transactions' as any).update({ status: 'reconciled' }).eq('id', id).eq('fund_id', gate.fundId)
    return NextResponse.json({ ok: true, status: 'reconciled' })
  }

  // Unpost: revert a posted transaction to draft so it can be edited, then
  // re-posted. Refused if the entry falls in a closed period (reopen it first).
  if (action === 'unpost') {
    if ((txn as any).status !== 'reconciled') return NextResponse.json({ error: 'Only a posted transaction can be unposted' }, { status: 400 })
    if (entryId) {
      const { data: entry } = await admin.from('journal_entries' as any).select('entry_date').eq('book', ACTUAL_BOOK).eq('id', entryId).eq('fund_id', gate.fundId).maybeSingle()
      const date = (entry as any)?.entry_date
      if (date) {
        const closed = await closedPeriodRanges(admin, gate.fundId, group)
        if (dateInAnyClosedPeriod(closed, date)) return NextResponse.json({ error: 'That entry is in a closed period — reopen it to edit.' }, { status: 400 })
      }
      const linked = await setGeneratedAllocationStatus(admin, gate.fundId, entryId, 'draft')
      if (linked.error) return NextResponse.json({ error: linked.error }, { status: 400 })
      const { error } = await admin.from('journal_entries' as any).update({ status: 'draft', posted_at: null }).eq('id', entryId).eq('fund_id', gate.fundId)
      if (error) return dbError(error, 'bank-unpost-entry')
    }
    await admin.from('bank_transactions' as any).update({ status: 'drafted' }).eq('id', id).eq('fund_id', gate.fundId)
    return NextResponse.json({ ok: true, status: 'drafted' })
  }

  // Restore: bring an ignored transaction back to draft (un-void its entry) so it
  // can be edited/posted again. Refused if the entry is in a closed period.
  if (action === 'restore') {
    if (underReview((txn as any).raw) && !entryId) {
      const { error } = await admin.from('bank_transactions' as any).update({ status: 'unmatched' }).eq('id', id).eq('fund_id', gate.fundId)
      if (error) return dbError(error, 'bank-restore-review')
      return NextResponse.json({ ok: true, status: 'unmatched' })
    }
    if ((txn as any).status !== 'ignored') return NextResponse.json({ error: 'Only an ignored transaction can be restored' }, { status: 400 })
    if (entryId) {
      const { data: entry } = await admin.from('journal_entries' as any).select('entry_date').eq('book', ACTUAL_BOOK).eq('id', entryId).eq('fund_id', gate.fundId).maybeSingle()
      const date = (entry as any)?.entry_date
      if (date) {
        const closed = await closedPeriodRanges(admin, gate.fundId, group)
        if (dateInAnyClosedPeriod(closed, date)) return NextResponse.json({ error: 'That entry is in a closed period — reopen it to edit.' }, { status: 400 })
      }
      const { error } = await admin.from('journal_entries' as any).update({ status: 'draft', posted_at: null }).eq('id', entryId).eq('fund_id', gate.fundId)
      if (error) return dbError(error, 'bank-restore-entry')
    }
    await admin.from('bank_transactions' as any).update({ status: 'drafted' }).eq('id', id).eq('fund_id', gate.fundId)
    return NextResponse.json({ ok: true, status: 'drafted' })
  }

  // Ignore. Voiding the entry is a real ledger change, so it gets the same guards as any
  // other: an already-ignored transaction has nothing to do, and an entry sitting inside a
  // closed period cannot be voided without reopening it — that used to silently change
  // already-closed financials.
  if ((txn as any).status === 'ignored') {
    return NextResponse.json({ error: 'That transaction is already ignored.' }, { status: 400 })
  }
  // An investment's entry stays exactly as it is: the bank row only lets go of it. Voiding it here
  // would leave the tracker carrying a position the books no longer do.
  if (entryId && investment) {
    const { error } = await admin.from('bank_transactions' as any).update({ status: 'ignored', journal_entry_id: null }).eq('id', id).eq('fund_id', gate.fundId)
    if (error) return dbError(error, 'bank-ignore-unlink')
    return NextResponse.json({ ok: true, status: 'ignored', note: 'The bank row was set aside. Its journal entry belongs to an investment transaction and was left as it is.' })
  }
  if (entryId) {
    const problem = await guardEntry([entryId], ['draft', 'posted'])
    if (problem) return NextResponse.json({ error: problem }, { status: 400 })

    const linked = await setGeneratedAllocationStatus(admin, gate.fundId, entryId, 'void')
    if (linked.error) return NextResponse.json({ error: linked.error }, { status: 400 })
    const { error } = await admin.from('journal_entries' as any).update({ status: 'void', posted_at: null }).eq('id', entryId).eq('fund_id', gate.fundId)
    if (error) return dbError(error, 'bank-ignore-entry')
  }
  await admin.from('bank_transactions' as any).update({ status: 'ignored' }).eq('id', id).eq('fund_id', gate.fundId)
  return NextResponse.json({ ok: true, status: 'ignored' })
}
