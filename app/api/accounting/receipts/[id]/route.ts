import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). The middleware has already checked the caller's
// grant for this route + method; authorizeReceipt then checks the receipt's own entity.
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName, vehicleNameById } from '@/lib/accounting/vehicle-id'
import {
  getReceipt, receiptFileUrl, matchCandidates, updateReceiptFields, attachReceipt, detachReceipt,
  setReceiptDismissed, deleteReceipt, draftEntryFromReceipt,
} from '@/lib/accounting/receipts'
import { authorizeReceipt } from '@/lib/accounting/receipt-access'
import { ACTUAL_BOOK } from '@/lib/accounting/books'

type Params = { params: Promise<{ id: string }> }

// GET — one receipt, a short-lived link to its file (?download=1 to save it), and its suggestions.
export async function GET(req: NextRequest, props: Params) {
  const { id } = await props.params
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const r = await getReceipt(admin, gate.fundId, id)
  if (!r) return NextResponse.json({ error: 'Receipt not found' }, { status: 404 })
  const ok = await authorizeReceipt(admin, gate, r)
  if (ok instanceof NextResponse) return ok

  const download = req.nextUrl.searchParams.get('download') === '1'
  const url = await receiptFileUrl(admin, r, download)
  if (req.nextUrl.searchParams.get('redirect') === '1') {
    if (!url) return NextResponse.json({ error: 'The file could not be opened.' }, { status: 500 })
    return NextResponse.redirect(url)
  }
  const suggestions = r.status === 'unmatched' ? await matchCandidates(admin, gate.fundId, r) : []
  return NextResponse.json({ receipt: r, url, suggestions })
}

/**
 * PATCH — act on a receipt.
 *   { action: 'update', vendorName?, receiptDate?, amount?, currency?, description?, group? }
 *       group moves it to another entity (one the caller may write to); a matched receipt is
 *       detached first, since its entry is on the old entity's books
 *   { action: 'attach', journalEntryId? | bankTransactionId? }
 *   { action: 'detach' }
 *   { action: 'dismiss' } / { action: 'restore' }
 *   { action: 'draft', creditAccountId, debitAccountId? | billToVehicleId?, memo? }
 *       draft the entry it describes on its entity's books and attach it. billToVehicleId makes it
 *       a partnership expense: the debit is that fund's Due-from account, not an expense
 */
