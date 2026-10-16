import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). The middleware has already checked the caller's
// grant for this route + method; these resolve identity and keep the demo out of writes.
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { scanFileAsync } from '@/lib/security/scan-file'
import {
  listReceipts, storeReceipt, extractReceipt, matchCandidates, receiptsForEntry, attachReceipt,
  MAX_RECEIPT_BYTES,
} from '@/lib/accounting/receipts'
import { seesEveryEntity } from '@/lib/accounting/receipt-access'
import { ACTUAL_BOOK } from '@/lib/accounting/books'

const ALLOWED = /^(application\/pdf|image\/(png|jpe?g|heic|heif|webp|gif))$/i

/**
 * GET — the entity's receipts, with match suggestions for the unmatched ones.
 *   ?group=<entity>               receipts filed under it, plus the unassigned ones when the caller
 *                                 sees every entity (those could belong to any entity's books)
 *   &status=unmatched|matched|dismissed|all
 *   ?group=<entity>&entryId=<id>  the receipts supporting one entry
 */
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
  if (!vehicleId) return NextResponse.json({ error: `Unknown vehicle "${group}".` }, { status: 400 })

  const entryId = req.nextUrl.searchParams.get('entryId')
  if (entryId) {
    const { data: e } = await admin.from('journal_entries' as any).select('id').eq('fund_id', gate.fundId).eq('vehicle_id', vehicleId).eq('book', ACTUAL_BOOK).eq('id', entryId).maybeSingle()
    if (!e) return NextResponse.json({ receipts: [] })
    return NextResponse.json({ receipts: await receiptsForEntry(admin, gate.fundId, entryId) })
  }

  const statusParam = req.nextUrl.searchParams.get('status')
  const status = (['unmatched', 'matched', 'dismissed', 'all'] as const).find(s => s === statusParam)
  const includeUnassigned = await seesEveryEntity(admin, gate)
  const receipts = await listReceipts(admin, gate.fundId, { vehicleId, includeUnassigned, status })

  // Suggestions only where they can help: unmatched, filed here, with an amount to match on.
  const suggest = receipts.filter(r => r.status === 'unmatched' && r.vehicle_id === vehicleId && r.amount != null).slice(0, 40)
  const suggestions: Record<string, Awaited<ReturnType<typeof matchCandidates>>> = {}
  await Promise.all(suggest.map(async r => { suggestions[r.id] = await matchCandidates(admin, gate.fundId, r) }))

  return NextResponse.json({ vehicleId, receipts, suggestions })
}

/**
 * POST (multipart) — upload a receipt.
 *   file        the PDF or image
 *   group       the entity it belongs to
 *   entryId?    attach it to this entry straight away (the entry modal's "Add receipt")
 *   vendorName?, receiptDate?, amount?, description?   known fields; the rest are read from the file
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const form = await req.formData().catch(() => null)
  if (!form) return NextResponse.json({ error: 'Send the receipt as multipart form data.' }, { status: 400 })
  const group = await resolveGroupOr400(admin, gate, (form.get('group') as string | null) ?? req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  if (!vehicleId) return NextResponse.json({ error: `Unknown vehicle "${group}".` }, { status: 400 })

  const file = form.get('file')
  if (!file || typeof file === 'string') return NextResponse.json({ error: 'file is required' }, { status: 400 })
  const contentType = (file as File).type || 'application/octet-stream'
  if (!ALLOWED.test(contentType)) return NextResponse.json({ error: 'A receipt must be a PDF or an image.' }, { status: 400 })
  if ((file as File).size > MAX_RECEIPT_BYTES) return NextResponse.json({ error: 'A receipt can be at most 15 MB.' }, { status: 400 })
  const buffer = Buffer.from(await (file as File).arrayBuffer())
  const scan = await scanFileAsync(buffer, (file as File).name, contentType)
  if (!scan.safe) return NextResponse.json({ error: `The file failed the safety scan: ${scan.reason ?? 'unknown reason'}` }, { status: 400 })

  const str = (k: string) => { const v = form.get(k); return typeof v === 'string' && v.trim() ? v.trim() : null }
  const fields = { vendorName: str('vendorName'), receiptDate: str('receiptDate'), amount: str('amount') as any, description: str('description') }
  const row = await storeReceipt(admin, {
    fundId: gate.fundId, vehicleId, source: 'upload', fileName: (file as File).name || 'receipt',
    contentType, content: buffer, uploadedBy: user.id, fields,
  })
  if ('error' in row) return NextResponse.json({ error: row.error }, { status: 400 })

  // Read it unless the person typed the essentials themselves.
  if (row.extraction_status === 'pending') await extractReceipt(admin, gate.fundId, row.id, { content: buffer, contentType })

  const entryId = str('entryId')
  if (entryId) {
    const res = await attachReceipt(admin, gate.fundId, row.id, { journalEntryId: entryId }, user.id)
    if ('error' in res) return NextResponse.json({ error: res.error, receiptId: row.id }, { status: res.status ?? 400 })
    return NextResponse.json({ receipt: res })
  }
  const { data: fresh } = await admin.from('receipts' as any).select('*').eq('id', row.id).maybeSingle()
  return NextResponse.json({ receipt: fresh ?? row })
}
