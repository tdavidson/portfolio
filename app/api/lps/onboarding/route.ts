import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_relations domain (lib/access/route-domains.ts). The middleware has already checked the grant.
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import {
  buildOnboardingMatrix, normalizeKinds, isOnboardingKind, isOnboardingStatus, REVIEW_STATUSES,
  DEFAULT_ONBOARDING_KINDS, ONBOARDING_KINDS, ONBOARDING_KIND_LABEL, loadClosingsByEntity, sortByClosing,
  type OnboardingEntity, type OnboardingItemRow,
} from '@/lib/lp-onboarding'
import { canRecordTaxForms, parseTaxFormInput, recordTaxForm } from '@/lib/lp-onboarding-tax'
import { logOnboardingEvent, attachItemDocument, loadItemDocuments } from '@/lib/lp-onboarding-audit'
import { emailLpReview } from '@/lib/lp-onboarding-notify'
import { loadLpScope, lpVisible } from '@/lib/access/lp-scope'

/**
 * The fund's side of LP onboarding.
 *
 *   GET   → the checklist: every entity in the fund against the fund's required kinds, with each
 *           item's status, document and note; plus the requirement set and whether each entity's
 *           investor has a portal account (an entity with nobody to email cannot upload).
 *   PUT   { kinds: OnboardingKind[] } → set the fund's requirement set.
 *   PATCH { lp_entity_id, kind, status, note?, expires_on?, document_id?, tax? }
 *         → review an item: verify, reject (with a note the LP sees), waive, or put it back to
 *           outstanding. `document_id` attaches a file the fund uploaded on the LP's behalf
 *           (through /api/lps/documents, scoped to that investor) — it must belong to this fund.
 *           Verifying a tax form with `tax` records the partner's tax form in the same step, when
 *           the caller holds tax-reporting write; otherwise the response says it was not recorded.
 *
 * Reads through the service-role client with manual fund scoping, like every LP route.
 */

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const fundId = gate.fundId
  const a = admin as any

  const [{ data: fs }, { data: allEntities, error: entErr }, { data: allItems }, { data: links }] = await Promise.all([
    a.from('fund_settings').select('lp_onboarding_kinds, lp_portal_enabled').eq('fund_id', fundId).maybeSingle(),
    a.from('lp_entities').select('id, entity_name, investor_id, partner_class, onboarding_excluded, entity_type, formation_jurisdiction, address_line1, address_line2, city, region, postal_code, country, notice_email, signatories, profile_notes, profile_updated_at, lp_investors(name, contact_name, contact_email, contact_phone)').eq('fund_id', fundId).order('entity_name'),
    a.from('lp_onboarding_items').select('id, lp_entity_id, kind, status, document_id, submitted_at, reviewed_at, expires_on, note').eq('fund_id', fundId),
    a.from('lp_account_links').select('lp_investor_id, lp_accounts(status)').eq('fund_id', fundId),
  ])
  if (entErr) return dbError(entErr, 'lps-onboarding')
  // Only LPs with a position in one of the caller's entities.
  const lp = await loadLpScope(admin, gate)
  const entities = ((allEntities as any[]) ?? []).filter(e => lpVisible(lp.entityIds, e.id))
  const items = ((allItems as any[]) ?? []).filter(i => lpVisible(lp.entityIds, i.lp_entity_id))
  const profileById = new Map<string, { entity: Record<string, unknown>; investor: Record<string, unknown> }>()
  for (const e of (entities ?? []) as any[]) {
    profileById.set(e.id, {
      entity: {
        entity_type: e.entity_type ?? null, formation_jurisdiction: e.formation_jurisdiction ?? null, address_line1: e.address_line1 ?? null, address_line2: e.address_line2 ?? null,
        city: e.city ?? null, region: e.region ?? null, postal_code: e.postal_code ?? null, country: e.country ?? null, notice_email: e.notice_email ?? null,
        signatories: Array.isArray(e.signatories) ? e.signatories : [], profile_notes: e.profile_notes ?? null, profile_updated_at: e.profile_updated_at ?? null,
      },
      investor: { contact_name: e.lp_investors?.contact_name ?? null, contact_email: e.lp_investors?.contact_email ?? null, contact_phone: e.lp_investors?.contact_phone ?? null },
    })
  }

  const kinds = fs?.lp_onboarding_kinds == null ? DEFAULT_ONBOARDING_KINDS : normalizeKinds(fs.lp_onboarding_kinds)
  const closings = await loadClosingsByEntity(a, ((entities ?? []) as any[]).map(e => e.id), lp.scope.vehicleNames)
  const excludedEntities = ((entities ?? []) as any[]).filter(e => e.onboarding_excluded).map(e => ({
    id: e.id, name: e.entity_name, investorName: e.lp_investors?.name ?? '', partnerClass: e.partner_class ?? 'lp',
  }))
  const list: OnboardingEntity[] = ((entities ?? []) as any[]).filter(e => !e.onboarding_excluded).map(e => ({
    id: e.id, name: e.entity_name, investorId: e.investor_id, investorName: e.lp_investors?.name ?? '',
    closing: closings.get(e.id) ?? null, partnerClass: e.partner_class ?? 'lp',
  }))
  const rows = sortByClosing(buildOnboardingMatrix(list, kinds, (items ?? []) as OnboardingItemRow[]))

  // Which investors can actually be asked: one with an account that is invited or active.
  const accountByInvestor = new Map<string, string>()
  for (const l of (links ?? []) as any[]) {
    const st = l.lp_accounts?.status as string | undefined
    if (!st || st === 'disabled') continue
    const prev = accountByInvestor.get(l.lp_investor_id)
    if (prev !== 'active') accountByInvestor.set(l.lp_investor_id, st)
  }

  // Titles for the attached documents, for the review list, and every file on each item.
  const docIds = rows.flatMap(r => r.items.map(i => i.documentId)).filter((x): x is string => !!x)
  const titles = new Map<string, { title: string; file_name: string; mime_type: string | null }>()
  if (docIds.length) {
    const { data: docs } = await a.from('lp_documents').select('id, title, file_name, mime_type').in('id', docIds)
    for (const d of (docs ?? []) as any[]) titles.set(d.id, { title: d.title, file_name: d.file_name, mime_type: d.mime_type })
  }
  const docsByItem = await loadItemDocuments(admin, rows.flatMap(r => r.items.map(i => i.itemId)).filter((x): x is string => !!x))

  const { can: canRecordTax } = await canRecordTaxForms(admin, fundId, user.id, gate.role)

  return NextResponse.json({
    portalEnabled: !!fs?.lp_portal_enabled,
    canRecordTax,
    excluded: excludedEntities,
    kinds,
    allKinds: ONBOARDING_KINDS.map(k => ({ kind: k, label: ONBOARDING_KIND_LABEL[k] })),
    entities: rows.map(r => ({
      ...r,
      accountStatus: accountByInvestor.get(r.investorId) ?? null,
      profile: profileById.get(r.id) ?? null,
      items: r.items.map(i => ({
        ...i,
        document: i.documentId ? (titles.get(i.documentId) ?? null) : null,
        documents: i.itemId ? (docsByItem.get(i.itemId) ?? []) : [],
      })),
    })),
  })
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  if (!Array.isArray(body.kinds)) return NextResponse.json({ error: 'kinds must be a list' }, { status: 400 })
  const bad = body.kinds.filter((k: unknown) => !isOnboardingKind(k))
  if (bad.length) return NextResponse.json({ error: `Unknown kind: ${String(bad[0])}` }, { status: 400 })
  const kinds = normalizeKinds(body.kinds)

  const { error } = await (admin as any)
    .from('fund_settings')
    .upsert({ fund_id: gate.fundId, lp_onboarding_kinds: kinds }, { onConflict: 'fund_id' })
  if (error) return dbError(error, 'lps-onboarding')
  return NextResponse.json({ ok: true, kinds })
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const fundId = gate.fundId
  const a = admin as any

  const body = await req.json().catch(() => ({}))
  const entityId = typeof body.lp_entity_id === 'string' ? body.lp_entity_id : ''
  const kind = body.kind
  const status = body.status
  if (!entityId) return NextResponse.json({ error: 'lp_entity_id is required' }, { status: 400 })
  const patchScope = await loadLpScope(admin, gate)
  if (!lpVisible(patchScope.entityIds, entityId)) return NextResponse.json({ error: 'Entity not found' }, { status: 404 })
  if (!isOnboardingKind(kind)) return NextResponse.json({ error: 'Unknown kind' }, { status: 400 })
  if (!isOnboardingStatus(status) || !REVIEW_STATUSES.includes(status)) {
    return NextResponse.json({ error: `status must be one of ${REVIEW_STATUSES.join(', ')}` }, { status: 400 })
  }
  let note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : null
  // Wire instructions are paid against, so verifying them is a callback to a number the fund
  // already holds, not a look at the file. The callback is required and written into the note.
  if (kind === 'wire_instructions' && status === 'verified') {
    const cb = body.callback && typeof body.callback === 'object' ? body.callback as Record<string, unknown> : {}
    const contact = typeof cb.contact === 'string' ? cb.contact.trim().slice(0, 200) : ''
    const phone = typeof cb.phone === 'string' ? cb.phone.trim().slice(0, 60) : ''
    const spokeOn = typeof cb.spoke_on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cb.spoke_on) ? cb.spoke_on : ''
    if (!contact || !phone || !spokeOn) {
      return NextResponse.json({ error: 'Verifying wire instructions needs the callback: who you spoke to, the number you called, and the date.' }, { status: 400 })
    }
    note = `Callback verified: spoke with ${contact} at ${phone} on ${spokeOn}.${note ? ` ${note}` : ''}`.slice(0, 2000)
  }
  const expiresOn = typeof body.expires_on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.expires_on) ? body.expires_on : null
  if (status === 'rejected' && !note) return NextResponse.json({ error: 'Say why it was sent back — the LP sees the note.' }, { status: 400 })

  // The entity must be this fund's. Never trust the body's scope.
  const { data: entity } = await a.from('lp_entities').select('id, entity_name, investor_id').eq('id', entityId).eq('fund_id', fundId).maybeSingle()
  if (!entity) return NextResponse.json({ error: 'Entity not found in your fund' }, { status: 404 })
  const { data: prev } = await a.from('lp_onboarding_items').select('id, status').eq('fund_id', fundId).eq('lp_entity_id', entityId).eq('kind', kind).maybeSingle()

  // A document attached here was uploaded through /api/lps/documents; it must be this fund's too,
  // or an id from another fund would be filed against this partner.
  let documentId: string | null | undefined = undefined
  if (body.document_id === null) documentId = null
  else if (typeof body.document_id === 'string' && body.document_id) {
    const { data: doc } = await a.from('lp_documents').select('id').eq('id', body.document_id).eq('fund_id', fundId).maybeSingle()
    if (!doc) return NextResponse.json({ error: 'Document not found in your fund' }, { status: 404 })
    documentId = doc.id
  }

  const now = new Date().toISOString()
  const row: Record<string, unknown> = {
    fund_id: fundId, lp_entity_id: entityId, kind, status,
    note, expires_on: expiresOn,
    reviewed_by: user.id, reviewed_at: now, updated_at: now,
  }
  if (documentId !== undefined) row.document_id = documentId
  // Back to outstanding clears the review, not the file: the LP can see what they sent.
  if (status === 'outstanding') { row.reviewed_by = null; row.reviewed_at = null; row.expires_on = null }

  // A tax form's facts, validated before anything is written.
  const parsedTax = kind === 'tax_form' && status === 'verified' ? parseTaxFormInput(body.tax) : null
  if (parsedTax && 'error' in parsedTax) return NextResponse.json({ error: parsedTax.error }, { status: 400 })

  const { data: saved, error } = await a
    .from('lp_onboarding_items')
    .upsert(row, { onConflict: 'fund_id,lp_entity_id,kind' })
    .select('id, status, document_id, note, expires_on, reviewed_at')
    .single()
  if (error) return dbError(error, 'lps-onboarding')

  if (documentId) await attachItemDocument(admin, { fundId, itemId: saved.id, documentId, addedByUser: user.id })
  await logOnboardingEvent(admin, {
    fundId, itemId: saved.id, lpEntityId: entityId, kind,
    action: status === 'outstanding' ? 'reset' : status, fromStatus: prev?.status ?? 'outstanding', toStatus: status,
    note, documentId: documentId ?? null, actorUserId: user.id,
  })
  // A send-back is told to the LP, not left for them to discover.
  let lpEmailed: boolean | null = null
  if (status === 'rejected') {
    const r = await emailLpReview(admin, { fundId, lpInvestorId: entity.investor_id, lpEntityId: entityId, entityName: entity.entity_name, kind, note, sentBy: user.id })
    lpEmailed = r.sent
  }

  let taxFormId: string | null = null
  let taxSkipped = false
  if (parsedTax && 'input' in parsedTax) {
    const { can } = await canRecordTaxForms(admin, fundId, user.id, gate.role)
    if (!can) taxSkipped = true
    else {
      const rec = await recordTaxForm(admin, { fundId, lpEntityId: entityId, documentId: saved.document_id ?? null, userId: user.id, input: parsedTax.input })
      if ('error' in rec) return NextResponse.json({ error: rec.error }, { status: 500 })
      taxFormId = rec.id
    }
  }
  return NextResponse.json({ ok: true, item: saved, taxFormId, taxSkipped, lpEmailed })
}
