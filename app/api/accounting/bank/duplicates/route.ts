import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { accountIdByCode, persistEntry } from '@/lib/accounting/persist'
import { bankEntryPostings, suggestCategory } from '@/lib/accounting/bank'
import { loadQuickBooksCashEntries, quickBooksCandidates, quickBooksClaimHash, quickBooksAlreadyClaimed } from '@/lib/accounting/bank-quickbooks-match'
import { vendorResolver } from '@/lib/accounting/vendors'
import { reviewKind } from '@/lib/accounting/bank-review'
import { loadOwnedCashEntries, ownedCandidates } from '@/lib/accounting/investment-bank-match'

// Resolve a held bank row without modifying the original QuickBooks entry.
export async function POST(req: NextRequest) {
  const auth = await createClient()
  const { data: { user } } = await auth.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const body = await req.json().catch(() => ({}))
  const group = await resolveGroupOr400(admin, gate, body.group)
  if (group instanceof NextResponse) return group
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  if (!vehicleId) return NextResponse.json({ error: 'Unknown vehicle' }, { status: 400 })
  if (!['link', 'separate'].includes(body.action)) return NextResponse.json({ error: 'Choose link or separate' }, { status: 400 })
  const { data: txn, error } = await admin.from('bank_transactions' as any).select('*')
    .eq('id', body.id).eq('fund_id', gate.fundId).eq('vehicle_id', vehicleId).maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const t = txn as any
  const kind = reviewKind(t?.raw)
  if (!t || t.status !== 'unmatched' || !kind || t.journal_entry_id) {
    return NextResponse.json({ error: 'This transaction is no longer awaiting review. Refresh the bank feed.' }, { status: 409 })
  }
  const codes = await accountIdByCode(admin, gate.fundId, group)
  const cashId = codes.get('1000')
  if (!cashId) return NextResponse.json({ error: 'Cash account is missing' }, { status: 400 })
  const row = { date: t.txn_date, amount: Number(t.amount), description: t.description ?? '', counterparty: t.counterparty }
  let entryId: string
  let draft = false
  let category: string | null = null
  if (body.action === 'link') {
    if (kind === 'investment') {
      let owned
      try { owned = await loadOwnedCashEntries(admin, gate.fundId, vehicleId, cashId, [row.date]) }
      catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
      const target = ownedCandidates(row, owned, new Set()).find(e => e.id === body.entryId)
      if (!target) return NextResponse.json({ error: 'Choose an investment entry with the same cash amount within seven days.' }, { status: 400 })
      entryId = target.id
    } else {
      let candidates
      try { candidates = quickBooksCandidates(row, await loadQuickBooksCashEntries(admin, gate.fundId, vehicleId, cashId, [row.date])) }
      catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
      const target = candidates.find(e => e.id === body.entryId)
      if (!target || target.status !== 'posted') {
        return NextResponse.json({ error: 'Choose a posted QuickBooks entry with the same cash amount within seven days. Post QuickBooks drafts from the Journal first.' }, { status: 400 })
      }
      const { data: claims, error: claimError } = await admin.from('bank_transactions' as any).select('id, journal_entry_id, raw')
        .eq('fund_id', gate.fundId).eq('vehicle_id', vehicleId).eq('journal_entry_id', target.id)
      if (claimError) return NextResponse.json({ error: claimError.message }, { status: 500 })
      if (quickBooksAlreadyClaimed(target, (claims as any[]) ?? [])) return NextResponse.json({ error: 'That QuickBooks cash movement is already linked to a bank transaction.' }, { status: 409 })
      entryId = target.id
    }
  } else {
    const cat = suggestCategory(row)
    category = cat.accountCode
    const result = await persistEntry(admin, gate.fundId, group, user.id, {
      fundId: gate.fundId, entryDate: row.date, memo: row.description || cat.label,
      sourceType: cat.sourceType, vendorId: await vendorResolver(admin, gate.fundId)(row.counterparty),
      postings: bankEntryPostings(row.amount, cashId, codes.get(cat.accountCode) ?? cashId),
    }, 'draft')
    if ('error' in result) return NextResponse.json(result, { status: 400 })
    entryId = result.entryId
    draft = true
  }
  const { data: updated, error: updateError } = await admin.from('bank_transactions' as any).update({
    journal_entry_id: entryId, status: draft ? 'drafted' : 'reconciled',
    dedup_hash: draft || kind === 'investment' ? t.dedup_hash : quickBooksClaimHash(entryId, row.amount),
    suggested_account_code: category,
    raw: {
      ...t.raw, bankImportHash: t.raw.bankImportHash ?? t.dedup_hash,
      quickbooksReview: kind === 'quickbooks' && !draft,
      investmentReview: kind === 'investment' && !draft,
      quickbooksCashAmount: kind === 'quickbooks' && !draft ? row.amount : null,
    },
  }).eq('id', t.id).eq('fund_id', gate.fundId).eq('vehicle_id', vehicleId)
    .eq('status', 'unmatched').is('journal_entry_id', null).select('id')
  if (updateError || !updated?.length) {
    if (draft) await admin.from('journal_entries' as any).delete().eq('id', entryId).eq('fund_id', gate.fundId).eq('status', 'draft')
    if (updateError && /duplicate|unique/i.test(updateError.message)) {
      return NextResponse.json({ error: 'That entry is already linked to another bank transaction.' }, { status: 409 })
    }
    return NextResponse.json({ error: updateError?.message ?? 'Transaction changed during review. Refresh and try again.' }, { status: 409 })
  }
  return NextResponse.json({ ok: true, status: draft ? 'drafted' : 'reconciled' })
}
