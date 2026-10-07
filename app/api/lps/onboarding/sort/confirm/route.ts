import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_relations domain (lib/access/route-domains.ts). The middleware has already checked the grant.
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { isOnboardingKind, ONBOARDING_KIND_LABEL, DOCUMENT_KINDS } from '@/lib/lp-onboarding'
import { canRecordTaxForms, parseTaxFormInput, recordTaxForm, type TaxFormInput } from '@/lib/lp-onboarding-tax'
import { scanFile } from '@/lib/security/scan-file'
import { logOnboardingEvent, attachItemDocument } from '@/lib/lp-onboarding-audit'
import { loadLpScope, lpVisible } from '@/lib/access/lp-scope'

/**
 * File what the reviewer confirmed from a sorted batch, and throw away what they discarded.
 *
 *   POST { rows: [{ storage_path, file_name, mime_type?, size_bytes?, lp_entity_id, kind, doc_date?, tax? }],
 *          discard: [storage_path] }
 *        → each row becomes an investor-scoped document (never text-indexed) and a verified
 *          onboarding item for that entity and kind, reviewed by the caller. A tax-form row may
 *          carry the form's facts (`tax`), recorded as the partner's tax form in the same step —
 *          only when the caller holds tax-reporting write; otherwise the row is filed and
 *          reported back under `taxSkipped`. Discarded uploads are deleted from storage. Nothing
 *          here trusts the body's scope: paths must be in this fund's folder and entities must be
 *          this fund's.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const fundId = gate.fundId
  const a = admin as any

  const body = await req.json().catch(() => ({}))
  const rows: any[] = Array.isArray(body.rows) ? body.rows : []
  const discard: string[] = Array.isArray(body.discard) ? body.discard.filter((p: unknown): p is string => typeof p === 'string') : []
  if (rows.length === 0 && discard.length === 0) return NextResponse.json({ error: 'Nothing to do' }, { status: 400 })

  const inFund = (p: unknown): p is string => typeof p === 'string' && p.startsWith(`${fundId}/`) && !p.includes('..')
  for (const p of discard) if (!inFund(p)) return NextResponse.json({ error: 'Invalid storage path' }, { status: 400 })
  for (const r of rows) {
    if (!inFund(r?.storage_path) || typeof r?.file_name !== 'string' || !r.file_name) return NextResponse.json({ error: 'Invalid storage path' }, { status: 400 })
    if (typeof r?.lp_entity_id !== 'string' || !r.lp_entity_id) return NextResponse.json({ error: `Pick an entity for ${r.file_name}` }, { status: 400 })
    if (!isOnboardingKind(r?.kind) || !DOCUMENT_KINDS.includes(r.kind)) return NextResponse.json({ error: `Pick a document kind for ${r.file_name}` }, { status: 400 })
  }

  // Tax facts are validated up front so a bad row (a full TIN) fails the batch before anything is filed.
  const taxByPath = new Map<string, TaxFormInput>()
  for (const r of rows) {
    if (r.kind !== 'tax_form' || r.tax == null) continue
    const parsed = parseTaxFormInput(r.tax)
    if (parsed && 'error' in parsed) return NextResponse.json({ error: `${r.file_name}: ${parsed.error}` }, { status: 400 })
    if (parsed) taxByPath.set(r.storage_path, parsed.input)
  }
  const canTax = taxByPath.size > 0 ? (await canRecordTaxForms(admin, fundId, user.id, gate.role)).can : false

  // Entities must be this fund's, and each row's entity needs its investor for the share.
  const entityIds = Array.from(new Set(rows.map(r => r.lp_entity_id as string)))
  // Filing only for LPs with a position in one of the caller's entities.
  const lp = await loadLpScope(admin, gate)
  if (entityIds.some(id => !lpVisible(lp.entityIds, id))) return NextResponse.json({ error: 'One or more entities are not in this fund' }, { status: 400 })
  const investorByEntity = new Map<string, { investorId: string; name: string }>()
  if (entityIds.length) {
    const { data: ents } = await a.from('lp_entities').select('id, investor_id, entity_name').eq('fund_id', fundId).in('id', entityIds)
    for (const e of (ents ?? []) as any[]) investorByEntity.set(e.id, { investorId: e.investor_id, name: e.entity_name })
    if (investorByEntity.size !== entityIds.length) return NextResponse.json({ error: 'One or more entities are not in this fund' }, { status: 400 })
  }

  const now = new Date().toISOString()
  const filed: { storage_path: string; documentId: string; itemId: string; taxFormId?: string }[] = []
  const taxSkipped: string[] = []
  for (const r of rows) {
    const ent = investorByEntity.get(r.lp_entity_id)!
    const title = `${ONBOARDING_KIND_LABEL[r.kind as keyof typeof ONBOARDING_KIND_LABEL]} — ${ent.name}`
    // The file is read once more here, because this is the write: a file that fails the scan is
    // deleted and the batch stops with its name.
    const { data: blob, error: dlErr } = await admin.storage.from('lp-documents').download(r.storage_path)
    if (dlErr || !blob) return NextResponse.json({ error: `${r.file_name}: the upload did not complete.` }, { status: 400 })
    const scan = scanFile(Buffer.from(await blob.arrayBuffer()), String(r.file_name), typeof r.mime_type === 'string' ? r.mime_type : '')
    if (!scan.safe) {
      await admin.storage.from('lp-documents').remove([r.storage_path])
      return NextResponse.json({ error: `${r.file_name} was rejected: ${scan.reason ?? 'it did not pass the safety check'}. It has been removed; the rest of the batch was not filed.` }, { status: 400 })
    }
    const docDate = typeof r.doc_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.doc_date) ? r.doc_date : null
    const { data: doc, error: docErr } = await a
      .from('lp_documents')
      .insert({
        fund_id: fundId, title, file_name: String(r.file_name).slice(0, 200), storage_path: r.storage_path,
        mime_type: typeof r.mime_type === 'string' ? r.mime_type : null, size_bytes: typeof r.size_bytes === 'number' ? r.size_bytes : null,
        scope: 'investor', category: 'Onboarding', doc_date: docDate, uploaded_by: user.id,
      })
      .select('id').single()
    if (docErr || !doc) return dbError(docErr ?? { message: 'Insert failed' }, 'onboarding-sort-confirm')
    await a.from('lp_document_shares').insert({ document_id: doc.id, lp_investor_id: ent.investorId, fund_id: fundId })

    // The fund filed it, so the fund has seen it: verified, by the caller, now. Except wire
    // instructions, which are verified by a callback, not by filing: those land as submitted.
    const filedStatus = r.kind === 'wire_instructions' ? 'submitted' : 'verified'
    const { data: item, error: itemErr } = await a
      .from('lp_onboarding_items')
      .upsert({
        fund_id: fundId, lp_entity_id: r.lp_entity_id, kind: r.kind, status: filedStatus, document_id: doc.id,
        submitted_by_account: null, submitted_at: now, reviewed_by: filedStatus === 'verified' ? user.id : null, reviewed_at: filedStatus === 'verified' ? now : null, note: null, updated_at: now,
      }, { onConflict: 'fund_id,lp_entity_id,kind' })
      .select('id').single()
    if (itemErr) return dbError(itemErr, 'onboarding-sort-confirm')
    await attachItemDocument(admin, { fundId, itemId: item.id, documentId: doc.id, addedByUser: user.id })
    await logOnboardingEvent(admin, { fundId, itemId: item.id, lpEntityId: r.lp_entity_id, kind: r.kind, action: 'filed', toStatus: filedStatus, documentId: doc.id, actorUserId: user.id })

    const tax = taxByPath.get(r.storage_path)
    let taxFormId: string | undefined
    if (tax) {
      if (!canTax) taxSkipped.push(r.file_name)
      else {
        const rec = await recordTaxForm(admin, { fundId, lpEntityId: r.lp_entity_id, documentId: doc.id, userId: user.id, input: tax })
        if ('error' in rec) return NextResponse.json({ error: `${r.file_name}: ${rec.error}` }, { status: 500 })
        taxFormId = rec.id
      }
    }
    filed.push({ storage_path: r.storage_path, documentId: doc.id, itemId: item.id, taxFormId })
  }

  if (discard.length) {
    const { error } = await admin.storage.from('lp-documents').remove(discard)
    if (error) console.warn('[onboarding-sort-confirm] discard failed:', error.message)
  }

  return NextResponse.json({ ok: true, filed, discarded: discard.length, taxRecorded: filed.filter(f => f.taxFormId).length, taxSkipped })
}
