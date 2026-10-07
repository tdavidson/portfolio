import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { rateLimit } from '@/lib/rate-limit'
import {
  compareLegalName,
  currentForm,
  defaultExpiry,
  isTaxFormType,
  partnerFormStatus,
  type TaxFormRecord,
} from '@/lib/tax/forms'
import { loadLpScope, lpVisible } from '@/lib/access/lp-scope'

// Tax forms behind each partner's K-1 — W-9 for a US person, the W-8 series for everyone else.
//
// GP-side: the manager records the form they were sent, with the document. LP self-serve upload
// is a separate build (the portal is GP → LP only today), and this route is what it would write
// through when it arrives.

const CLASSIFICATIONS = [
  'individual', 'c_corp', 's_corp', 'partnership', 'trust_estate', 'llc',
  'disregarded_entity', 'exempt_organization', 'government', 'other',
]
const TIN_TYPES = ['ssn', 'ein', 'itin', 'foreign', 'none']

// GET — every partner's standing, so the gaps are visible before a K-1 run rather than during.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const asOf = req.nextUrl.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10)

  const [{ data: allEntities }, { data: forms, error }] = await Promise.all([
    admin.from('lp_entities' as any).select('id, entity_name, investor_id').eq('fund_id', gate.fundId),
    admin
      .from('lp_tax_forms' as any)
      .select('id, lp_entity_id, form_type, tin_type, tin_last4, legal_name, tax_classification, country, state, treaty_claimed, subject_to_backup_withholding, signed_date, expires_on, document_id, notes')
      .eq('fund_id', gate.fundId),
  ])
  if (error) return dbError(error, 'tax-forms')
  // Only LPs with a position in one of the caller's entities.
  const lp = await loadLpScope(admin, gate)
  const entities = ((allEntities as any[]) ?? []).filter(e => lpVisible(lp.entityIds, e.id))

  const byEntity = new Map<string, any[]>()
  for (const f of ((forms as any[]) ?? [])) {
    const list = byEntity.get(f.lp_entity_id) ?? []
    list.push(f)
    byEntity.set(f.lp_entity_id, list)
  }

  const partners = ((entities as any[]) ?? []).map(e => {
    const rows = byEntity.get(e.id) ?? []
    const records: TaxFormRecord[] = rows.map(r => ({
      formType: r.form_type,
      signedDate: r.signed_date,
      expiresOn: r.expires_on,
      subjectToBackupWithholding: r.subject_to_backup_withholding,
    }))
    // The link between a form and a partner is an attachment someone made from a dropdown, and
    // the identifying number is deliberately not stored — so the legal name on the form is the
    // check that it landed on the right person. Reported, not enforced: an individual's form
    // legitimately carries their own name while the partner record carries their trust.
    const current = currentForm(rows.map((r, i) => ({
      formType: r.form_type,
      signedDate: r.signed_date,
      expiresOn: r.expires_on,
      legalName: r.legal_name as string | null,
      index: i,
    })))
    return {
      lpEntityId: e.id,
      name: e.entity_name,
      // The investor behind the partner, so a signed form uploaded from the tax page can be filed
      // as that investor's document rather than a fund-wide one every LP would see.
      investorId: (e.investor_id as string | null) ?? null,
      status: partnerFormStatus(e.id, records, asOf),
      nameMatch: compareLegalName(current?.legalName, e.entity_name),
      forms: rows,
    }
  })

  return NextResponse.json({
    asOf,
    partners,
    // The count a K-1 run has to clear. Surfaced here so the gap is answerable in one place
    // rather than discovered one partner at a time.
    blocked: partners.filter(p => p.status.blocker).length,
    // Forms whose name disagrees with the partner they are filed against. Not blockers — a
    // prompt to look before a K-1 goes out under the wrong certification.
    nameMismatches: partners.filter(p => p.nameMatch === 'differs').length,
  })
}