export async function PATCH(req: NextRequest, props: Params) {
  const { id } = await props.params
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const r = await getReceipt(admin, gate.fundId, id)
  if (!r) return NextResponse.json({ error: 'Receipt not found' }, { status: 404 })
  const ok = await authorizeReceipt(admin, gate, r)
  if (ok instanceof NextResponse) return ok

  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? '')

  if (action === 'update') {
    const patch: Record<string, unknown> = {}
    for (const k of ['vendorName', 'receiptDate', 'amount', 'currency', 'description']) if (k in body) patch[k] = body[k]
    if (typeof body?.group === 'string' && body.group) {
      const target = await resolveGroupOr400(admin, gate, body.group)
      if (target instanceof NextResponse) return target
      const targetId = await vehicleIdByName(admin, gate.fundId, target)
      if (!targetId) return NextResponse.json({ error: `Unknown vehicle "${target}".` }, { status: 400 })
      if (targetId !== r.vehicle_id && (r.journal_entry_id || r.bank_transaction_id)) await detachReceipt(admin, gate.fundId, id)
      patch.vehicleId = targetId
    }
    const res = await updateReceiptFields(admin, gate.fundId, id, patch as any)
    if ('error' in res) return NextResponse.json({ error: res.error }, { status: 400 })
    return NextResponse.json({ receipt: res })
  }

  if (action === 'attach') {
    const journalEntryId = typeof body?.journalEntryId === 'string' ? body.journalEntryId : null
    const bankTransactionId = typeof body?.bankTransactionId === 'string' ? body.bankTransactionId : null
    // The target's entity has to be one this caller may write to, checked BEFORE anything moves:
    // an unassigned receipt would otherwise take the entity of whatever id it was pointed at.
    const { data: target } = journalEntryId
      ? await admin.from('journal_entries' as any).select('vehicle_id').eq('fund_id', gate.fundId).eq('book', ACTUAL_BOOK).eq('id', journalEntryId).maybeSingle()
      : bankTransactionId
        ? await admin.from('bank_transactions' as any).select('vehicle_id').eq('fund_id', gate.fundId).eq('id', bankTransactionId).maybeSingle()
        : { data: null }
    if (!target) return NextResponse.json({ error: 'Name an entry or a bank transaction in this fund to attach the receipt to.' }, { status: 400 })
    const allowed = await authorizeReceipt(admin, gate, { vehicle_id: (target as any).vehicle_id ?? null })
    if (allowed instanceof NextResponse) return allowed
    const res = await attachReceipt(admin, gate.fundId, id, { journalEntryId, bankTransactionId }, user.id)
    if ('error' in res) return NextResponse.json({ error: res.error }, { status: res.status ?? 400 })
    return NextResponse.json({ receipt: res })
  }

  if (action === 'detach') {
    const res = await detachReceipt(admin, gate.fundId, id)
    if ('error' in res) return NextResponse.json({ error: res.error }, { status: 400 })
    return NextResponse.json({ receipt: res })
  }

  if (action === 'dismiss' || action === 'restore') {
    const res = await setReceiptDismissed(admin, gate.fundId, id, action === 'dismiss')
    if ('error' in res) return NextResponse.json({ error: res.error }, { status: 400 })
    return NextResponse.json({ receipt: res })
  }

  if (action === 'draft') {
    if (!r.vehicle_id || !ok.group) return NextResponse.json({ error: 'Choose the entity this receipt belongs to first.' }, { status: 400 })
    const debitAccountId = typeof body?.debitAccountId === 'string' && body.debitAccountId ? body.debitAccountId : null
    const creditAccountId = String(body?.creditAccountId ?? '')
    const billToVehicleId = typeof body?.billToVehicleId === 'string' && body.billToVehicleId ? body.billToVehicleId : null
    if (!creditAccountId || !(debitAccountId || billToVehicleId)) {
      return NextResponse.json({ error: 'creditAccountId, and debitAccountId or billToVehicleId, are required' }, { status: 400 })
    }
    const billToName = billToVehicleId ? await vehicleNameById(admin, gate.fundId, billToVehicleId) : null
    if (billToVehicleId && !billToName) return NextResponse.json({ error: 'That entity is not in this fund.' }, { status: 400 })
    const res = await draftEntryFromReceipt(admin, gate.fundId, ok.group, r.vehicle_id, user.id, id, {
      debitAccountId, creditAccountId,
      billTo: billToVehicleId && billToName ? { vehicleId: billToVehicleId, name: billToName } : null,
      memo: typeof body?.memo === 'string' ? body.memo : null,
    })
    if ('error' in res) return NextResponse.json({ error: res.error }, { status: res.status ?? 400 })
    return NextResponse.json(res)
  }

  return NextResponse.json({ error: 'action must be update, attach, detach, dismiss, restore or draft' }, { status: 400 })
}

// DELETE — remove the receipt and its file.
export async function DELETE(_req: NextRequest, props: Params) {
  const { id } = await props.params
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const r = await getReceipt(admin, gate.fundId, id)
  if (!r) return NextResponse.json({ error: 'Receipt not found' }, { status: 404 })
  const ok = await authorizeReceipt(admin, gate, r)
  if (ok instanceof NextResponse) return ok
  const res = await deleteReceipt(admin, gate.fundId, id)
  if ('error' in res) return NextResponse.json({ error: res.error }, { status: 400 })
  return NextResponse.json({ ok: true })
}