// POST — record a form. Supersedes rather than replaces: re-certification is a new row.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const limited = await rateLimit({ key: `tax-forms:${user.id}`, limit: 60, windowSeconds: 60 })
  if (limited) return limited

  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const lpEntityId = typeof body?.lpEntityId === 'string' ? body.lpEntityId : ''
  if (!lpEntityId) return NextResponse.json({ error: 'lpEntityId is required' }, { status: 400 })
  const writeScope = await loadLpScope(admin, gate)
  if (!lpVisible(writeScope.entityIds, lpEntityId)) return NextResponse.json({ error: 'Entity not found' }, { status: 404 })
  if (!isTaxFormType(body?.formType)) {
    return NextResponse.json({ error: 'formType must be one of w9, w8ben, w8bene, w8imy, w8eci' }, { status: 400 })
  }

  // The partner must belong to THIS fund. lp_entities is cross-fund, and the id arrives from a
  // request body — the same hole ensureCapitalAccounts closes on its own inputs.
  const { data: entity } = await admin
    .from('lp_entities' as any)
    .select('id')
    .eq('fund_id', gate.fundId)
    .eq('id', lpEntityId)
    .maybeSingle()
  if (!entity) return NextResponse.json({ error: 'Unknown partner for this fund' }, { status: 400 })

  const signedDate = typeof body?.signedDate === 'string' ? body.signedDate : null

  // REFUSE A FULL TIN rather than storing it. A caller sending one is trying to do something
  // this app deliberately does not do, and silently truncating it would leave them believing
  // the number is here. See the migration header.
  const rawTin = typeof body?.tin === 'string' ? body.tin.replace(/\D/g, '') : ''
  if (rawTin.length > 4) {
    return NextResponse.json(
      {
        error:
          'This app stores only the last four digits of a taxpayer identification number. The ' +
          'full number belongs in the signed form. Send `tinLast4` instead.',
      },
      { status: 400 },
    )
  }
  const tinLast4 = typeof body?.tinLast4 === 'string' ? body.tinLast4.replace(/\D/g, '') : ''
  if (tinLast4 && !/^\d{4}$/.test(tinLast4)) {
    return NextResponse.json({ error: 'tinLast4 must be exactly four digits' }, { status: 400 })
  }

  // THE DOCUMENT MUST BELONG TO THIS FUND. `documentId` arrives from a request body and was
  // being written verbatim — the same cross-tenant hole persistEntry closes on account and
  // partner ids. A foreign id here would attach another fund's document to this partner's tax
  // record, and the portal would then serve it.
  let documentId: string | null = null
  if (typeof body?.documentId === 'string' && body.documentId) {
    const { data: doc } = await admin
      .from('lp_documents' as any)
      .select('id')
      .eq('fund_id', gate.fundId)
      .eq('id', body.documentId)
      .maybeSingle()
    if (!doc) return NextResponse.json({ error: 'Unknown document for this fund' }, { status: 400 })
    documentId = body.documentId
  }

  const row = {
    fund_id: gate.fundId,
    lp_entity_id: lpEntityId,
    form_type: body.formType,
    tin_type: TIN_TYPES.includes(body?.tinType) ? body.tinType : null,
    tin_last4: tinLast4 || null,
    legal_name: typeof body?.legalName === 'string' ? body.legalName.slice(0, 300) : null,
    tax_classification: CLASSIFICATIONS.includes(body?.taxClassification) ? body.taxClassification : null,
    country: typeof body?.country === 'string' ? body.country.slice(0, 100) : null,
    // Two letters, upper-cased here so the state worklist can group on it without normalising.
    state: typeof body?.state === 'string' && /^[A-Za-z]{2}$/.test(body.state.trim())
      ? body.state.trim().toUpperCase()
      : null,
    treaty_claimed: !!body?.treatyClaimed,
    subject_to_backup_withholding: !!body?.subjectToBackupWithholding,
    signed_date: signedDate,
    // The caller's expiry wins when given; otherwise the default rule. A W-8BEN with a US TIN can
    // stand indefinitely, and only whoever read the form knows that.
    expires_on:
      typeof body?.expiresOn === 'string'
        ? body.expiresOn
        : defaultExpiry(body.formType, signedDate),
    document_id: documentId,
    notes: typeof body?.notes === 'string' ? body.notes.slice(0, 2000) : null,
    created_by: user.id,
  }

  const { data, error } = await admin.from('lp_tax_forms' as any).insert(row).select('*').single()
  if (error) return dbError(error, 'tax-forms-create')
  return NextResponse.json(data)
}
